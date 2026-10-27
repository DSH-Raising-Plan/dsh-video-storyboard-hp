# Setup · Reading Bilibili and web links

> For two audiences: local users who want the URL mode, and anyone cloning this from GitHub.
> If you only ever pass local files (`video_storyboard({ input: "D:/a.mp4" })`), you can skip this document entirely.

---

## 1. What you need

| Dependency | Local files | URL mode | Notes |
|---|---|---|---|
| **ffmpeg** | ✅ required | ✅ required | 7.0+, on `PATH` or via `DSH_FFMPEG_PATH` |
| **yt-dlp** | — | ✅ required | Resolves direct URLs and pulls the low-res copy. **Never bundled.** |
| **cookies.txt** | — | ✅ required | Login is required by default (see §3) |

Installing ffmpeg is covered in `USAGE.md`.

---

## 2. Installing yt-dlp

### Windows

```powershell
pip install --user -U yt-dlp
```

⚠️ The script lands in `%APPDATA%\Python\Python3xx\Scripts`, which is **usually not on `PATH`**. The plugin looks in this order:

1. `yt-dlp` / `yt-dlp.exe` on `PATH`
2. `%APPDATA%\Python\Python3xx\Scripts\yt-dlp.exe`
3. Whatever `DSH_YTDLP_PATH` points to

If none of them exist it fails loudly with the install command — it never silently degrades into "feature unavailable".

Other options:

```powershell
winget install yt-dlp     # single binary, on PATH — recommended
```

### macOS / Linux

```bash
brew install yt-dlp        # macOS
pipx install yt-dlp        # cross-platform, isolated — recommended
sudo apt install yt-dlp    # Debian/Ubuntu (may lag behind)
```

### How big

| Method | Size |
|---|---|
| `pip install` | **~25 MB** (`yt_dlp/` package) + 0.1 MB launcher |
| Standalone `yt-dlp.exe` | ~17 MB (bundles the Python runtime) |

**This is a user-side dependency, not plugin weight.** The plugin's `package.json` still has zero dependencies.

### Verify

```bash
yt-dlp --version          # expect a date-based version, e.g. 2026.10.26
```

---

## 3. Exporting cookies.txt

### Why you cannot just read the browser's cookie jar

Chromium 127+ ships **App-Bound Encryption**. Key cookies such as `SESSDATA` are stored with a `v20` prefix, whose key is bound to the browser process identity and can only be decrypted through the `IElevator` COM interface.

Measured on Windows 11 + Edge:

| Cookie | Prefix | Decryptable by a normal process |
|---|---|---|
| `enable_web_push` / `LIVE_BUVID` / `theme_style` | `v10` | ✅ |
| **`SESSDATA`** / `bili_jct` / `DedeUserID` / `buvid3` | **`v20`** | ❌ |

So `yt-dlp --cookies-from-browser chrome/edge` fails with `Failed to decrypt with DPAPI`. **That is not a misconfiguration** — the mechanism changed. Export a file instead.

### Steps

1. Install the **Cookie-Editor** extension (by cgagnier; available for Chrome and Edge)
2. Open and sign in to `bilibili.com`
3. Click the extension → **Export** (bottom right) → choose **Netscape**
4. Save as `bili-cookies.txt`

You should get a **Netscape HTTP Cookie File** that looks like this:

```
# Netscape HTTP Cookie File
.bilibili.com	TRUE	/	FALSE	1799999999	SESSDATA	<value>
.bilibili.com	TRUE	/	FALSE	1799999999	bili_jct	<value>
.bilibili.com	TRUE	/	FALSE	1799999999	DedeUserID	<value>
```

⚠️ **This file is equivalent to your session credentials.** Never commit it. Keep it under `.secrets/` or anywhere covered by `.gitignore`.

### Where to put it

```bash
# Option A: environment variable (recommended)
setx DSH_VIDEO_COOKIES "D:\path\to\bili-cookies.txt"

# Option B: pass it per call
video_storyboard({ input: "...", cookies: "D:/path/to/bili-cookies.txt" })
```

### Expiry

`SESSDATA` typically lasts a few months. When it lapses yt-dlp reports a `Sign in` / `login` message; the plugin recognises it and tells you to re-export instead of dumping raw stderr.

---

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_YTDLP_PATH` | auto-discovered | Path to the yt-dlp binary |
| `DSH_VIDEO_COOKIES` | none | Path to cookies.txt |
| `DSH_VIDEO_MEDIA_DIR` | `os.tmpdir()/dsh-video-storyboard/media` | Where the low-res copy is cached |
| `DSH_VIDEO_MEDIA_MAX_MB` | `300` | Media cache cap; evicts oldest by mtime |
| `DSH_FFMPEG_PATH` | `ffmpeg` | ffmpeg path (unchanged from 0.2.x) |

---

## 5. Verification order

Work through these in order — when something breaks you will know exactly which layer it is.

```bash
# 1. Is yt-dlp there, and is the version sane?
yt-dlp --version

# 2. Can it list formats? (no download, no cookies needed)
yt-dlp -F "https://www.bilibili.com/video/BV1BK411Q7ys"

# 3. Can it resolve a direct URL? (~2.6 s)
yt-dlp -g -f "bv*[height<=360]/b" "https://www.bilibili.com/video/BV1BK411Q7ys"

# 4. Real download, 360p (~3 MB / 3 s)
yt-dlp -f "bv*[height<=360]+ba/b[height<=360]" -o "test.%(ext)s" \
  "https://www.bilibili.com/video/BV1BK411Q7ys"

# 5. With cookies, check 1080p is visible (proves the login actually took)
yt-dlp --cookies "$DSH_VIDEO_COOKIES" -F "same URL"
```

### The format selector must use DASH syntax

Bilibili's yt-dlp extractor returns **DASH tracks** (video-only + audio-only), not a single progressive mp4. So:

```bash
-f "b[height<=360]"              # ❌ Requested format is not available
-f "bv*[height<=360]+ba"         # ✅ video track + best audio
-f "bv*[height<=360]"            # ✅ video only (for zoom — halves the bytes)
```

Measured anonymous availability (`BV1BK411Q7ys`, 300 s):

| Ladder | Video bitrate | Size | Login required |
|---|---|---|---|
| 640×360 | 90–122k | 3.1–4.3 MB | no |
| 852×480 | 109–220k | 3.9–7.9 MB | no |
| 1280×720 | 176–441k | 6.3–15.8 MB | no |
| 1920×1080 | 336–789k | 12–28 MB | no |
| 1080P **high bitrate** | — | — | **premium account** |

> What anonymous access cannot reach is the "1080P high bitrate" tier; plain 1080p is available. But **per-video permissions vary** — we observed outright failures on some videos. That is why the default policy still requires login: it removes the "thought I got 1080p, actually got 360p" failure mode.

---

## 6. Troubleshooting

| Symptom | Real cause | Fix |
|---|---|---|
| `yt-dlp not found` | Installed under `%APPDATA%\Python\...\Scripts`, not on `PATH` | Set `DSH_YTDLP_PATH` |
| `Requested format is not available` | Used progressive `b[height<=N]` syntax | Use `bv*[height<=N]+ba` |
| `Failed to decrypt with DPAPI` | Tried to read browser cookies (v20 encryption) | Export cookies.txt per §3 |
| `Sign in to confirm` / login required | Cookie expired or not passed | Re-export; check `DSH_VIDEO_COOKIES` |
| `HTTP Error 412` | Bilibili risk control (rate, missing UA) | Slow down; make sure a UA is sent |
| Download stuck at 0% | Network or CDN node | Retry; check proxy needs |
| Portrait video squashed | Rotation metadata not normalised | Fixed in 0.2.x — file a bug |
| Media dir keeps filling | Normal rolling within the 300 MB cap | Raise `DSH_VIDEO_MEDIA_MAX_MB` or clear it |
| Direct URL dies after ~2 h | Signed URLs expire | The plugin re-resolves once, then falls back to the low-res copy |

---

## 7. Privacy and compliance

- Video content stays in a local temp directory. **Never uploaded, never redistributed.**
- cookies.txt is only passed by path to the yt-dlp child process. **Never written into return values, logs, or the manifest.**
- Direct URLs are signed temporary credentials: cached for 90 minutes, then dropped. They never enter the persistent cache layer.
- Use it only for material you have the right to process. The plugin bundles no downloader, no search, and never caches or redistributes content.
