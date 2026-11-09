# GFN Reel Cutter

A personal PWA for turning phone clips into Instagram reels. You upload up to 5 clips; it removes pauses and dead time, joins the clips in order, centre-crops to 9:16 (1080×1920) and renders one MP4 you can download or share straight to Instagram.

**Phase 1 (this version):** trim and join. Captions, branding and AI suggestions come in Phases 2–3.

## How it works

- **Frontend** (`public/`): installable PWA. Clips upload in 8 MB pieces, so large files get past Cloud Run's 32 MB request limit and a dropped piece is retried without starting over.
- **Backend** (`server/`): Node + Express + FFmpeg.
  1. `silencedetect` finds pauses longer than the chosen length (default 0.6 s, quieter than −35 dB).
  2. The speech segments are kept with 0.15 s of padding so words are not clipped.
  3. One FFmpeg pass cuts, joins, scales and crops to 1080×1920 @ 30 fps, H.264 (`veryfast`, CRF 21) + AAC, capped at the chosen maximum length.
- Files are stored on local disk and deleted after 24 h. Uploaded clips are deleted as soon as the reel is rendered.

Measured on 2 vCPUs: a 98 MB, 60 s 1080p clip was processed in about 25 s, and three mixed clips (44 s in total) in about 14 s. Upload time depends on your connection.

## Run locally

Needs Node 20+ and FFmpeg.

```bash
npm install
APP_PASSCODE=1234 npm start   # open http://localhost:8080
```

Leave out `APP_PASSCODE` to run without a passcode.

## Deploy to Google Cloud Run

One-time setup on your computer (or Google Cloud Shell, which already has `gcloud`):

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Deploy (run inside this repo folder):

```bash
gcloud run deploy gfn-reel-cutter \
  --source . \
  --region asia-south1 \
  --memory 2Gi --cpu 2 \
  --no-cpu-throttling \
  --max-instances 1 \
  --timeout 900 \
  --allow-unauthenticated \
  --set-env-vars APP_PASSCODE=CHOOSE_A_PASSCODE
```

Why these flags:

- `--no-cpu-throttling`: rendering keeps going after the upload request returns. Without this flag, Cloud Run slows the CPU between requests and renders crawl.
- `--max-instances 1`: jobs are kept in memory and on local disk, so every request must reach the same instance.
- `--memory 2Gi`: Cloud Run's disk lives in memory, so it must hold up to 200 MB of uploads plus the rendered reel.
- `asia-south1` is Mumbai, the closest region to Trichy.

The command prints a URL. Open it on your phone in Chrome, choose **Add to Home screen**, and it installs like an app.

**Cost:** the service scales to zero when idle. For around 30 reels a month the usage should stay within or close to Cloud Run's monthly free tier. Check the Billing page after the first month.

## API (for reference)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Whether a passcode is required |
| POST | `/api/login` | Check passcode `{passcode}` |
| POST | `/api/uploads` | Start an upload → `{id, chunkBytes}` |
| PUT | `/api/uploads/:id/clips/:n` | Append a piece of clip *n* (header `x-offset`) |
| POST | `/api/uploads/:id/start` | `{clips:[{n,name,size}], options}` → job |
| GET | `/api/jobs/:id` | Status and progress |
| GET | `/api/jobs/:id/video` | The reel (`?download=1` to download) |

The passcode goes in the `x-passcode` header, or as `?key=` for video links.

## Roadmap

- **Phase 2:** Whisper transcription, word-by-word burned-in captions (Montserrat, yellow highlight) with a caption editor, the app.getfitwithnats.com badge, an outro card and background music with ducking.
- **Phase 3:** an AI-suggested best 30 s and an on-screen hook, plus start/end trim sliders.
