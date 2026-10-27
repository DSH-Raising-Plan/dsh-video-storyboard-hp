/**
 * manifest.test.mjs — 文本侧的分页与预算。
 *
 * 起因（真实事故）：一部 2 小时 35 分的电影，64 个 cell 的清单约 75KB，宿主把 44% 折进磁盘溢出文件，
 * 模型没去读，等于中段 44 分钟的台词完全没给到。所以清单必须自己带预算、自己会分页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatManifest } from '../src/pipeline.js';

/** 造一个 64 格的 result（每格 300 字），不跑 ffmpeg */
function makeResult({ cells = 64, textLen = 300 } = {}) {
  const sheets = [1, 2, 3, 4].map((sheet) => {
    const cols = 4;
    const rows = 4;
    return {
      sheet, cols, rows, width: 1064, height: 600, stripH: 56,
      cells: Array.from({ length: 16 }, (_, k) => {
        const i = (sheet - 1) * 16 + k + 1;
        return {
          i, sheet,
          t_start: (i - 1) * 145,
          t_end: i * 145,
          t_frame: (i - 1) * 145 + 70,
          sharp: 1200,
          text: '这是一句很长的台词'.repeat(Math.ceil(textLen / 8)).slice(0, textLen),
        };
      }),
    };
  });
  return {
    info: { path: 'film.mkv', duration: 9300, fps: 23.976, aspect: 16 / 9 },
    window: { from: 0, to: 9300, duration: 9300 },
    cuts: [], summary: { frames: 0, p90: 0 }, threshold: 40, cached: false,
    audio: null,
    transcript: { source: 'subtitle', model: 'embedded', segments: 1782 },
    plan: { cells: 16, sheets: 4, adaptive: true, pick: 'sharp', burn: 'index', minGap: 120, reason: 'auto', bursts: [] },
    sheets: cells === 64 ? sheets : sheets.slice(0, Math.ceil(cells / 16)),
    totalDuration: 9300,
  };
}

test('默认预算：超长清单在 cell 边界截断，并给出续读指令', () => {
  const text = formatManifest(makeResult(), { maxChars: 4000 });
  assert.ok(text.length < 5000, `应被压在预算附近，实得 ${text.length}`);
  assert.match(text, /text stopped at cell \d+ of 64/);
  assert.match(text, /cellRange: \[\d+, 64\] and textOnly: true/);
  // 截断必须落在整格之间：最后一行要么是某格的头，要么是它的台词
  const body = text.split('\n').filter((l) => l.startsWith('cell '));
  assert.ok(body.length > 0);
  assert.ok(body.length < 64, '不该把 64 格全塞进去');
});

test('默认不截断时能把 64 格全列出来（预算足够）', () => {
  const text = formatManifest(makeResult(), { maxChars: 200_000 });
  assert.equal(text.split('\n').filter((l) => l.startsWith('cell ')).length, 64);
  assert.ok(!/text stopped/.test(text));
});

test('每格台词有字符上限，超出用省略号', () => {
  const text = formatManifest(makeResult({ textLen: 500 }), { maxChars: 200_000, maxCellChars: 40 });
  const quoted = text.split('\n').filter((l) => l.trim().startsWith('"'));
  assert.ok(quoted.length > 0);
  for (const line of quoted) {
    assert.ok(line.trim().length <= 44, `单格台词应 ≤ ~40 字符，实得 ${line.trim().length}`);
    assert.ok(line.trimEnd().endsWith('…"'), '超长时应带省略号');
  }
});

test('cellRange 只取一段，表头写明范围', () => {
  const text = formatManifest(makeResult(), { cellRange: [14, 42], maxChars: 200_000 });
  assert.match(text, /cells="14-42 of 64"/);
  const nums = text.split('\n').filter((l) => l.startsWith('cell '))
    .map((l) => Number(l.match(/^cell (\d+)/)[1]));
  assert.equal(nums[0], 14);
  assert.equal(nums.at(-1), 42);
  assert.equal(nums.length, 29);
});

test('cellRange 越界时被夹到有效范围', () => {
  const text = formatManifest(makeResult(), { cellRange: [60, 999], maxChars: 200_000 });
  assert.match(text, /cells="60-64 of 64"/);
});

test('textOnly 结果：没有图，但格与台词齐全', () => {
  const base = makeResult();
  const textOnly = {
    ...base, sheets: [], textOnly: true, audio: null,
    cells: base.sheets.flatMap((s) => s.cells.map((c) => ({
      i: c.i, t_start: c.t_start, t_end: c.t_end, text: c.text,
    }))),
  };
  const text = formatManifest(textOnly, { maxChars: 200_000 });
  assert.match(text, /image="none \(text only\)"/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('cell ')).length, 64);
  // 没有行列信息时不应编造 r/c
  assert.ok(!/\(r\d+c\d+, image/.test(text));
});
