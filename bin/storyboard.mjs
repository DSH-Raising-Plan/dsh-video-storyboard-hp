#!/usr/bin/env node
/**
 * storyboard — CLI 薄壳，真正的逻辑全在 src/pipeline.js（与 DSH 工具同一份实现）。
 *
 *   node bin/storyboard.mjs <video> [--cells 9] [--sheets 1] [--from 0] [--to 300]
 *                                   [--pick sharp|mid|thumb] [--burn index|index+time|none]
 *                                   [--threshold auto|15] [--min-gap 1.2]
 *                                   [--transcript auto|off] [--no-adaptive] [--badge 0.15]
 *                                   [--out sheet.png] [--manifest m.json] [--plan 300] [--text]
 */
import { writeFile } from 'node:fs/promises';

import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/probe.js';
import { planWindows } from '../src/plan.js';
import { formatManifest, runStoryboard, saveStoryboards } from '../src/pipeline.js';

const opt = parse(process.argv.slice(2), {
  cells: 0, sheets: 0, from: 0, to: 0, threshold: 'auto', 'min-gap': 1.2,
  pick: 'sharp', burn: 'index', badge: 0.15, transcript: 'auto',
  out: 'storyboard.png', manifest: null, plan: 0,
});
const input = opt._[0];
if (!input) {
  console.error('usage: node bin/storyboard.mjs <video> [--cells 9] [--from 0] [--to 300] ...');
  process.exit(2);
}

const info = await probeVideo(input).catch((error) => {
  console.error(`探测失败：${error.message}`);
  process.exit(1);
});

// --plan：只算分段，不渲染
if (Number(opt.plan) > 0) {
  const p = planWindows(info.duration, Number(opt.plan));
  console.log(`[plan] ${info.duration.toFixed(0)}s → ${p.total} 段（每段 ≈${p.step.toFixed(0)}s），` +
    `预计 ${p.total} 张图 ≈ ${p.approxTokens} token` +
    `${p.stepAdjusted ? `  ⚠️ 段数超上限，已把每段从 ${p.requestedStep}s 拉长以保证覆盖全片` : ''}`);
  for (const w of p.windows) {
    console.log(`  ${String(w.index).padStart(2)}. ${w.from.toFixed(0).padStart(5)}–${w.to.toFixed(0).padStart(5)}s  ` +
      `(${w.duration.toFixed(0)}s)  ${w.cells} 格 ×${w.images}  ≈${w.approxTokens} tok`);
  }
  console.log('\n逐段跑：node bin/storyboard.mjs <video> --from A --to B');
  process.exit(0);
}

const adaptive = !process.argv.includes('--no-adaptive');
const t0 = Date.now();
const r = await runStoryboard({
  input,
  from: Number(opt.from) || 0,
  to: Number(opt.to) || 0,
  cells: Number(opt.cells) || 0,
  sheets: Number(opt.sheets) || 0,
  threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
  minGap: Number(opt['min-gap']) || 0,
  pick: String(opt.pick),
  burn: String(opt.burn),
  badgeRatio: Number(opt.badge) || 0.15,
  transcript: String(opt.transcript),
  adaptive,
});

console.log(`[probe] ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(2)}s` +
  `${info.hasAudio ? ' audio' : ''}${info.hasSubtitle ? ' subtitle' : ''}` +
  (r.window.from > 0 || r.window.to < info.duration
    ? `  window=${r.window.from.toFixed(1)}..${r.window.to.toFixed(1)}s` : ''));
console.log(`[scan] ${r.summary.frames} 帧 → ${r.cuts.length} 个切点（阈值 ${r.threshold}，` +
  `${r.plan.adaptive ? `自适应 ${r.plan.bursts.length} 个密集段` : '均匀分配'}）`);
console.log(`[plan] ${r.plan.cells} 格 × ${r.plan.sheets} 张 — ${r.plan.reason}`);
if (r.audio) console.log(`[audio] ${r.audio.summary}`);
if (r.transcript) {
  console.log(`[transcript] ${r.transcript.source}${r.transcript.model ? ` (${r.transcript.model})` : ''}` +
    `${r.transcript.segments ? `，${r.transcript.segments} 段` : ''}` +
    `${r.transcript.error ? `  ⚠️ ${r.transcript.error}` : ''}`);
}

const paths = await saveStoryboards(r, opt.out, { quality: 4 });
for (const [i, sheet] of r.sheets.entries()) {
  console.log(`[sheet] ${paths[i]}  ${sheet.width}x${sheet.height}  ${sheet.cols}x${sheet.rows}` +
    `  cell≈${sheet.cellW}x${sheet.cellH}${sheet.stripH ? `  strip=${sheet.stripH}px` : ''}`);
}
console.log(`[done] ${Date.now() - t0}ms`);

if (opt.manifest) {
  const payload = {
    input, window: r.window, threshold: r.threshold, summary: r.summary,
    audio: r.audio ? { mean: r.audio.mean, peak: r.audio.peak, silences: r.audio.silences } : null,
    transcript: r.transcript,
    plan: { cells: r.plan.cells, sheets: r.plan.sheets, adaptive: r.plan.adaptive, bursts: r.plan.bursts },
    sheets: r.sheets.map((s) => ({
      sheet: s.sheet, cols: s.cols, rows: s.rows, width: s.width, height: s.height,
      stripH: s.stripH ?? null, cells: s.cells,
    })),
  };
  await writeFile(opt.manifest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[manifest] ${opt.manifest}`);
}

if (opt.text) console.log(`\n${formatManifest(r)}`);
