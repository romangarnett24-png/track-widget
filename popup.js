const $ = id => document.getElementById(id);

const URLS = {
  cse: n => `https://www.cse.ru/mow/track/?numbers=${encodeURIComponent(n.trim())}`,
  major: n => `https://www.major-express.ru/useful-services/track/?type=1&tracking-number=${encodeURIComponent(n.trim())}&smart-token=`
};

const PAGE_TIMEOUT_MS = 28000;

let currentCarrier = 'cse';
let historyData = [];
let currentFilter = 'active'; // 'active' | 'archive'
let lastFullDebugText = '';
let isSearching = false;
let currentActiveParcel = null;
let isTextExpanded = false;

// Date formatter
function formatTimestamp(ts) {
  if (!ts) return 'только что';
  const d = new Date(ts);
  const now = new Date();
  const diffMinutes = Math.round((now - d) / 60000);
  if (diffMinutes < 1) return 'только что';
  if (diffMinutes < 60) return `${diffMinutes} мин назад`;
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  if (now.toDateString() === d.toDateString()) {
    return `Сегодня, ${hours}:${minutes}`;
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}, ${hours}:${minutes}`;
}

// Toast notification
let toastTimer = null;
function showToast(text) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// Set active carrier
function setCarrier(carrier) {
  currentCarrier = carrier === 'major' ? 'major' : 'cse';
  $('btn-carrier-cse').classList.toggle('active', currentCarrier === 'cse');
  $('btn-carrier-major').classList.toggle('active', currentCarrier === 'major');
  chrome.storage.local.set({ carrier: currentCarrier });
}

// Switch main tab (Поиск / Мои посылки)
function switchTab(tab) {
  if (tab === 'history') {
    $('nav-search').classList.remove('active');
    $('nav-history').classList.add('active');
    $('view-search').style.display = 'none';
    $('view-history').style.display = 'block';
    renderHistory();
  } else {
    $('nav-search').classList.add('active');
    $('nav-history').classList.remove('active');
    $('view-search').style.display = 'block';
    $('view-history').style.display = 'none';
  }
}

// Switch history sub-filter (Активные / Архив)
function switchHistoryFilter(filter) {
  currentFilter = filter === 'archive' ? 'archive' : 'active';
  $('btn-filter-active').classList.toggle('active', currentFilter === 'active');
  $('btn-filter-archive').classList.toggle('active', currentFilter === 'archive');
  renderHistory();
}

// Update input clear button
function updateClearButton() {
  const val = $('num').value.trim();
  $('btn-clear').style.display = val ? 'flex' : 'none';
}

// Update counters across UI
function updateCounters() {
  const activeCount = historyData.filter(h => !h.isDelivered).length;
  const archiveCount = historyData.filter(h => h.isDelivered).length;

  $('count-active').textContent = activeCount;
  $('count-archive').textContent = archiveCount;
  $('history-count').textContent = activeCount;
}

// Load storage on startup
chrome.storage.local.get(['carrier', 'num', 'parcel_history'], s => {
  if (s.carrier) setCarrier(s.carrier);
  if (s.num) {
    $('num').value = s.num;
    updateClearButton();
  }
  if (Array.isArray(s.parcel_history)) {
    historyData = s.parcel_history;
  }
  updateCounters();
});

// Fetch webpage text via background tab with 28s timeout
function getPageText(url) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    let finished = false;
    let listener = null;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(new Error('Превышено время ожидания ответа от сайта (28 сек). Возможно, сайт медленно отвечает или требует капчу.'));
      }
    }, PAGE_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      if (listener) {
        chrome.tabs.onUpdated.removeListener(listener);
        listener = null;
      }
      if (tabId !== null) {
        chrome.tabs.remove(tabId).catch(() => {});
        tabId = null;
      }
    }

    chrome.tabs.create({ url, active: false }, tab => {
      if (chrome.runtime.lastError || !tab) {
        cleanup();
        return reject(new Error('Не удалось открыть фоновую вкладку для проверки.'));
      }
      tabId = tab.id;

      listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          setTimeout(async () => {
            if (finished) return;
            try {
              const [r] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => (document.body ? document.body.innerText : '')
              });
              finished = true;
              cleanup();
              resolve(r?.result || '');
            } catch (e) {
              finished = true;
              cleanup();
              reject(new Error('Ошибка при чтении данных: ' + e.message));
            }
          }, 2400);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// Extract tracking content as-is starting from the shipment header
function extractTrackingContent(rawText) {
  if (!rawText) return 'Информация по трек-номеру не получена.';

  // Find start of tracking info
  const startMatch = rawText.match(/(?:Накладная\s*(?:№|N|\b)|Откуда\s*:|Статус доставки\s*:|Результат отслеживания)/i);
  let content = rawText;
  if (startMatch && startMatch.index !== undefined) {
    content = rawText.slice(startMatch.index);
  }

  // Trim bottom legal footer if present, but only if far down
  const footerMatch = content.match(/(?:©\s*\d{4}|Все права защищены|Политика конфиденциальности|ООО «Курьер Сервис Экспресс»)/i);
  if (footerMatch && footerMatch.index && footerMatch.index > 80) {
    content = content.slice(0, footerMatch.index);
  }

  // Normalize repeated newlines without losing event details
  content = content.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return content || rawText.trim();
}

// Toggle text expand/collapse
function setExpandState(expanded) {
  isTextExpanded = expanded;
  const textEl = $('res-tracking-text');
  const btnText = $('btn-toggle-expand-text');

  if (isTextExpanded) {
    textEl.classList.remove('collapsed');
    textEl.classList.add('expanded');
    btnText.textContent = 'Свернуть историю ▲';
  } else {
    textEl.classList.remove('expanded');
    textEl.classList.add('collapsed');
    btnText.textContent = 'Развернуть всю историю ▼';
  }
}

// Display Result in Search View
function displayResult(parcel) {
  currentActiveParcel = parcel;

  $('result-card').style.display = 'flex';
  $('alert-banner').style.display = 'none';

  // Carrier tag
  $('res-carrier-tag').textContent = parcel.carrier.toUpperCase();
  $('res-carrier-tag').className = `history-carrier-tag tag-${parcel.carrier}`;

  // Track num
  $('res-track-num').textContent = parcel.num;

  // As-is tracking text
  const trackingText = parcel.trackingContent || parcel.rawText || 'Данные не найдены.';
  $('res-tracking-text').textContent = trackingText;

  // Reset expand to collapsed by default
  setExpandState(false);

  // User manual status badge & toggle button
  updateManualStatusUI(parcel.isDelivered);

  // Timestamp & official link
  $('res-update-time').textContent = 'Проверено: ' + formatTimestamp(parcel.checkedAt);
  const link = $('res-carrier-link');
  link.href = URLS[parcel.carrier](parcel.num);
  link.title = `Открыть сайт ${parcel.carrier.toUpperCase()}`;

  // Debug box text
  lastFullDebugText = parcel.rawText || '';
  $('debug-box').textContent = lastFullDebugText;
}

// Update manual status UI (badge & toggle button)
function updateManualStatusUI(isDelivered) {
  const badge = $('res-user-badge');
  const dot = $('res-user-dot');
  const statusText = $('res-user-status-text');
  const hint = $('res-status-hint');
  const btn = $('res-btn-toggle');
  const btnText = $('res-btn-toggle-text');

  if (isDelivered) {
    badge.className = 'status-badge badge-delivered';
    dot.className = 'dot-delivered';
    statusText.textContent = 'Выдано';
    hint.textContent = 'Посылка находится в Архиве';

    btn.className = 'btn-toggle-status btn-mark-pending';
    btnText.textContent = 'Вернуть в активные';
  } else {
    badge.className = 'status-badge badge-pending';
    dot.className = 'dot-pending';
    statusText.textContent = 'Не выдано';
    hint.textContent = 'По умолчанию — не выдано';

    btn.className = 'btn-toggle-status btn-mark-delivered';
    btnText.textContent = 'Отметить как выдано';
  }
}

// Toggle manual status of currently viewed parcel
function toggleCurrentParcelStatus() {
  if (!currentActiveParcel) return;

  currentActiveParcel.isDelivered = !currentActiveParcel.isDelivered;

  // Update in historyData
  const item = historyData.find(
    h => h.carrier === currentActiveParcel.carrier && h.num.toLowerCase() === currentActiveParcel.num.toLowerCase()
  );
  if (item) {
    item.isDelivered = currentActiveParcel.isDelivered;
    chrome.storage.local.set({ parcel_history: historyData });
  }

  updateManualStatusUI(currentActiveParcel.isDelivered);
  updateCounters();

  if (currentActiveParcel.isDelivered) {
    showToast('Посылка отмечена как «Выдано» и перенесена в Архив');
  } else {
    showToast('Посылка возвращена в «Активные (Не выдано)»');
  }
}

// Save or Update History
function saveHistoryItem(parcel) {
  const existingIdx = historyData.findIndex(
    h => h.carrier === parcel.carrier && h.num.toLowerCase() === parcel.num.toLowerCase()
  );

  if (existingIdx !== -1) {
    // Keep user's existing manual delivery status if already set!
    parcel.isDelivered = historyData[existingIdx].isDelivered;
    historyData.splice(existingIdx, 1);
  } else {
    // Default for new parcel is always NOT DELIVERED (false)
    parcel.isDelivered = false;
  }

  historyData.unshift(parcel);
  if (historyData.length > 50) historyData.pop();

  chrome.storage.local.set({ parcel_history: historyData });
  updateCounters();
}

// Render History List based on currentFilter ('active' or 'archive')
function renderHistory() {
  const list = $('history-list');
  const emptyActive = $('history-empty-active');
  const emptyArchive = $('history-empty-archive');

  const isArchive = currentFilter === 'archive';
  const filtered = historyData.filter(h => isArchive ? h.isDelivered : !h.isDelivered);

  if (isArchive) {
    emptyActive.style.display = 'none';
    emptyArchive.style.display = filtered.length ? 'none' : 'flex';
  } else {
    emptyArchive.style.display = 'none';
    emptyActive.style.display = filtered.length ? 'none' : 'flex';
  }

  list.innerHTML = '';

  filtered.forEach(item => {
    const card = document.createElement('div');
    card.className = 'history-item';

    // Top row: Carrier, Num, Status Badge
    const top = document.createElement('div');
    top.className = 'history-item-top';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '6px';

    const tag = document.createElement('span');
    tag.className = `history-carrier-tag tag-${item.carrier}`;
    tag.textContent = item.carrier.toUpperCase();

    const numSpan = document.createElement('span');
    numSpan.className = 'history-track-num';
    numSpan.textContent = item.num;

    left.appendChild(tag);
    left.appendChild(numSpan);

    const badge = document.createElement('span');
    badge.className = `status-badge ${item.isDelivered ? 'badge-delivered' : 'badge-pending'}`;
    badge.innerHTML = `<span class="${item.isDelivered ? 'dot-delivered' : 'dot-pending'}"></span><span>${item.isDelivered ? 'Выдано' : 'Не выдано'}</span>`;

    top.appendChild(left);
    top.appendChild(badge);

    // Mid: Snippet from as-is tracking text (first 2-3 lines)
    const mid = document.createElement('div');
    mid.className = 'history-item-snippet';
    const lines = (item.trackingContent || item.rawText || '').split('\n').filter(Boolean);
    mid.textContent = lines.slice(0, 3).join('\n') || 'Данные сохранены';

    // Bottom row: Updated time & Actions
    const bottom = document.createElement('div');
    bottom.className = 'history-item-bottom';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = 'Проверено: ' + formatTimestamp(item.checkedAt);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    // Toggle button (Выдано / В активные)
    const btnToggle = document.createElement('button');
    btnToggle.className = `btn-card-toggle ${item.isDelivered ? 'unarchive' : 'mark-del'}`;
    btnToggle.innerHTML = item.isDelivered
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg> В активные`
      : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Выдано`;
    btnToggle.onclick = e => {
      e.stopPropagation();
      item.isDelivered = !item.isDelivered;
      chrome.storage.local.set({ parcel_history: historyData });
      updateCounters();
      renderHistory();
      showToast(item.isDelivered ? 'Перенесено в Архив' : 'Возвращено в Активные');
    };

    // Refresh action
    const btnRefresh = document.createElement('button');
    btnRefresh.className = 'history-action-btn';
    btnRefresh.title = 'Обновить с сайта';
    btnRefresh.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    btnRefresh.onclick = e => {
      e.stopPropagation();
      setCarrier(item.carrier);
      $('num').value = item.num;
      updateClearButton();
      switchTab('search');
      run(false);
    };

    // Copy action
    const btnCopy = document.createElement('button');
    btnCopy.className = 'history-action-btn';
    btnCopy.title = 'Скопировать номер';
    btnCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    btnCopy.onclick = e => {
      e.stopPropagation();
      navigator.clipboard.writeText(item.num).then(() => showToast('Номер скопирован: ' + item.num));
    };

    // Delete action
    const btnDel = document.createElement('button');
    btnDel.className = 'history-action-btn btn-del';
    btnDel.title = 'Удалить';
    btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    btnDel.onclick = e => {
      e.stopPropagation();
      historyData = historyData.filter(h => !(h.carrier === item.carrier && h.num === item.num));
      chrome.storage.local.set({ parcel_history: historyData });
      updateCounters();
      renderHistory();
      showToast('Удалено');
    };

    actions.appendChild(btnToggle);
    actions.appendChild(btnRefresh);
    actions.appendChild(btnCopy);
    actions.appendChild(btnDel);

    bottom.appendChild(time);
    bottom.appendChild(actions);

    card.appendChild(top);
    card.appendChild(mid);
    card.appendChild(bottom);

    // Clicking card opens details in search tab
    card.onclick = () => {
      setCarrier(item.carrier);
      $('num').value = item.num;
      updateClearButton();
      switchTab('search');
      displayResult(item);
    };

    list.appendChild(card);
  });
}

// Search execution
async function run(debugMode) {
  if (isSearching) return;

  const carrier = currentCarrier;
  const num = $('num').value.trim();

  if (!num) {
    $('alert-banner').style.display = 'flex';
    $('alert-title').textContent = 'Трек-номер не указан';
    $('alert-msg').textContent = 'Пожалуйста, введите номер накладной перед поиском.';
    $('num').focus();
    return;
  }

  // Save current input
  chrome.storage.local.set({ carrier, num });

  // UI loading state
  isSearching = true;
  $('go').disabled = true;
  $('go-text').textContent = 'Загрузка...';
  $('icon-search').outerHTML = `<div id="icon-search" class="spinner"></div>`;
  $('alert-banner').style.display = 'none';

  $('result-card').style.display = 'flex';
  $('res-carrier-tag').textContent = carrier.toUpperCase();
  $('res-carrier-tag').className = `history-carrier-tag tag-${carrier}`;
  $('res-track-num').textContent = num;
  $('res-tracking-text').textContent = 'Подключение к сайту перевозчика и считывание накладной...';

  try {
    const rawText = await getPageText(URLS[carrier](num));
    const trackingContent = extractTrackingContent(rawText);

    // Check if parcel already exists to preserve manual status
    const existing = historyData.find(
      h => h.carrier === carrier && h.num.toLowerCase() === num.toLowerCase()
    );

    const parcel = {
      carrier,
      num,
      trackingContent,
      isDelivered: existing ? existing.isDelivered : false, // Default: NOT DELIVERED
      checkedAt: Date.now(),
      rawText
    };

    displayResult(parcel);
    saveHistoryItem(parcel);

    if (debugMode) {
      $('debug-box').style.display = 'block';
    }
  } catch (err) {
    $('result-card').style.display = 'none';
    $('alert-banner').style.display = 'flex';
    $('alert-title').textContent = 'Ошибка проверки';
    $('alert-msg').textContent = err.message || 'Не удалось получить данные с сайта.';
  } finally {
    isSearching = false;
    $('go').disabled = false;
    $('go-text').textContent = 'Найти';
    const spinner = $('icon-search');
    if (spinner) {
      spinner.outerHTML = `<svg id="icon-search" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
    }
  }
}

// Toggle debug view
function toggleDebug() {
  const box = $('debug-box');
  const isHidden = box.style.display === 'none' || !box.style.display;
  box.style.display = isHidden ? 'block' : 'none';
  if (isHidden && !lastFullDebugText) {
    box.textContent = 'Данные еще не получены. Нажмите «Найти», чтобы выполнить запрос.';
  }
}

// Event Listeners
$('nav-search').onclick = () => switchTab('search');
$('nav-history').onclick = () => switchTab('history');

$('btn-filter-active').onclick = () => switchHistoryFilter('active');
$('btn-filter-archive').onclick = () => switchHistoryFilter('archive');

$('btn-carrier-cse').onclick = () => setCarrier('cse');
$('btn-carrier-major').onclick = () => setCarrier('major');

$('num').oninput = updateClearButton;
$('num').onkeydown = e => {
  if (e.key === 'Enter') run(false);
};

$('btn-clear').onclick = () => {
  $('num').value = '';
  updateClearButton();
  $('num').focus();
};

$('btn-paste').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $('num').value = text.trim();
      updateClearButton();
      showToast('Вставлено из буфера');
    }
  } catch (e) {
    showToast('Нет доступа к буферу');
  }
};

$('res-copy-btn').onclick = () => {
  const num = $('res-track-num').textContent;
  if (num && num !== '-') {
    navigator.clipboard.writeText(num).then(() => showToast('Номер скопирован: ' + num));
  }
};

$('btn-toggle-expand').onclick = () => setExpandState(!isTextExpanded);
$('res-btn-toggle').onclick = toggleCurrentParcelStatus;

$('go').onclick = () => run(false);
$('dbg').onclick = toggleDebug;
$('alert-retry-btn').onclick = () => run(false);

$('btn-clear-history').onclick = () => {
  const isArchive = currentFilter === 'archive';
  const targetName = isArchive ? 'Архив (Выдано)' : 'Активные (Не выдано)';
  if (confirm(`Очистить список: ${targetName}?`)) {
    historyData = historyData.filter(h => isArchive ? !h.isDelivered : h.isDelivered);
    chrome.storage.local.set({ parcel_history: historyData });
    updateCounters();
    renderHistory();
    showToast('Список очищен');
  }
};
