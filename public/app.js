const searchForm = document.getElementById('searchForm');
const queryInput = document.getElementById('queryInput');
const searchButton = document.getElementById('searchButton');
const statusBox = document.getElementById('statusBox');
const resultsSection = document.getElementById('resultsSection');
const resultsGrid = document.getElementById('resultsGrid');
const resultCount = document.getElementById('resultCount');
const downloadPanel = document.getElementById('downloadPanel');
const jobTitle = document.getElementById('jobTitle');
const jobPhase = document.getElementById('jobPhase');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const speedText = document.getElementById('speedText');
const etaText = document.getElementById('etaText');
const saveButton = document.getElementById('saveButton');

let pollTimer = null;
let activeJobStartedAt = null;
let activeJobFinished = false;
let elapsedTimer = null;

function setStatus(message, error = false) {
  if (!message) {
    statusBox.classList.add('hidden');
    statusBox.textContent = '';
    return;
  }
  statusBox.textContent = message;
  statusBox.classList.remove('hidden');
  statusBox.classList.toggle('error', error);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function renderResults(results) {
  resultsGrid.innerHTML = '';
  resultCount.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  resultsSection.classList.remove('hidden');

  for (const video of results) {
    const card = document.createElement('article');
    card.className = 'video-card';
    card.innerHTML = `
      <div class="thumb-wrap">
        ${video.thumbnail ? `<img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
        <span class="duration">${video.live ? 'LIVE' : formatDuration(video.duration)}</span>
      </div>
      <div class="card-body">
        <h3>${escapeHtml(video.title)}</h3>
        <p class="channel">${escapeHtml(video.channel)}</p>
        <div class="actions">
          <button data-type="video" data-quality="360">360p</button>
          <button data-type="video" data-quality="720">720p</button>
          <button data-type="video" data-quality="1080">1080p</button>
          <button data-type="audio" class="audio">MP3</button>
        </div>
      </div>`;

    card.querySelectorAll('button[data-type]').forEach((button) => {
      button.addEventListener('click', () => startDownload(video, button.dataset.type, button.dataset.quality));
    });
    resultsGrid.appendChild(card);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = queryInput.value.trim();
  if (!q) return;

  searchButton.disabled = true;
  searchButton.textContent = 'Searching…';
  resultsSection.classList.add('hidden');
  setStatus('Checking YouTube…');

  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ q }),
    });
    if (!data.results?.length) {
      setStatus('No videos found for that search.', true);
      return;
    }
    setStatus('');
    renderResults(data.results);
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = 'Search';
  }
});

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function updateElapsedDisplay() {
  if (!activeJobStartedAt || activeJobFinished) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - activeJobStartedAt) / 1000));
  const elapsedLabel = `Elapsed ${formatDuration(elapsed)}`;

  // Reuse the secondary ETA label while there is no real ETA yet.
  if (!etaText.dataset.hasRealEta) {
    etaText.textContent = elapsedLabel;
  }
}

function beginElapsedTimer() {
  stopElapsedTimer();
  activeJobStartedAt = Date.now();
  activeJobFinished = false;
  etaText.dataset.hasRealEta = '';
  updateElapsedDisplay();
  elapsedTimer = setInterval(updateElapsedDisplay, 1000);
}

function setProgress(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const rounded = Math.round(safe * 10) / 10;
  progressBar.style.width = `${rounded}%`;
  progressText.textContent = `${rounded}%`;
}

async function startDownload(video, type, quality) {
  if (pollTimer) clearTimeout(pollTimer);
  stopElapsedTimer();
  saveButton.classList.add('hidden');
  downloadPanel.classList.remove('hidden');
  jobTitle.textContent = video.title;
  jobPhase.textContent = 'Request accepted — creating download job…';
  setProgress(3);
  speedText.textContent = 'Preparing…';
  etaText.textContent = 'Elapsed 0:00';
  downloadPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  beginElapsedTimer();

  try {
    const job = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({ url: video.url, type, quality }),
    });
    if (job.createdAt) activeJobStartedAt = job.createdAt;
    pollJob(job.id);
  } catch (error) {
    activeJobFinished = true;
    stopElapsedTimer();
    jobPhase.textContent = error.message;
    speedText.textContent = 'Failed';
  }
}

async function pollJob(id) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (job.createdAt && !activeJobStartedAt) activeJobStartedAt = job.createdAt;

    setProgress(job.progress);

    const hasSpeed = Boolean(job.speed && job.speed !== 'Unknown B/s');
    speedText.textContent = hasSpeed ? job.speed : phaseSpeedText(job.phase);

    if (job.eta) {
      etaText.dataset.hasRealEta = '1';
      etaText.textContent = `ETA ${job.eta}`;
    } else {
      etaText.dataset.hasRealEta = '';
      updateElapsedDisplay();
    }

    jobTitle.textContent = job.title || jobTitle.textContent || 'Preparing…';

    const phaseText = {
      queued: 'Request accepted — worker is queued',
      starting: 'Worker allocated — starting TubeGrab engine…',
      preparing: 'Connecting to YouTube and reading video information…',
      downloading: `Downloading from YouTube${job.progress ? ` — ${Math.round(job.progress)}% overall` : '…'}`,
      processing: 'Download complete — FFmpeg is processing the file…',
      uploading: 'Uploading temporary file to secure TubeGrab storage…',
      complete: 'Ready ✓ Tap save below — temporary link expires soon',
      failed: job.error || 'Download failed',
      expired: 'This temporary download has expired',
    };
    jobPhase.textContent = phaseText[job.phase] || job.phase || 'Working…';

    if (job.status === 'complete') {
      activeJobFinished = true;
      stopElapsedTimer();
      setProgress(100);
      speedText.textContent = 'Complete';
      etaText.dataset.hasRealEta = '1';
      etaText.textContent = activeJobStartedAt
        ? `Finished in ${formatDuration((Date.now() - activeJobStartedAt) / 1000)}`
        : 'Ready';
      saveButton.href = `/api/jobs/${encodeURIComponent(id)}/file`;
      saveButton.classList.remove('hidden');
      return;
    }

    if (job.status === 'failed' || job.status === 'expired') {
      activeJobFinished = true;
      stopElapsedTimer();
      speedText.textContent = job.status === 'failed' ? 'Failed' : 'Expired';
      etaText.dataset.hasRealEta = '1';
      etaText.textContent = activeJobStartedAt
        ? `Elapsed ${formatDuration((Date.now() - activeJobStartedAt) / 1000)}`
        : '—';
      return;
    }

    pollTimer = setTimeout(() => pollJob(id), 1200);
  } catch (error) {
    jobPhase.textContent = `${error.message} Retrying status…`;
    pollTimer = setTimeout(() => pollJob(id), 2500);
  }
}

function phaseSpeedText(phase) {
  return ({
    queued: 'Queued',
    starting: 'Starting',
    preparing: 'Preparing',
    downloading: 'Downloading',
    processing: 'Processing',
    uploading: 'Uploading',
  })[phase] || 'Working';
}
