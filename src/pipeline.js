/**
 * pipeline.js — 端到端编排：探测 → 切分 → 分段 → 取帧 → 拼图 → 清单。
 *
 * CLI（bin/storyboard.mjs）和 DSH 工具（index.js）都走这里，避免两份实现漂移。
 * 本模块只返回内存里的 PNG buffer 与结构化清单，落盘由调用方决定。
 */

import { probeVideo, DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { scanShots } from './scan.js';
import { fitSegments, segmentsFromCuts, totalDur } from './segments.js';
import { MAX_STRIP_ASPECT, bestLayout, groupByCount, suggest } from './plan.js';
import { findBursts, planCellRanges } from './density.js';
import { analyzeAudio, describeAudio, detectOnsets } from './audio.js';
import {
  ASR_DEFAULTS, alignCells, applyTermMap, describeAsrTarget, explainFetchError, extractSubtitleTrack,
  filterSuspectSegments, resolveAsrConfig, speechCurve, transcribeLong,
} from './asr.js';
import { cacheKey, pruneCache, withCache } from './cache.js';
import {
  addAudioStrip, composeSheet, encodeRaw, encodePngBuffer, extractFrameRaw, extractSharpest, layoutCanvas,
} from './sheet.js';

export const PICK_MODES = ['sharp', 'mid', 'thumb'];
export const BURN_MODES = ['index', 'index+time', 'none'];

/**
 * @param {object} opts
 * @param {string} opts.input 视频路径
 * @param {number} [opts.from] 窗口起点（秒）
 * @param {number} [opts.to] 窗口终点（秒）
 * @param {number} [opts.cells] 每张格数（0=自动）
 * @param {number} [opts.sheets] 张数（0=自动）
 * @param {number|'auto'} [opts.threshold]
 * @param {number} [opts.minGap] 采样最小间隔
 * @param {'sharp'|'mid'|'thumb'} [opts.pick]
 * @param {'index'|'index+time'|'none'} [opts.burn]
 * @param {number} [opts.badgeRatio]
 * @param {number} [opts.budget] 单图像素预算
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.ffprobePath]
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function runStoryboard(opts) {
  const {
    input,
    from = 0,
    to,
    threshold = 'auto',
    minGap = 1.2,
    adaptive = true,
    pick = 'sharp',
    burn = 'index',
    transcript = 'auto',
    audioStrip = true,
    asrMaxChunk = 45,
    cache = true,
    textOnly = false,
    layout = 'auto',
    precomputed = null,
    badgeRatio = 0.15,
    budget = 640_000,
    encode = true,
    ffmpegPath = DEFAULT_FFMPEG,
    ffprobePath = DEFAULT_FFPROBE,
    onProgress,
  } = opts;
  if (!input) throw new Error('input is required');
  if (!PICK_MODES.includes(pick)) throw new RangeError(`pick must be one of ${PICK_MODES.join('/')}`);
  if (!BURN_MODES.includes(burn)) throw new RangeError(`burn must be one of ${BURN_MODES.join('/')}`);

  const info = { ...(await probeVideo(input, { ffprobePath })), path: input };
  const winStart = Math.max(0, Math.min(Number(from) || 0, Math.max(0, info.duration - 0.2)));
  const winEnd = Math.min(info.duration, Number(to) > 0 ? Number(to) : info.duration);
  const winDur = Math.max(0.2, winEnd - winStart);

  // 扫描结果按 (文件, 窗口, 阈值策略) 缓存：storyboard 之后的 zoom 能直接复用
  const key = cache ? await cacheKey({ input, start: winStart, end: winStart + winDur, threshold }) : null;
  // precomputed：批量模式下全片已经扫过一次，窗口直接复用那份切点与摘要，
  // 不再为每个窗口重新解码一遍（2 小时的片子能省掉 24 次重复扫描）。
  const scan = precomputed
    ? {
      cuts: (precomputed.cuts ?? []).filter((c) => c.t >= winStart && c.t < winStart + winDur),
      summary: precomputed.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: precomputed.threshold ?? threshold,
      cached: false,
      reused: true,
    }
    : await withCache(key, () => scanShots({
      input, fps: info.fps, threshold, start: winStart, end: winStart + winDur,
      ffmpegPath, onProgress,
    }), { enabled: cache });
  if (cache && !scan.cached && !precomputed) await pruneCache();

  // ---- 音频测量（零模型：响度 + 静音）。先做，因为静音位置要用来切 ASR 请求。
  const needAudio = info.hasAudio && !textOnly && (audioStrip !== false || transcript !== 'off');
  const audio = needAudio
    ? await analyzeAudio({ input, ffmpegPath, start: winStart, end: winStart + winDur })
    : null;
  const stripAudio = audioStrip !== false ? audio : null;
  const silences = audio?.silences ?? [];
  // 声音事件：突然变响/突然安静。画面没动但事情发生的时刻，只能靠它抓到。
  // 口播片里"每句话的停顿"都会触发，所以**只用最突出的若干个**参与格位加权
  // （全部 90 多个事件铺上去等于把密度曲线压平），清单里也按强度排序展示。
  const allEvents = audio ? detectOnsets(audio) : [];

  // ---- 台词：字幕轨优先，其次 ASR；两者都没有就静默跳过（绝不让分镜失败）
  let transcriptInfo = null;
  if (transcript !== 'off' && info.hasAudio) {
    const subtitle = info.hasSubtitle
      ? await extractSubtitleTrack({ input, ffmpegPath })
      : null;
    if (subtitle) {
      transcriptInfo = { segments: subtitle, source: 'subtitle', model: 'embedded' };
    } else {
      try {
        // 切片调用：单次请求过长会让时间码整体压早（实测 299s 压早 13s）。
        // 结果按 (文件, 窗口, 后端, 切片长度) 缓存 —— 否则 textOnly 分页每翻一页都要重跑 ASR。
        const asrKey = await cacheKey({
          input, start: winStart, end: winStart + winDur,
          threshold: `asr|${ASR_DEFAULTS.baseUrl}|${ASR_DEFAULTS.model}|${asrMaxChunk}|${transcript}`,
        });
        const asr = await withCache(asrKey, () => transcribeLong({
          input, ffmpegPath, start: winStart, end: winStart + winDur,
          silences, maxChunk: asrMaxChunk,
        }), { enabled: cache });
        if (asr) {
          // 音乐段的幻觉句会命中多个格子、被复制好几遍，先过滤（结果里报出来，不静默丢）
          const { kept, dropped } = filterSuspectSegments(asr.segments);
          // 用户词典校正（确定性替换，替换次数会报出来）
          const { segments: fixed, replaced } = applyTermMap(kept, resolveAsrConfig().terms);
          transcriptInfo = {
            ...(replaced > 0 ? { termsFixed: replaced } : {}),
            ...asr,
            source: 'asr',
            segments: fixed,
            suspect: dropped.length,
            suspectDetail: dropped.slice(0, 3).map((d) => ({
              from: +d.from.toFixed(2), to: +d.to.toFixed(2),
              charsPerSec: d.charsPerSec, reason: d.reason,
            })),
          };
        }
      } catch (error) {
        transcriptInfo = {
          segments: [],
          source: 'asr-failed',
          // 把真实原因带出来 —— 只写 "ASR call failed" 会让每次故障都得重新猜
          error: `${explainFetchError(error).slice(0, 300)}  [${describeAsrTarget()}]`,
        };
      }
    }
  } else if (transcript !== 'off' && !info.hasAudio) {
    transcriptInfo = { segments: [], source: 'no-audio' };
  }
  const relSegments = (transcriptInfo?.segments ?? [])
    .map((seg) => ({ ...seg, from: seg.from - winStart, to: seg.to - winStart }))
    .filter((seg) => seg.to > 0 && seg.from < winDur);
  const speech = relSegments.length > 0
    ? speechCurve(relSegments, { duration: winDur })
    : null;

  // 声音事件只有在"话不密"的片子里才有信息量：
  // 口播片每句话的停顿都会触发（实测 299s 里 92 次），铺到密度曲线上等于把它压平。
  const speechRateForEvents = winDur > 0
    ? relSegments.reduce((n, seg) => n + seg.text.length, 0) / winDur : 0;
  const audioEvents = speechRateForEvents < 3
    ? [...allEvents]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 12)
      .sort((a, b) => a.t - b.t)
    : [];

  // ---- 格数：放在台词与音频之后，是为了让"口播多不多 / 是不是音乐驱动"参与决策
  let cells = Math.max(0, Number(opts.cells) || 0);
  let sheets = Math.max(0, Number(opts.sheets) || 0);
  let suggestion;
  if (cells === 0) {
    const speechChars = relSegments.reduce((n, seg) => n + seg.text.length, 0);
    const speechRate = winDur > 0 ? speechChars / winDur : 0;
    suggestion = suggest({
      duration: winDur,
      cuts: scan.cuts.length,
      motion: scan.summary.p90,
      aspect: info.aspect,
      speechRate,
      hasSubtitle: info.hasSubtitle,
      meanLufs: audio?.mean,
    });
    cells = suggestion.cells;
    sheets = sheets || suggestion.sheets;
  }
  sheets = sheets || 1;

  // 两条路：自适应按密度分配格位（快切区多给格），否则退回"并段到 k 格"
  const relCuts = scan.cuts.map((c) => c.t - winStart);
  let cellRanges;
  if (adaptive && relCuts.length > 0) {
    cellRanges = planCellRanges({
      duration: winDur, cuts: relCuts, cells: cells * sheets, speech, audioEvents,
    })
      .map((r) => ({ from: r.from + winStart, to: r.to + winStart, density: r.density }));
  } else {
    const segs = segmentsFromCuts(winDur, relCuts, 0.4, winStart);
    cellRanges = fitSegments(segs, cells * sheets, { minGap })
      .map(([a, b]) => ({ from: a, to: b, density: 1 }));
  }
  const groups = [];
  for (let i = 0; i < sheets; i++) groups.push(cellRanges.slice(i * cells, (i + 1) * cells));

  // textOnly：只重算"格 → 时间段 → 台词"，一帧都不解、一张图都不拼。
  // 用途：总览文本被宿主截断后，按 cellRange 分批把剩下的台词取回来（第二次调用命中缓存，几乎瞬时）。
  if (textOnly) {
    const cellsMeta = [];
    let n = 0;
    for (const group of groups) {
      const aligned = alignCells(group, transcriptInfo?.segments ?? []);
      group.forEach(({ from: a, to: b }, gi) => {
        n += 1;
        const t = aligned[gi] ?? null;
        cellsMeta.push({
          i: n,
          t_start: +a.toFixed(3),
          t_end: +b.toFixed(3),
          ...(t?.text ? { text: t.text, charsPerSec: t.charsPerSec } : {}),
        });
      });
    }
    return {
      info,
      window: { from: winStart, to: winStart + winDur, duration: winDur },
      cuts: scan.cuts,
      summary: scan.summary,
      threshold: scan.threshold,
      cached: Boolean(scan.cached),
      audio: null,
      transcript: transcriptInfo
        ? { source: transcriptInfo.source, model: transcriptInfo.model ?? null,
          segments: (transcriptInfo.segments ?? []).length }
        : null,
      plan: { cells, sheets, adaptive, pick, burn, minGap, reason: suggestion?.reason ?? 'explicit', bursts: [] },
      sheets: [],
      cells: cellsMeta,
      textOnly: true,
      totalDuration: +cellRanges.reduce((n2, r) => n2 + (r.to - r.from), 0).toFixed(3),
    };
  }

  const out = [];
  let index = 0;
  for (const [si, group] of groups.entries()) {
    if (group.length === 0) continue;
    // 长条（1×N）只在"短窗口"里用：宽高比一旦超过 12:1，很多视觉编码器会按最长边缩放，
    // 每格只剩一百多像素宽，反而不如宫格。超了就退回宫格并在清单里说明。
    const strip = layout === 'strip';
    const stripAspect = group.length * info.aspect;
    const useStrip = strip && stripAspect <= MAX_STRIP_ASPECT;
    const { cols, rows } = useStrip
      ? { cols: Math.max(1, group.length), rows: 1 }
      : bestLayout(Math.max(1, group.length), info.aspect);
    // 有音频带时先扣掉条带占用的预算：layoutCanvas 与 composeSheet 必须用**同一个** budget，
    // 否则取帧尺寸和拼图尺寸不一致，图会变成斜条纹（踩过）
    const cellBudget = stripAudio ? Math.round(budget * 0.9) : budget;
    const { width, height, cellW, cellH } = layoutCanvas(cols, rows, info.aspect, cellBudget);
    const aligned = alignCells(group, transcriptInfo?.segments ?? []);
    const frames = [];
    const cellMeta = [];
    for (const [gi, { from: a, to: b }] of group.entries()) {
      index += 1;
      const frame = pick === 'sharp'
        ? await extractSharpest({ input, at: a, dur: b - a, cellW, cellH, ffmpegPath })
        : await extractFrameRaw({
          input, at: a, dur: b - a, cellW, cellH, ffmpegPath,
          mode: pick === 'thumb' ? 'thumb' : 'mid',
        });
      frames.push({ buffer: frame.buffer, index });
      const text = aligned[gi] ?? null;
      // 这一格里切了几刀 —— 快闪蒙太奇的"速度"就是这个数字，模型不用自己数刻度
      const cellCuts = scan.cuts.filter((c) => c.t >= a && c.t < b).length;
      cellMeta.push({
        i: index,
        sheet: si + 1,
        t_start: +a.toFixed(3),
        t_end: +b.toFixed(3),
        t_frame: +frame.t.toFixed(3),
        ...(cellCuts > 0 ? { cuts: cellCuts } : {}),
        ...(frame.sharp !== undefined ? { sharp: +frame.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
      });
    }
    let sheet = composeSheet({
      frames, cols, rows, cellAspect: info.aspect, budget: cellBudget, burn, badgeRatio,
    });
    if (stripAudio) {
      // 条带高度按"宽的 5.5%"会在大长条上失控（2476px 宽 → 136px 高，占掉 37% 画面），
      // 所以同时受格高的 40% 约束。
      const stripH = Math.max(24, Math.min(Math.round(width * 0.055), Math.round(cellH * 0.28)));
      sheet = addAudioStrip(sheet, {
        loudness: stripAudio, silences: stripAudio.silences, cuts: scan.cuts.map((c) => c.t),
        window: { from: winStart, to: winStart + winDur }, stripH,
      });
    }
    out.push({
      sheet: si + 1, cols, rows, cellW, cellH,
      layout: useStrip ? 'strip' : 'grid',
      width: sheet.width, height: sheet.height, buffer: sheet.buffer, cells: cellMeta,
      ...(sheet.stripH ? { stripH: sheet.stripH } : {}),
      ...(encode ? { png: await encodePngBuffer(sheet.buffer, sheet.width, sheet.height, { ffmpegPath }) } : {}),
    });
  }

  const totalDuration = +cellRanges.reduce((n, r) => n + (r.to - r.from), 0).toFixed(3);
  return {
    info,
    window: { from: winStart, to: winStart + winDur, duration: winDur },
    cuts: scan.cuts,
    summary: scan.summary,
    threshold: scan.threshold,
    cached: Boolean(scan.cached),
    audio: stripAudio
      ? {
        ...stripAudio,
        events: allEvents,
        summary: describeAudio(stripAudio, winDur),
      }
      : null,
    transcript: transcriptInfo
      ? { source: transcriptInfo.source, model: transcriptInfo.model ?? null,
        segments: (transcriptInfo.segments ?? []).length,
        // 全片口径（不是"格内文本"口径）：字/秒是判定内容类型最稳的一个数字
        chars: (transcriptInfo.segments ?? []).reduce((n, seg) => n + String(seg.text ?? '').length, 0),
        charsPerSec: +(((transcriptInfo.segments ?? []).reduce((n, seg) => n + String(seg.text ?? '').length, 0))
          / Math.max(1, winDur)).toFixed(2),
        ...(transcriptInfo.chunks ? { chunks: transcriptInfo.chunks } : {}),
        ...(transcriptInfo.suspect ? {
          suspect: transcriptInfo.suspect, suspectDetail: transcriptInfo.suspectDetail,
        } : {}),
        ...(transcriptInfo.termsFixed ? { termsFixed: transcriptInfo.termsFixed } : {}),
        ...(transcriptInfo.error ? { error: transcriptInfo.error } : {}) }
      : null,
    plan: {
      cells, sheets, adaptive, pick, burn, minGap,
      reason: suggestion?.reason ?? 'explicit',
      bursts: findBursts(relCuts, winDur).map((b) => ({
        from: +(b.from + winStart).toFixed(2), to: +(b.to + winStart).toFixed(2), shots: b.shots,
      })),
    },
    sheets: out,
    totalDuration,
  };
}

/** 把结果编码成 PNG 落盘（CLI 用；插件走附件服务，不落盘） */
export async function saveStoryboards(result, outPath, { ffmpegPath = DEFAULT_FFMPEG, quality } = {}) {
  const paths = [];
  for (const s of result.sheets) {
    const path = result.sheets.length === 1
      ? outPath
      : outPath.replace(/\.png$/i, `-${s.sheet}.png`);
    await encodeRaw(s.buffer, s.width, s.height, path, { ffmpegPath, quality });
    paths.push(path);
  }
  return paths;
}

const tc = (t) => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};

/**
 * 给模型的文本块：可寻址的格位表。
 * 编号同时给"序号"和"行列"，任一读不出来还能靠另一个定位。
 */
/**
 * video_probe 的文本：容器信息 + 一个"该怎么读"的建议。
 * 不扫描、不取帧，只花 ffprobe 的时间（几毫秒）。
 */
export function formatProbe(info) {
  const mins = info.duration / 60;
  const lines = [
    `<video path="${info.path ?? ''}" duration="${info.duration.toFixed(2)}" ` +
      `size="${info.width}x${info.height}" fps="${info.fps.toFixed(2)}" ` +
      `aspect="${info.aspect.toFixed(3)}" rotation="${info.rotation}" ` +
      `video="${info.videoCodec}" container="${info.container}" ` +
      `audio="${info.hasAudio ? (info.audioCodec ?? 'yes') : 'no'}" ` +
      `subtitles="${info.hasSubtitle ? 'yes' : 'no'}" />`,
  ];
  // 两种读法，**明确标出哪种会剧透**。
  // 追剧情时不能先看全片总览：一张盖住片尾的图等于把结局摆在你脸上。
  // 短片不铺这些：一句话能说完的片子，给一条建议就够，别用通用模板灌水。
  if (mins > 20) {
    // 只看时长给个粗估（不调 suggest：probe 没扫描，cuts=0 会被当成"单镜头"，算出 4 格那种假结果）
    const estCells = Math.min(16, Math.max(4, Math.round(info.duration / 40)));
    const estSheets = Math.min(4, Math.ceil(info.duration / 300));
    lines.push(`one-shot overview would be about ${estCells} cells x ${estSheets} image(s) ` +
      '(duration-only estimate; cut density can change it).');
    lines.push('Two ways to read this, pick by what you need:');
    lines.push(`  • STRUCTURE (spoils the ending): one wide pass — ` +
      `video_storyboard({ input, cells: 16, sheets: 4 }) → whole film in 4 images, ` +
      `then open the 2-3 sections that look interesting. ~${(info.duration / 30).toFixed(0)} s of CPU.`);
    lines.push(`  • SEQUENCE (no spoilers, like watching it): ` +
      `video_storyboard({ input, from: 0, to: 300 }) then 300-600, 600-900 … one window at a time, ` +
      `never looking ahead. Each window is ~${Math.ceil(mins / 5)} calls in total; ` +
      'the scan of each window is cached, so re-reading a stretch is free.');
  } else if (mins < 1) {
    lines.push(`under a minute (${info.duration.toFixed(0)}s): one call is enough.`);
  } else {
    lines.push(`Short (${mins.toFixed(0)} min): one call is enough. Following a story rather than ` +
      'analysing structure? Use `from`/`to` windows so later scenes are not on screen early.');
  }
  if (!info.hasAudio) lines.push('no audio track: transcript will be empty, the grid is visual only.');
  else if (!info.hasSubtitle) lines.push('no subtitle track: transcript (if any) must come from ASR.');
  return lines.join('\n');
}

/**
 * 多窗口批处理的汇总表（Markdown）。
 *
 * 一部 2 小时半的电影按 5 分钟读 = 24 个窗口，人只需要看这一张表：
 * 它把 24 张图串成一条时间线。
 */
export function formatTimeline(rows, { title = 'batch timeline' } = {}) {
  const total = rows.reduce((n, r) => n + (r.to - r.from), 0);
  const totalCells = rows.reduce((n, r) => n + r.cells, 0);
  const totalChars = rows.reduce((n, r) => n + (r.chars ?? 0), 0);
  const lines = [
    `# ${title}`,
    '',
    `- windows: **${rows.length}** · total ${tc(total)} · cells ${totalCells} · transcript ${totalChars} chars`,
    `- tokens: ${rows.length} image(s) ≈ **${rows.length * 384}** (one image per window)`,
    '',
    '| # | window | cells | cuts | chars | image |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.index} | ${tc(r.from)}–${tc(r.to)} | ${r.cells} | ${r.cuts} | ${r.chars ?? 0} | \`${r.image}\` |`);
  }
  return lines.join('\n');
}

/**
 * 把结果渲染成给模型看的文本清单。
 *
 * **为什么要有预算**：一部 2 小时 35 分的电影，64 个 cell 的完整清单约 75KB。宿主对单次工具
 * 结果有上限，超出部分会被折进磁盘上的溢出文件，而模型往往不会去读它（实测发生过：44% 的文本
 * 被折叠，中段 44 分钟的台词等于没给）。所以这里做三件事：
 *
 *   1. 每格台词默认截到 `maxCellChars` 字符 —— 总览只需要"这一段在说什么"；
 *   2. 总量超过 `maxChars` 时**在 cell 边界**截断，并写明续读方式（不切断句子、不丢格）；
 *   3. `cellRange` 只取一段，配合 `textOnly` 二次调用可以零成本把剩下的台词取回来。
 *
 * @param {object} result runStoryboard 的返回值
 * @param {{maxCellChars?:number, maxChars?:number, cellRange?:[number,number]}} opts
 */
export function formatManifest(result, {
  maxCellChars = 120, maxChars = 24_000, cellRange = null,
} = {}) {
  const { info, window: win, plan } = result;
  const hasSheets = Boolean(result.sheets?.length);
  const sheet0 = result.sheets?.[0];

  // 统一成一条平坦的 cell 列表：有图时从 sheets 里取（带行列），textOnly 时从 cells 里取
  const all = [];
  if (hasSheets) {
    for (const sheet of result.sheets) {
      for (const c of sheet.cells) all.push({ ...c, cols: sheet.cols, sheet: sheet.sheet });
    }
  } else if (Array.isArray(result.cells)) {
    for (const c of result.cells) all.push(c);
  }
  const total = all.length;
  const [lo, hi] = Array.isArray(cellRange) && cellRange.length === 2
    ? [Math.max(1, cellRange[0]), Math.min(total, cellRange[1])]
    : [1, total];
  const picked = all.filter((c) => c.i >= lo && c.i <= hi);

  const lines = [
    `<storyboard path="${info.path ?? 'video'}" duration="${info.duration.toFixed(2)}" ` +
      `window="${win.from.toFixed(2)}-${win.to.toFixed(2)}" ` +
      `image="${hasSheets ? `${sheet0.width}x${sheet0.height}` : 'none (text only)'}" ` +
      `grid="${plan.cells} cells x ${plan.sheets} image(s)" burn="${plan.burn}"` +
      `${result.audio ? ` footer="audio-strip(${sheet0.stripH ?? 0}px)"` : ''}` +
      `${result.transcript?.source ? ` transcript="${result.transcript.source}"` : ''}` +
      (cellRange ? ` cells="${lo}-${hi} of ${total}"` : '') +
      (result.cuts?.length
        ? ` cuts="${result.cuts.length} (avg ${(result.window.duration / Math.max(1, result.cuts.length)).toFixed(1)}s)"`
        : '') + '>',
  ];
  if (result.audio) {
    lines.push('footer strip shares the timeline: teal bars = loudness (taller = louder), ' +
      'dark blocks = silence, yellow ticks = cut points.');
  }
  // 声音事件只写"稀疏"的片子：口播片几十次起伏会把真正重要的信息淹掉
  if (result.audio?.events?.length && result.audio.events.length <= 20) {
    const list = [...result.audio.events]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 6)
      .map((e) => `${tc(e.t)} ${e.kind === 'rise' ? '+' : ''}${e.delta}dB`).join(', ');
    lines.push(`audio events (${result.audio.events.length}): ${list}` +
      (result.audio.events.length > 6 ? ', …' : '') +
      ' — the picture may be static here; the change is in the sound.');
  }

  let used = lines.join('\n').length;
  let stoppedAt = null;
  for (const c of picked) {
    const pos = (c.i - 1) % plan.cells;
    // 单图时 "image 1" 是纯冗余（64 格能省 500 字符）；多图时必须保留
    const where = typeof c.cols === 'number'
      ? ` (r${Math.floor(pos / c.cols) + 1}c${(pos % c.cols) + 1}` +
        `${result.sheets.length > 1 ? `, image ${c.sheet}` : ''})`
      : '';
    let text = String(c.text ?? '');
    if (text.length > maxCellChars) text = `${text.slice(0, maxCellChars).trimEnd()}…`;
    // sharp 只留在 JSON 清单里：给模型一个 "479.7" 它无法判断好坏，纯占字符
    const head = `cell ${c.i}${where} = ${tc(c.t_start)}-${tc(c.t_end)}` +
      (c.cuts ? `  cuts ${c.cuts}` : '');
    const body = text ? `${head}\n    "${text}"` : head;
    if (used + body.length + 1 > maxChars) { stoppedAt = c.i - 1; break; }
    lines.push(body);
    used += body.length + 1;
  }

  if (stoppedAt !== null) {
    lines.push(`[text stopped at cell ${stoppedAt} of ${hi} — ` +
      `call again with cellRange: [${stoppedAt + 1}, ${hi}] and textOnly: true to read the rest]`);
  }
  if (result.transcript?.source === 'asr') {
    lines.push('transcript is ASR output (not a subtitle track): technical terms and names may be ' +
      'misheard — cross-check against on-screen text before quoting them.');
    if (result.transcript.termsFixed > 0) {
      lines.push(`${result.transcript.termsFixed} term(s) corrected by the local dictionary (DSH_ASR_TERMS / asr.json "terms")`);
    }
    if (result.transcript.suspect > 0) {
      const detail = (result.transcript.suspectDetail ?? [])
        .map((d) => `${d.from}-${d.to}s (${d.charsPerSec} chars/s, ${d.reason})`).join(', ');
      lines.push(`${result.transcript.suspect} segment(s) ignored as non-speech: ${detail}` +
        (result.transcript.suspect > 3 ? ', …' : ''));
    }
  }
  if (result.transcript?.source === 'asr-failed') {
    lines.push(`transcript unavailable: ${result.transcript.error ?? 'ASR call failed'}`);
  }
  if (result.transcript?.source === 'no-audio') lines.push('no audio track: grid is visual only');
  lines.push(`total ${picked.length} of ${total} cells shown` +
    (hasSheets ? '; unlabeled cells are padding, not content.' : '.'));
  lines.push('</storyboard>');
  return lines.join('\n');
}
