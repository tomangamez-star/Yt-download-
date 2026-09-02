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

async function startDownload(video, type, quality) {
  if (pollTimer) clearTimeout(pollTimer);
  saveButton.classList.add('hidden');
  downloadPanel.classList.remove('hidden');
  jobTitle.textContent = video.title;
  jobPhase.textContent = 'Creating download job…';
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  speedText.textContent = '—';
  etaText.textContent = 'ETA —';
  downloadPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const job = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({ url: video.url, type, quality }),
    });
    pollJob(job.id);
  } catch (error) {
    jobPhase.textContent = error.message;
  }
}

async function pollJob(id) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const percent = Number.isFinite(job.progress) ? Math.round(job.progress * 10) / 10 : 0;
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    progressText.textContent = `${percent}%`;
    speedText.textContent = job.speed || '—';
    etaText.textContent = job.eta ? `ETA ${job.eta}` : 'ETA —';
    jobTitle.textContent = job.title || 'Preparing…';

    const phaseText = {
      queued: 'Queued — waiting for a download slot',
      preparing: 'Reading video information…',
      downloading: 'Downloading from YouTube…',
      processing: 'FFmpeg is processing the file…',
      complete: 'Ready to save',
      failed: job.error || 'Download failed',
    };
    jobPhase.textContent = phaseText[job.phase] || job.phase;

    if (job.status === 'complete') {
      saveButton.href = `/api/jobs/${encodeURIComponent(id)}/file`;
      saveButton.classList.remove('hidden');
      return;
    }
    if (job.status === 'failed') return;

    pollTimer = setTimeout(() => pollJob(id), 900);
  } catch (error) {
    jobPhase.textContent = error.message;
  }
}
