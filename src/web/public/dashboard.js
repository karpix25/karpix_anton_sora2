const state = {
  events: [],
  totals: {},
};

const elements = {
  statusText: document.getElementById('status-text'),
  history: document.getElementById('dashboard-history'),
  summary: document.getElementById('dashboard-summary'),
  typeFilter: document.getElementById('dashboard-type-filter'),
  refreshButton: document.getElementById('refresh-dashboard-button'),
};

function setStatus(message) {
  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shorten(value, maxLength = 90) {
  const text = String(value || '').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function renderSummary() {
  const totals = state.totals || {};
  const autoTodayValue = `${totals.autoCompletedToday || 0}/${totals.autoPlannedToday || 0}`;
  const cards = [
    ['Проекты', totals.projects || 0],
    ['Референсы', totals.references || 0],
    ['Генерации', totals.generations || 0],
    ['Авто сегодня', autoTodayValue],
    ['Готово', totals.completed || 0],
    ['В работе', totals.processing || 0],
    ['Ошибки', totals.failed || 0],
  ];

  elements.summary.innerHTML = cards
    .map(([label, value]) => `
      <div class="dashboard-stat">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `)
    .join('');
}

function filterEvents(events) {
  const filter = elements.typeFilter?.value || 'all';
  return events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'reference') return event.type === 'reference';
    if (filter === 'generation') return event.type === 'generation';
    if (filter === 'auto') return event.triggerMode === 'auto' || event.triggerMode === 'auto_remix';
    if (filter === 'failed') return event.status === 'failed';
    return true;
  });
}

function renderHistory() {
  renderSummary();
  const events = filterEvents(state.events || []);
  if (!events.length) {
    elements.history.classList.add('empty-state');
    elements.history.innerHTML = 'Нет событий по выбранному фильтру.';
    return;
  }

  elements.history.classList.remove('empty-state');
  elements.history.innerHTML = `
    <div class="dashboard-table">
      ${events.map((event) => {
        const isGeneration = event.type === 'generation';
        const originalUrl = event.s3ObjectUrl || event.resultVideoUrl || '';
        const finalUrl = event.yandexDownloadUrl || '';
        const primaryUrl = finalUrl || originalUrl || event.sourceUrl || event.referenceSourceUrl || '';
        const statusClass = `status-${String(event.status || 'unknown').toLowerCase()}`;
        const sourceUrl = event.sourceUrl || event.referenceSourceUrl || '';
        const fullPrompt = isGeneration ? String(event.promptText || '').trim() : '';
        const promptPreview = fullPrompt ? shorten(fullPrompt, 130) : '';
        const autoProgress = isGeneration && event.autoDailyIndex && event.autoDailyLimit
          ? `${event.autoDailyIndex}/${event.autoDailyLimit}`
          : '';
        return `
          <article class="dashboard-row ${escapeHtml(statusClass)}">
            <div class="dashboard-row-main">
              <div>
                <div class="dashboard-title-line">
                  <strong>${escapeHtml(event.title || event.type)}</strong>
                  <span class="dashboard-status">${escapeHtml(event.status || '—')}</span>
                  ${autoProgress ? `<span class="dashboard-auto-progress">День: ${escapeHtml(autoProgress)}</span>` : ''}
                  ${event.views ? `<span class="views-count">👁 ${Number(event.views).toLocaleString('ru-RU')}</span>` : ''}
                </div>
                <p class="dashboard-meta">
                  ${escapeHtml(formatDateTime(event.eventAt || event.createdAt))}
                  · ${escapeHtml(event.projectName || 'Проект без названия')}
                  ${event.projectCode ? ` · ${escapeHtml(event.projectCode)}` : ''}
                </p>
              </div>
              <div class="dashboard-links">
                ${finalUrl ? `<a href="${escapeHtml(finalUrl)}" target="_blank" rel="noreferrer">Финал ffmpeg</a>` : ''}
                ${originalUrl ? `<a href="${escapeHtml(originalUrl)}" target="_blank" rel="noreferrer">Оригинал</a>` : ''}
                ${!finalUrl && !originalUrl && primaryUrl ? `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">Видео</a>` : ''}
                ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Референс</a>` : ''}
                ${event.publicationUrl ? `<a href="${escapeHtml(event.publicationUrl)}" target="_blank" rel="noreferrer">Публикация</a>` : ''}
              </div>
            </div>
            <div class="dashboard-row-details">
              ${isGeneration ? `
                <span>Task: ${escapeHtml(shorten(event.taskId || '', 12))}</span>
                <span>Trigger: ${escapeHtml(event.triggerMode || '—')}</span>
                <span>Model: ${escapeHtml(event.targetModel || '—')}</span>
                <span>Provider: ${escapeHtml(event.provider || '—')}</span>
                ${autoProgress ? `<span>Auto limit: ${escapeHtml(autoProgress)}</span>` : ''}
              ` : `
                <span>Reference: ${escapeHtml(shorten(event.referenceLibraryItemId || '', 12))}</span>
                <span>Analysis: ${event.hasAnalysis ? 'есть' : 'нет'}</span>
                <span>Audio: ${event.hasAudio ? 'есть' : 'нет'}</span>
              `}
            </div>
            ${fullPrompt ? `
              <details class="dashboard-prompt">
                <summary>
                  <span>${escapeHtml(promptPreview)}</span>
                  <strong>Показать весь промпт</strong>
                </summary>
                <pre>${escapeHtml(fullPrompt)}</pre>
              </details>
            ` : ''}
            ${event.errorMessage ? `<p class="dashboard-error">${escapeHtml(event.errorMessage)}</p>` : ''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

async function loadHistory() {
  elements.history.classList.add('empty-state');
  elements.history.innerHTML = 'Загрузка истории...';
  setStatus('Загрузка...');
  const data = await api('/api/dashboard/history');
  state.events = Array.isArray(data?.events) ? data.events : [];
  state.totals = data?.totals || {};
  renderHistory();
  setStatus('Готово');
}

elements.refreshButton?.addEventListener('click', () => {
  loadHistory().catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
});

elements.typeFilter?.addEventListener('change', renderHistory);

loadHistory().catch((error) => {
  console.error(error);
  elements.history.innerHTML = escapeHtml(error.message);
  setStatus('Ошибка');
});
