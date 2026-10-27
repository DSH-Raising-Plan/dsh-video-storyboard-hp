# Changelog

## [Unreleased]

Two things borrowed from a community PR, both about giving the model information it cannot derive on
its own — without growing the manifest much.

**`fast cuts:` line.** We already reported `cuts N` per cell and the film-wide average, but neither says
*"this stretch is a montage"*. `findBursts` was being computed and then thrown away (it also returned a
`shots` field that was always `undefined` — a latent bug). Now the strongest bursts are listed with their
shot counts and an actionable next step:

```
fast cuts: 00:42.80-01:04.80 (22 shots), 01:09.00-01:13.10 (5 shots) — video_zoom({ from, to, cells: 6, minGap: 0.4 }) splits these into single shots.
```

Cost: +151 characters on a 9-cell run (1,344 → 1,495).

**`seen before:` line in `video_probe`.** The cache answers "has this stretch been computed"; it cannot
answer "have I looked at this file, and which parts". Change the window, rename the file or come back
tomorrow and everything is recomputed — which is exactly why an agent re-describes the same video every
time. `src/memory.js` now appends one line per analysed window to `seen.jsonl` in the cache directory, and
`video_probe` reports:

```
seen before: 2 window(s) analysed before (0-30s, 30-60s), last on 2026-10-28 00:51.
If you already described this file, cite that instead of describing it again.
```

It stores **mechanical facts only** (path, window, cells, cuts, timestamp) — never model output, so a
previous conclusion cannot leak into a new conversation as if it were evidence.

**Two honesty fixes in the scanner**, both from reading a contributor's write-up rather than their code:

- the threshold is now applied with `> threshold + 1e-6` and capped to the target count. With `>=`, a
  branch landing exactly on a quantile drags an entire cluster of tied frames in (measured: +30 % cuts on
  one clip). On our two test clips the counts are unchanged (42 / 141) — this is a safety net, not a change.
- **`degraded: 'motion'`**: median shot < 0.5 s *and* more than 30 % of frames above the threshold means
  continuous camera motion being cut into pieces, not editing. The manifest then says
  `cut count unreliable here … do not quote cuts=N as pacing`. Better to admit the number is meaningless
  than to let a model build a story on it.

`video_probe` also offers the STRUCTURE/SEQUENCE menu from 8 minutes instead of 20 — a 10-minute video
benefits from the choice as much as a feature film does.

Tests 189 → **199**.

## [0.2.2] — 2026-10-27

Three things, all of them about *not* wasting the reader's attention.

**`layout: 'strip'` is gone.** It was never worth its surface area: at equal cell count a grid canvas keeps
a normal aspect ratio, so the cells are actually **bigger**, and the burned-in indices already settle the
reading order. Removed the parameter, the 8:1 aspect guard and every doc mention.
*Breaking for anyone who passed it — hence the version note below.*

**Transcript vs silence consistency.** A line that sits >60 % inside a detected silence is counted and
reported: either the speech is under the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call, one line in the text block when non-zero.

**A real manual.** `docs/USAGE.md` + `docs/USAGE.zh.md`: three install paths, a 3-minute first run, every
parameter of all three tools, six workflows, transcript backend config, cache, a troubleshooting table built
from failures we actually hit, and a cost table.

> Versioning note: removing a parameter is technically a breaking change (0.3.0). It is released as 0.2.2
> because the parameter had existed for under an hour and nobody could have depended on it.

## [0.2.1] — 2026-10-27

Everything since 0.2.0, as one patch release (the whole set is polish and a few parameters, no
architectural change).

**"How fast is this cut?" is now a number in the text, not something the model has to count.**

- Every cell line carries `cuts N` when that cell contains shot changes, and the header carries
  `cuts="141 (avg 2.1s)"`. The yellow ticks on the footer strip already show *where*; this says *how many*.
- `video_zoom` accepts `minGap` — re-read a fast-cut montage with `minGap: 0.4` and 0.3 s shots get their
  own cell instead of being merged into a neighbour.
- `video_zoom` accepts `layout: 'strip'` — one row of cells for a short window of continuous motion.
  Falls back to a grid if the strip would exceed 12:1 (vision encoders resize by the long edge, so an
  18:1 strip leaves every cell ~100 px wide).
- `--batch` now scans once for cut points and **snaps window boundaries to real cuts** (`--no-snap` to
  disable). A 92 s clip at 30 s windows lands on 0–30.88 / 30.88–59.88 / 59.88–92 instead of the clock.
- Audio strip height is capped by cell height, so a 2476 px-wide strip layout no longer gets a 136 px
  footer eating 37 % of the image.

**Text index diet.** Measured on a 9-cell run: 2,892 → **2,171 characters (-25 %)**, with no
information lost that the model can actually use.

- per-cell transcript cap 180 → 120 chars (page with `cellRange` if you need the rest)
- `sharp 479.7` removed from the text index — a bare number the model cannot interpret; still in the JSON
  manifest
- `image 1` dropped when there is only one sheet (it is pure redundancy); kept for multi-sheet

**`detail: low | med | high`** — transcript budget per cell, and truncation now lands on a
sentence boundary instead of cutting mid-word.

Measured on a 9-cell run: `low` 1,521 chars · `med` 1,915 · `high` 3,031. Note that med is *cheaper*
than the old hard-cut 120 (2,171) even though the budget is the same, because stopping at the last
sentence end usually costs fewer characters than filling the quota.

**`detail: low|med|high`** — transcript budget per cell (60/120/400), and truncation lands on a
sentence boundary. Measured on 9 cells: 1,521 / 1,915 / 3,031 characters — `med` is 12 % cheaper than
the old hard cut at the same budget.

**Read order is explicit.** `video_probe` offers STRUCTURE (overview, spoils the ending) and SEQUENCE
(window by window, never looks ahead) and refuses to choose.

**Speed.** `--batch` reuses one full scan across windows (17.0 s → 9.0 s on a 92 s clip); `video_zoom`
takes `minGap` and `layout: 'strip'`; audio strip height is capped by cell height.

**Removed `layout: 'strip'`.** It was never worth its surface area: at equal cell count a grid canvas has a
normal aspect ratio, so the cells are *bigger*, and the burned indices already settle the reading order. One
fewer parameter to explain.

**Transcript vs silence consistency.** A line that sits (>60 %) inside a detected silence is counted and
reported: either the speech is below the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call.

**Cut points are listed when they fit.** A window with ≤ 24 cuts now prints
`cut points (3): 00:12.75, 00:16.13, 00:44.50` — exact times, because the strip can only be read to
±2–4 s. Busy windows still get counts only, so an overview does not pay for a 141-entry list.

**Silence blocks stay a backdrop.** Tried drawing them as an occluder (bars skipped inside silence); it
looked like the waveform was chopped into solid grey bars, so it was reverted — grey is a backdrop *behind*
the bars. The wording now says what a short bar actually means: "quiet for this film", not "silent".

Tests 174 → **186**.

## [0.2.0] — 2026-10-27

**Text side now has a budget and paging.** A 2 h 35 min film produced a 75 KB index; the host folded 44 %
of it into a disk overflow file that the model never read, so 44 minutes of dialogue were effectively lost.

- `cellRange: [first, last]` — render only that slice of the index.
- `textOnly: true` — return the index with **no image and no frame decode**; combined with the scan cache
  it is ~0.8 s per page after the first call.
- Per-cell transcript is capped at 180 chars by default (an overview needs "what is this stretch about";
  ask for the cell range if you need the full text).
- When the index exceeds its budget it now stops **on a cell boundary** and says which `cellRange` to
  request next, instead of being silently folded into a file.
- ASR results are cached by (file, window, endpoint, chunk size) — paging no longer re-runs recognition.

**New: `video_probe`.** Container metadata in milliseconds — duration, resolution, rotation, audio and
subtitle tracks — plus a suggested reading plan. Costs no image tokens, so the model can decide *how* to
read a file before spending its first 384.

**Content-type routing.** `suggest()` now sees speech rate and loudness, not just duration and motion:
`meanLufs > −18 && charsPerSec < 1` marks a music-driven clip, which keeps the cell floor at 9 instead of
letting the "dialogue carries the info" rule shrink it. Measured: concept PV 0.16 chars/s @ −14.2 LUFS
fires; the tutorial at 5.59 chars/s and the narrative film at 2.05 do not.

**Term dictionary.** `~/.dsh/asr.json` accepts `"terms": {"绘插": "彗差"}` — deterministic replacement over
ASR output, single-pass (longest match first, no substring re-entry), with the replacement count reported.

**Baseline.** `docs/BASELINE.md`: four clips measured end to end, plus the finding that loudness and speech
rate move in opposite directions.

## [0.1.0] — 2026-10-27

## [0.1.0] — 2026-10-27

First working release.

**Tools**
- `video_storyboard` — one addressable grid per clip: burned-in indices, per-cell timestamp ranges,
  per-cell transcript, footer audio strip.
- `video_zoom` — re-read a short window with fewer, larger cells.

**Sampling**
- HSV-weighted shot detection with a rate-based adaptive threshold (`3×p95` produced zero cuts on
  fast-cut anime; targeting ≈1 cut per 1.5 s fixed it).
- Cell placement follows local cut density; the timeline stays fully covered at a fixed token cost.
- `--pick sharp` selects the frame with the highest Laplacian variance.
- Segment merging honours a minimum gap that never exceeds the material's own granularity.

**Audio**
- EBU R128 loudness + silence detection, drawn as a strip on the same time axis as the cells.
- Transcript: embedded subtitle track → OpenAI-compatible ASR → skip. Long windows are chunked
  client-side (cut points snapped to silence) after a 299 s request was found to shift every
  timestamp 13 s early.
- Non-speech segments (ASR inventing words over music) are filtered and reported, never silently dropped.

**Engineering**
- Zero image library, zero font dependency; PNG is produced through ffmpeg's `image2pipe`.
- Scan cache keyed by file + window + threshold (5-min clip: 13.4 s → 3.6 s on the second call).
- Tool schema is verified against the host's real `defineTool` / `validateArgs`.
- 154 tests: unit + ffmpeg end-to-end + host contract.

[0.1.0]: https://github.com/SAOS-3624/dsh-video-storyboard/releases/tag/v0.1.0
