const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchYouTube, getVideoInfo, downloadVideo, isYouTubeUrl } = require('./lib/ytdlp');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const MAX_CONCURRENT_DOWNLOADS = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2));
const MAX_VIDEO_DURATION_SEC = Math.max(60, Number(process.env.MAX_VIDEO_DURATION_SEC || 7200));
const MAX_FILE_MB = Math.max(25, Number(process.env.MAX_FILE_MB || 750));
const JOB_TTL_MS = Math.max(5, Number(process.env.JOB_TTL_MINUTES || 20)) * 60 * 1000;

const jobs = new Map();
const queue = [];
let activeDownloads = 0;

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 30),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a moment.' },
});
app.use('/api', apiLimiter);

const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.DOWNLOAD_RATE_LIMIT_PER_10_MIN || 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Download limit reached. Try again later.' },
});

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    type: job.type,
    quality: job.quality,
    error: job.error,
    ready: job.status === 'complete' && Boolean(job.filePath),
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

function friendlyError(error) {
  const raw = `${error?.stderr || ''}\n${error?.message || ''}`;
  if (/Sign in to confirm|login|cookies/i.test(raw)) {
    return 'YouTube requires authentication for this video. This server is not configured with a usable authorized session.';
  }
  if (/Private video/i.test(raw)) return 'That video is private.';
  if (/Video unavailable/i.test(raw)) return 'That video is unavailable.';
  if (/age.restricted|age-restricted/i.test(raw)) return 'That video is age-restricted and cannot be accessed by this server.';
  if (/File is larger than max-filesize|larger than max-filesize/i.test(raw)) return `That file is larger than this server's ${MAX_FILE_MB} MB limit.`;
  if (/Unsupported URL/i.test(raw)) return 'That YouTube URL is not supported.';
  return 'The download failed. YouTube may have changed something, the format may be unavailable, or the server may be temporarily blocked.';
}

async function cleanupJob(job) {
  if (!job?.dir) return;
  try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch {}
}

async function processJob(job) {
  activeDownloads += 1;
  job.status = 'running';
  job.phase = 'preparing';

  try {
    const info = await getVideoInfo(job.url);
    job.title = info.title;
    if (info.live) throw new Error('LIVE_STREAM_NOT_SUPPORTED');
    if (info.duration && info.duration > MAX_VIDEO_DURATION_SEC) {
      throw new Error(`VIDEO_TOO_LONG:${info.duration}`);
    }

    const filePath = await downloadVideo({
      url: job.url,
      quality: job.quality,
      type: job.type,
      outputDir: job.dir,
      maxFileMb: MAX_FILE_MB,
      onPhase: (phase) => { job.phase = phase; },
      onProgress: ({ percent, speed, eta }) => {
        if (percent !== null) job.progress = percent;
        job.speed = speed;
        job.eta = eta;
      },
    });

    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_FILE_MB * 1024 * 1024) {
      await fsp.rm(filePath, { force: true });
      throw new Error('OUTPUT_TOO_LARGE');
    }

    job.filePath = filePath;
    job.fileName = path.basename(filePath);
    job.status = 'complete';
    job.phase = 'complete';
    job.progress = 100;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  } catch (error) {
    if (String(error.message).startsWith('VIDEO_TOO_LONG:')) {
      job.error = `Video is longer than the server limit of ${Math.round(MAX_VIDEO_DURATION_SEC / 60)} minutes.`;
    } else if (error.message === 'LIVE_STREAM_NOT_SUPPORTED') {
      job.error = 'Live streams are not supported in this first version.';
    } else if (error.message === 'OUTPUT_TOO_LARGE') {
      job.error = `The finished file exceeded this server's ${MAX_FILE_MB} MB limit.`;
    } else {
      console.error('[download]', error.stderr || error);
      job.error = friendlyError(error);
    }
    job.status = 'failed';
    job.phase = 'failed';
    job.expiresAt = Date.now() + 5 * 60 * 1000;
    await cleanupJob(job);
  } finally {
    activeDownloads -= 1;
    pumpQueue();
  }
}

function pumpQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.status !== 'queued') continue;
    processJob(job);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, activeDownloads, queuedDownloads: queue.length });
});

app.post('/api/search', async (req, res) => {
  const input = String(req.body?.q || '').trim();
  if (!input || input.length > 300) return res.status(400).json({ error: 'Enter a valid YouTube link or search term.' });

  try {
    const results = await searchYouTube(input, 8);
    res.json({ mode: isYouTubeUrl(input) ? 'url' : 'search', results });
  } catch (error) {
    console.error('[search]', error.stderr || error);
    res.status(502).json({ error: friendlyError(error) });
  }
});

app.get('/api/info', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Provide a valid YouTube URL.' });
  try {
    res.json(await getVideoInfo(url));
  } catch (error) {
    console.error('[info]', error.stderr || error);
    res.status(502).json({ error: friendlyError(error) });
  }
});

app.post('/api/download', downloadLimiter, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const type = req.body?.type === 'audio' ? 'audio' : 'video';
  const quality = ['360', '720', '1080'].includes(String(req.body?.quality)) ? String(req.body.quality) : '720';

  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Provide a valid YouTube URL.' });

  const id = crypto.randomUUID();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tubegrab-'));
  const job = {
    id,
    url,
    type,
    quality,
    dir,
    filePath: null,
    fileName: null,
    title: null,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    speed: null,
    eta: null,
    error: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL_MS,
  };

  jobs.set(id, job);
  queue.push(job);
  pumpQueue();
  res.status(202).json(publicJob(job));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/file', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'complete' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: 'File not ready or already expired.' });
  }

  job.expiresAt = Date.now() + JOB_TTL_MS;
  res.download(job.filePath, job.fileName, (error) => {
    if (error && !res.headersSent) res.status(500).json({ error: 'Could not send the file.' });
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt > now || job.status === 'running') continue;
    await cleanupJob(job);
    jobs.delete(id);
  }
}, 60 * 1000).unref();

async function shutdown() {
  console.log('Shutting down...');
  for (const job of jobs.values()) await cleanupJob(job);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, HOST, () => {
  console.log(`TubeGrab listening on http://${HOST}:${PORT}`);
  console.log(`Max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
});
