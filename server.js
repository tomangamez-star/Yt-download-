const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchYouTube, getVideoInfo, isYouTubeUrl } = require('./lib/ytdlp');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const MAX_VIDEO_DURATION_SEC = Math.max(60, Number(process.env.MAX_VIDEO_DURATION_SEC || 7200));
const MAX_FILE_MB = Math.max(25, Number(process.env.MAX_FILE_MB || 750));
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SUPABASE_BUCKET = String(process.env.SUPABASE_BUCKET || 'tubegrab-temp');
const GITHUB_REPOSITORY = String(process.env.GITHUB_REPOSITORY || '');
const GITHUB_WORKFLOW_TOKEN = String(process.env.GITHUB_WORKFLOW_TOKEN || '');
const GITHUB_WORKFLOW_REF = String(process.env.GITHUB_WORKFLOW_REF || 'main');
const GITHUB_WORKFLOW_FILE = String(process.env.GITHUB_WORKFLOW_FILE || 'tubegrab-download-worker.yml');

function cloudConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && GITHUB_REPOSITORY && GITHUB_WORKFLOW_TOKEN);
}

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

async function supabaseRequest(resource, { method = 'GET', body, prefer } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(`${SUPABASE_URL}${resource}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : data?.message || data?.error || response.statusText;
    throw new Error(`SUPABASE_${response.status}:${detail}`);
  }
  return data;
}

async function getJob(id) {
  const rows = await supabaseRequest(`/rest/v1/tubegrab_jobs?id=eq.${encodeURIComponent(id)}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchJob(id, changes) {
  await supabaseRequest(`/rest/v1/tubegrab_jobs?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { ...changes, updated_at: new Date().toISOString() },
  });
}

async function dispatchGitHubJob(job) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW_FILE)}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_WORKFLOW_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'TubeGrab-Render',
    },
    body: JSON.stringify({
      ref: GITHUB_WORKFLOW_REF,
      inputs: {
        job_id: job.id,
        url: job.url,
        type: job.type,
        quality: job.quality,
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GITHUB_DISPATCH_${response.status}:${text.slice(0, 500)}`);
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: Number(job.progress || 0),
    speed: job.speed || null,
    eta: job.eta || null,
    title: job.title || null,
    type: job.type,
    quality: job.quality,
    error: job.error || null,
    ready: job.status === 'complete' && Boolean(job.object_path),
    createdAt: job.created_at ? Date.parse(job.created_at) : null,
    expiresAt: job.expires_at ? Date.parse(job.expires_at) : null,
  };
}

function friendlyError(error) {
  const raw = `${error?.stderr || ''}\n${error?.message || ''}`;
  if (/Sign in to confirm|login|cookies/i.test(raw)) return 'YouTube requires authentication for this video.';
  if (/Private video/i.test(raw)) return 'That video is private.';
  if (/Video unavailable/i.test(raw)) return 'That video is unavailable.';
  if (/age.restricted|age-restricted/i.test(raw)) return 'That video could not be accessed.';
  if (/Unsupported URL/i.test(raw)) return 'That YouTube URL is not supported.';
  return 'The request failed. Please try again in a moment.';
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, cloudWorkerConfigured: cloudConfigured() });
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
  if (!cloudConfigured()) return res.status(503).json({ error: 'TubeGrab cloud worker is not configured yet.' });

  const id = crypto.randomUUID();
  const row = {
    id,
    url,
    type,
    quality,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    max_file_mb: MAX_FILE_MB,
    max_duration_sec: MAX_VIDEO_DURATION_SEC,
  };

  try {
    const inserted = await supabaseRequest('/rest/v1/tubegrab_jobs', {
      method: 'POST',
      body: row,
      prefer: 'return=representation',
    });
    const job = Array.isArray(inserted) ? inserted[0] : null;
    await dispatchGitHubJob(row);
    res.status(202).json(publicJob(job || row));
  } catch (error) {
    console.error('[dispatch]', error);
    try { await patchJob(id, { status: 'failed', phase: 'failed', error: 'Could not start the download worker.' }); } catch {}
    res.status(502).json({ error: 'Could not start the download worker. Check TubeGrab server configuration.' });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
    res.json(publicJob(job));
  } catch (error) {
    console.error('[job-status]', error);
    res.status(502).json({ error: 'Could not read download status.' });
  }
});

app.get('/api/jobs/:id/file', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job || job.status !== 'complete' || !job.object_path) {
      return res.status(404).json({ error: 'File not ready or already expired.' });
    }
    if (job.expires_at && Date.parse(job.expires_at) <= Date.now()) {
      return res.status(410).json({ error: 'This temporary download has expired.' });
    }

    const signed = await supabaseRequest(`/storage/v1/object/sign/${encodeURIComponent(SUPABASE_BUCKET)}/${job.object_path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      body: { expiresIn: 15 * 60 },
    });
    const signedPath = signed?.signedURL || signed?.signedUrl;
    if (!signedPath) throw new Error('SUPABASE_SIGNED_URL_MISSING');
    const location = signedPath.startsWith('http') ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath.startsWith('/') ? '' : '/'}${signedPath}`;
    res.redirect(302, location);
  } catch (error) {
    console.error('[signed-download]', error);
    res.status(502).json({ error: 'Could not prepare the temporary download link.' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`TubeGrab listening on http://${HOST}:${PORT}`);
  console.log(`GitHub/Supabase worker: ${cloudConfigured() ? 'configured' : 'NOT configured'}`);
});
