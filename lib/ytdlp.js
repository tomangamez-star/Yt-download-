const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const DEFAULT_RENDER_COOKIES_FILE = '/etc/secrets/cookies.txt';
const DEFAULT_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 120000);

let lastCookieStatus = null;

function resolveCookiesFile() {
  // An explicit environment variable always wins. Otherwise, automatically
  // use the standard Render Secret File path when cookies.txt is present.
  const configured = String(process.env.YTDLP_COOKIES_FILE || '').trim();
  const candidates = configured
    ? [configured]
    : [DEFAULT_RENDER_COOKIES_FILE];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0) {
        if (lastCookieStatus !== candidate) {
          console.log(`[yt-dlp] Using YouTube cookies from ${candidate}`);
          lastCookieStatus = candidate;
        }
        return candidate;
      }
    } catch (error) {
      console.warn(`[yt-dlp] Could not inspect cookies file ${candidate}: ${error.message}`);
    }
  }

  const missingStatus = configured ? `missing:${configured}` : 'none';
  if (lastCookieStatus !== missingStatus) {
    if (configured) {
      console.warn(`[yt-dlp] YTDLP_COOKIES_FILE is set but is missing or empty: ${configured}`);
    } else {
      console.log('[yt-dlp] No cookies file detected; continuing without an authenticated YouTube session.');
    }
    lastCookieStatus = missingStatus;
  }

  return null;
}

function cookieArgs(useCookies = false) {
  if (!useCookies) return [];
  const cookiesFile = resolveCookiesFile();
  return cookiesFile ? ['--cookies', cookiesFile] : [];
}

function runYtDlp(args, { timeoutMs = DEFAULT_TIMEOUT_MS, onStdout, onStderr, useCookies = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, ['--js-runtimes', 'node', ...cookieArgs(useCookies), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
    }, timeoutMs) : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    child.on('error', (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });

      const timeoutHint = signal ? ` (terminated by ${signal})` : '';
      const error = new Error(`yt-dlp exited with code ${code}${timeoutHint}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
  });
}

function shouldRetryWithCookies(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`.toLowerCase();
  return [
    'sign in to confirm',
    'please sign in',
    'login required',
    'authentication required',
    'requires authentication',
    'use --cookies',
    'use --cookies-from-browser',
    'age-restricted',
    'confirm you’re not a bot',
    "confirm you're not a bot",
  ].some((marker) => text.includes(marker));
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'music.youtube.com';
  } catch {
    return false;
  }
}

function normalizeVideo(entry) {
  if (!entry) return null;
  const id = entry.id;
  const webpageUrl = isYouTubeUrl(entry.webpage_url || '')
    ? entry.webpage_url
    : isYouTubeUrl(entry.url || '')
      ? entry.url
      : id ? `https://www.youtube.com/watch?v=${id}` : null;
  return {
    id,
    title: entry.title || 'Untitled video',
    url: webpageUrl,
    thumbnail: entry.thumbnail || entry.thumbnails?.at?.(-1)?.url || null,
    channel: entry.channel || entry.uploader || entry.channel_id || 'Unknown channel',
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    live: Boolean(entry.is_live || entry.live_status === 'is_live'),
    viewCount: Number.isFinite(entry.view_count) ? entry.view_count : null,
  };
}

async function searchYouTube(input, limit = 8) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Enter a YouTube link or search term.');

  if (isYouTubeUrl(value)) {
    const info = await getVideoInfo(value);
    return [info];
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 12));
  const { stdout } = await runYtDlp([
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--no-playlist',
    `ytsearch${safeLimit}:${value}`,
  ]);

  const data = JSON.parse(stdout);
  return (data.entries || []).map(normalizeVideo).filter((item) => item?.url);
}

async function getVideoInfo(url) {
  if (!isYouTubeUrl(url)) throw new Error('Only YouTube links are supported in this version.');

  const { stdout } = await runYtDlp([
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    url,
  ]);

  const data = JSON.parse(stdout);
  const video = normalizeVideo(data);
  const heights = [...new Set((data.formats || [])
    .map((f) => Number(f.height))
    .filter((height) => Number.isFinite(height) && height > 0))]
    .sort((a, b) => a - b);

  return {
    ...video,
    description: data.description || '',
    qualities: heights,
  };
}

function formatSelector(quality) {
  const map = {
    '360': 'bv*[height<=360]+ba/b[height<=360]/b',
    '720': 'bv*[height<=720]+ba/b[height<=720]/b',
    '1080': 'bv*[height<=1080]+ba/b[height<=1080]/b',
  };
  return map[String(quality)] || map['720'];
}

function parseProgressLine(line) {
  if (!line.startsWith('PROGRESS:')) return null;
  const payload = line.slice('PROGRESS:'.length);
  const [percentRaw = '', speed = '', eta = ''] = payload.split('|');
  const percent = Number.parseFloat(percentRaw.replace('%', '').trim());
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    speed: speed.trim() || null,
    eta: eta.trim() || null,
  };
}

async function downloadVideo({ url, quality, type, outputDir, maxFileMb, onProgress, onPhase }) {
  if (!isYouTubeUrl(url)) throw new Error('Only YouTube links are supported in this version.');

  const outputTemplate = path.join(outputDir, '%(title).120B [%(id)s].%(ext)s');
  const common = [
    '--no-playlist',
    '--newline',
    '--no-colors',
    '--no-warnings',
    '--windows-filenames',
    '--progress-template',
    'download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print',
    'after_move:FINAL_FILE:%(filepath)s',
    '--max-filesize',
    `${Math.max(25, Number(maxFileMb) || 750)}M`,
    '-o',
    outputTemplate,
  ];

  const args = [...common];
  if (type === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', formatSelector(quality), '--merge-output-format', 'mp4');
  }
  args.push(url);

  let finalPath = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const consumeLines = (chunk, kind) => {
    if (kind === 'stdout') stdoutBuffer += chunk;
    else stderrBuffer += chunk;

    const current = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
    const lines = current.split(/\r?\n/);
    const remainder = lines.pop() || '';
    if (kind === 'stdout') stdoutBuffer = remainder;
    else stderrBuffer = remainder;

    for (const line of lines) {
      if (line.startsWith('FINAL_FILE:')) {
        finalPath = line.slice('FINAL_FILE:'.length).trim();
      }
      const progress = parseProgressLine(line);
      if (progress) {
        onPhase?.('downloading');
        onProgress?.(progress);
      }
      if (/\[(Merger|ExtractAudio|VideoRemuxer|Fixup)/.test(line)) {
        onPhase?.('processing');
      }
    }
  };

  const runDownload = (useCookies) => runYtDlp(args, {
    timeoutMs: 0,
    useCookies,
    onStdout: (chunk) => consumeLines(chunk, 'stdout'),
    onStderr: (chunk) => consumeLines(chunk, 'stderr'),
  });

  try {
    // Public access is always the first attempt. This keeps normal/public
    // downloads independent of any stale or unusable browser session.
    await runDownload(false);
  } catch (error) {
    const cookiesFile = shouldRetryWithCookies(error) ? resolveCookiesFile() : null;
    if (!cookiesFile) throw error;

    console.log('[yt-dlp] Public download hit a YouTube auth challenge; retrying with Render cookies.');

    // Clear parser state before the retry so output from the failed public
    // attempt cannot leak into the authenticated attempt.
    finalPath = null;
    stdoutBuffer = '';
    stderrBuffer = '';

    await runDownload(true);
  }

  if (!finalPath) {
    const files = fs.readdirSync(outputDir)
      .map((name) => path.join(outputDir, name))
      .filter((file) => fs.statSync(file).isFile() && !file.endsWith('.part'));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    finalPath = files[0] || null;
  }

  if (!finalPath || !fs.existsSync(finalPath)) {
    throw new Error('The download finished but the output file could not be found.');
  }

  return finalPath;
}

module.exports = {
  isYouTubeUrl,
  searchYouTube,
  getVideoInfo,
  downloadVideo,
};
