/**
 * manifest.test.mjs — 文本侧的分页与预算。
 *
 * 起因（真实事故）：一部 2 小时 35 分的电影，64 个 cell 的清单约 75KB，宿主把 44% 折进磁盘溢出文件，
 * 模型没去读，等于中段 44 分钟的台词完全没给到。所以清单必须自己带预算、自己会分页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DETAIL_CHARS, countTextInSilence, formatManifest, truncateAtSentence } from '../src/pipeline.js';

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

/* ---------------------------------------------------------------- 句末截断 */

test('truncateAtSentence: 不超限时原样返回', () => {
  assert.equal(truncateAtSentence('短句。', 60), '短句。');
});

test('truncateAtSentence: 在句末截断，不切半句', () => {
  const text = '第一句话在这里结束。第二句话稍微长一点也结束了。第三句话会被截掉。';
  // 上限 30：第二个句号在索引 23，落在 [15,29] 窗口内，应该正好在那里截
  const out = truncateAtSentence(text, 30);
  assert.ok(out.endsWith('…'), `应带省略号，实得 ${out}`);
  // 截断点必须在句号之后
  assert.match(out, /。…$/);
  assert.ok(out.length <= 30, `不该超过上限，实得 ${out.length}`);
});

test('truncateAtSentence: 没有标点时退回硬切', () => {
  const out = truncateAtSentence('一二三四五六七八九十一二三四五六七八九十', 10);
  assert.equal(out, '一二三四五六七八九…');
  assert.ok(out.length <= 10, '总长不该超过上限（省略号占一格）');
});

test('truncateAtSentence: 英文句号也认（但不能被小数点骗）', () => {
  assert.ok(truncateAtSentence('First sentence here. Second one follows and is long.', 24).endsWith('.…'));
  const out = truncateAtSentence('value 3.14 is pi and more text follows', 20);
  assert.ok(!/3\.…$/.test(out), `不该在小数点后截断：${out}`);
});

test('detail 三档：越小越省，且都从格边界截', () => {
  const variants = Object.entries(DETAIL_CHARS).map(([k, v]) => {
    const text = formatManifest(makeResult(), { maxChars: 200_000, maxCellChars: v });
    return { k, v, len: text.length };
  });
  assert.ok(variants[0].len < variants[1].len, 'low 应比 med 短');
  assert.ok(variants[1].len < variants[2].len, 'med 应比 high 短');
  for (const { k, len } of variants) assert.ok(len > 0, `${k} 不该为空`);
});

/* ---------------------------------------------------------------- 切点列表 */

test('formatManifest: 切点 ≤24 时列出精确时间', () => {
  const r = makeResult({ cells: 16 });
  r.cuts = [{ t: 12.75 }, { t: 16.13 }, { t: 44.5 }];
  r.window = { from: 0, to: 100, duration: 100 };
  const text = formatManifest(r, { maxChars: 200_000 });
  assert.match(text, /cut points \(3\): 00:12\.75, 00:16\.13, 00:44\.50/);
});

test('formatManifest: 切点太多时不列（总览只给密度）', () => {
  const r = makeResult({ cells: 16 });
  r.cuts = Array.from({ length: 40 }, (_, i) => ({ t: i * 2 }));
  r.window = { from: 0, to: 100, duration: 100 };
  const text = formatManifest(r, { maxChars: 200_000 });
  assert.ok(!/cut points/.test(text), '40 个切点不该逐条列出');
});

/* ---------------------------------------------------------------- 台词/静音一致性 */

test('countTextInSilence: 整句压在静音里才算', () => {
  const silences = [{ from: 10, to: 14 }];
  const segs = [
    { from: 10.2, to: 13.5 },     // 几乎全在静音里 → 算
    { from: 13.0, to: 15.0 },     // 只有 50% → 不算
    { from: 20, to: 22 },         // 完全在外面 → 不算
  ];
  assert.equal(countTextInSilence(segs, silences), 1);
});

test('countTextInSilence: 没有静音段 / 没有台词都为 0', () => {
  assert.equal(countTextInSilence([{ from: 1, to: 2 }], []), 0);
  assert.equal(countTextInSilence([], [{ from: 1, to: 2 }]), 0);
  assert.equal(countTextInSilence(undefined, undefined), 0);
});

test('formatManifest: 有台词压在静音里时给出提示', () => {
  const r = makeResult({ cells: 4 });
  r.transcript = { source: 'asr', model: 'fake', segments: 3, textInSilence: 2 };
  const text = formatManifest(r, { maxChars: 200_000 });
  assert.match(text, /2 line\(s\) of text sit inside a detected silence/);
});
