# TubeGrab — Render-ready YouTube downloader

A small mobile-friendly web app that lets a user paste a **YouTube URL** or **search by video name**, then request:

- MP4 up to 360p
- MP4 up to 720p
- MP4 up to 1080p
- MP3 audio
- Live download progress
- Temporary files only (automatic cleanup)
- Basic rate limiting and concurrency protection

The backend uses **Node.js + Express**, **yt-dlp**, and **FFmpeg**. Docker is used so the same dependencies are available locally and on Render.

> Use this only for media you own or have permission to download. This project does not attempt to bypass DRM, private-video access controls, or paid/member access.

## 1. Put it on GitHub

Create a new GitHub repository, then upload the contents of this folder so `Dockerfile`, `render.yaml`, `package.json`, and `server.js` are at the repository root.

## 2. Deploy to Render with Blueprint

1. Sign in to Render.
2. Choose **New > Blueprint**.
3. Connect the GitHub repository.
4. Render reads `render.yaml` and creates the Docker web service.
5. Deploy.

The app listens on `0.0.0.0:$PORT`, and the health endpoint is `/api/health`.

You can also create a normal Render Web Service manually and choose **Docker** as the runtime. The included `Dockerfile` installs FFmpeg, Python, and `yt-dlp[default]` (including its EJS challenge scripts) when the image is built. The backend explicitly enables the bundled Node 22 runtime for yt-dlp’s YouTube JavaScript challenges.

## 3. Optional environment variables

Defaults are already provided in `render.yaml`:

| Variable | Default | Purpose |
|---|---:|---|
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Prevents too many FFmpeg/yt-dlp jobs at once |
| `MAX_VIDEO_DURATION_SEC` | `7200` | Reject videos longer than 2 hours |
| `MAX_FILE_MB` | `750` | yt-dlp maximum file size |
| `JOB_TTL_MINUTES` | `20` | How long a completed temp file stays available |
| `API_RATE_LIMIT_PER_MINUTE` | `30` | General API limit per client IP |
| `DOWNLOAD_RATE_LIMIT_PER_10_MIN` | `8` | Download-job limit per client IP |

For a small/free Render instance, keep concurrency low. FFmpeg and high-resolution merges can consume significant CPU, memory, bandwidth, and temporary disk space.

## Optional YouTube cookies

Public videos should be attempted without an account first. If you have a legitimate need to access media that **your own account is authorized to access**, you can provide a Netscape-format cookies file as a Render Secret File and set:

```text
YTDLP_COOKIES_FILE=/etc/secrets/cookies.txt
```

Do **not** commit `cookies.txt` to GitHub. Treat it like a password/session token. `cookies.txt` is included in `.gitignore` and `.dockerignore`.

YouTube/yt-dlp behavior changes over time. Modern yt-dlp requires an external JavaScript runtime for full YouTube support; this repo uses Node 22 and installs the matching EJS package. Some formats can still require additional YouTube-side tokens or stop working temporarily, so keep yt-dlp current by redeploying/rebuilding when needed.

## Local Docker test

```bash
docker build -t tubegrab .
docker run --rm -p 10000:10000 tubegrab
```

Open `http://localhost:10000`.

## Local test without Docker

You need Node.js 20+, Python/yt-dlp, and FFmpeg installed and available on PATH.

```bash
npm install
npm start
```

## API overview

- `GET /api/health` — health/status
- `POST /api/search` — `{ "q": "YouTube link or search words" }`
- `GET /api/info?url=...` — video metadata + available heights
- `POST /api/download` — starts a temporary download job
- `GET /api/jobs/:id` — polls progress
- `GET /api/jobs/:id/file` — sends the completed file

## Important v1 limitations

- YouTube only.
- No playlists.
- No live streams.
- Jobs are kept in memory, so a Render restart removes their status.
- Temporary downloaded files disappear after the configured TTL or when the service restarts.
- A public downloader can burn through server bandwidth quickly. Before opening it to many users, add stronger quotas/authentication and consider a paid service plan.
