/**
 * pipeline.js — 端到端编排：探测 → 切分 → 分段 → 取帧 → 拼图 → 清单。
 *
 * CLI（bin/storyboard.mjs）和 DSH 工具（index.js）都走这里，避免两份实现漂移。
 * 本模块只返回内存里的 PNG buffer 与结构化清单，落盘由调用方决定。
 */

import { probeVideo, DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { scanShots } from './scan.js';
import { fitSegments, segmentsFromCuts, totalDur } from './segments.js';
import { bestLayout, groupByCount, suggest } from './plan.js';
import { findBursts, planCellRanges } from './density.js';
import { analyzeAudio, describeAudio } from './audio.js';
import {
  alignCells, describeAsrTarget, explainFetchError, extractSubtitleTrack, filterSuspectSegments,
  speechCurve, transcribeLong,
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
  const scan = await withCache(key, () => scanShots({
    input, fps: info.fps, threshold, start: winStart, end: winStart + winDur,
    ffmpegPath, onProgress,
  }), { enabled: cache });
  if (cache && !scan.cached) await pruneCache();

  let cells = Math.max(0, Number(opts.cells) || 0);
  let sheets = Math.max(0, Number(opts.sheets) || 0);
  let suggestion;
  if (cells === 0) {
    suggestion = suggest({
      duration: winDur, cuts: scan.cuts.length, motion: scan.summary.p90, aspect: info.aspect,
    });
    cells = suggestion.cells;
    sheets = sheets || suggestion.sheets;
  }
  sheets = sheets || 1;

  // ---- 音频测量（零模型：响度 + 静音）。先做，因为静音位置要用来切 ASR 请求。
  const needAudio = info.hasAudio && (audioStrip !== false || transcript !== 'off');
  const audio = needAudio
    ? await analyzeAudio({ input, ffmpegPath, start: winStart, end: winStart + winDur })
    : null;
  const stripAudio = audioStrip !== false ? audio : null;
  const silences = audio?.silences ?? [];

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
        // 切片调用：单次请求过长会让时间码整体压早（实测 299s 压早 13s）
        const asr = await transcribeLong({
          input, ffmpegPath, start: winStart, end: winStart + winDur,
          silences, maxChunk: asrMaxChunk,
        });
        if (asr) {
          // 音乐段的幻觉句会命中多个格子、被复制好几遍，先过滤（结果里报出来，不静默丢）
          const { kept, dropped } = filterSuspectSegments(asr.segments);
          transcriptInfo = {
            ...asr,
            source: 'asr',
            segments: kept,
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

  // 两条路：自适应按密度分配格位（快切区多给格），否则退回"并段到 k 格"
  const relCuts = scan.cuts.map((c) => c.t - winStart);
  let cellRanges;
  if (adaptive && relCuts.length > 0) {
    cellRanges = planCellRanges({ duration: winDur, cuts: relCuts, cells: cells * sheets, speech })
      .map((r) => ({ from: r.from + winStart, to: r.to + winStart, density: r.density }));
  } else {
    const segs = segmentsFromCuts(winDur, relCuts, 0.4, winStart);
    cellRanges = fitSegments(segs, cells * sheets, { minGap })
      .map(([a, b]) => ({ from: a, to: b, density: 1 }));
  }
  const groups = [];
  for (let i = 0; i < sheets; i++) groups.push(cellRanges.slice(i * cells, (i + 1) * cells));

  const out = [];
  let index = 0;
  for (const [si, group] of groups.entries()) {
    if (group.length === 0) continue;
    const { cols, rows } = bestLayout(Math.max(1, group.length), info.aspect);
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
      cellMeta.push({
        i: index,
        sheet: si + 1,
        t_start: +a.toFixed(3),
        t_end: +b.toFixed(3),
        t_frame: +frame.t.toFixed(3),
        ...(frame.sharp !== undefined ? { sharp: +frame.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
      });
    }
    let sheet = composeSheet({
      frames, cols, rows, cellAspect: info.aspect, budget: cellBudget, burn, badgeRatio,
    });
    if (stripAudio) {
      sheet = addAudioStrip(sheet, {
        loudness: stripAudio, silences: stripAudio.silences, cuts: scan.cuts.map((c) => c.t),
        window: { from: winStart, to: winStart + winDur },
      });
    }
    out.push({
      sheet: si + 1, cols, rows, cellW, cellH,
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
    audio: stripAudio ? { ...stripAudio, summary: describeAudio(stripAudio, winDur) } : null,
    transcript: transcriptInfo
      ? { source: transcriptInfo.source, model: transcriptInfo.model ?? null,
        segments: (transcriptInfo.segments ?? []).length,
        ...(transcriptInfo.chunks ? { chunks: transcriptInfo.chunks } : {}),
        ...(transcriptInfo.suspect ? {
          suspect: transcriptInfo.suspect, suspectDetail: transcriptInfo.suspectDetail,
        } : {}),
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
export function formatManifest(result, { maxTranscriptChars = 0 } = {}) {
  const { info, window: win, plan } = result;
  const sheet0 = result.sheets[0];
  const hasStrip = Boolean(result.audio);
  const lines = [
    `<storyboard path="${info.path ?? 'video'}" duration="${info.duration.toFixed(2)}" ` +
      `window="${win.from.toFixed(2)}-${win.to.toFixed(2)}" ` +
      `image="${sheet0?.width}x${sheet0?.height}" ` +
      `grid="${plan.cells} cells x ${result.sheets.length} image(s)" burn="${plan.burn}"` +
      `${hasStrip ? ` footer="audio-strip(${sheet0.stripH ?? 0}px)"` : ''}` +
      `${result.transcript?.source ? ` transcript="${result.transcript.source}"` : ''}>`,
  ];
  if (hasStrip) {
    lines.push('footer strip shares the timeline: teal bars = loudness (taller = louder), ' +
      'dark blocks = silence, yellow ticks = cut points.');
  }
  for (const sheet of result.sheets) {
    for (const c of sheet.cells) {
      const pos = (c.i - 1) % plan.cells;
      const r = Math.floor(pos / sheet.cols) + 1;
      const col = (pos % sheet.cols) + 1;
      const head = `cell ${c.i} (r${r}c${col}, image ${sheet.sheet}) = ` +
        `${tc(c.t_start)}-${tc(c.t_end)}  frame@${tc(c.t_frame)}` +
        (c.sharp !== undefined ? `  sharp ${c.sharp}` : '');
      lines.push(c.text ? `${head}\n    "${c.text}"` : head);
    }
  }
  if (result.audio?.summary) lines.push(`audio (measured): ${result.audio.summary}`);
  if (result.transcript?.source === 'asr') {
    lines.push('transcript is ASR output (not a subtitle track): technical terms and names may be ' +
      'misheard — cross-check against on-screen text before quoting them.');
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
  lines.push(`total ${result.sheets.reduce((n, sh) => n + sh.cells.length, 0)} cells; ` +
    'unlabeled cells are padding, not content.');
  lines.push('</storyboard>');
  const text = lines.join('\n');
  return maxTranscriptChars > 0 ? text.slice(0, maxTranscriptChars) : text;
}
