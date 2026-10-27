# Changelog

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
