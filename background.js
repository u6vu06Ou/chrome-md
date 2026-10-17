/* 後勤：收到「要存了」的指令後，把工具注入頁面、挑出最好的結果、
   存進暫存區，再把預覽分頁打開。順便幫頁面去抓圖片。 */

importScripts('store.js');

const PREVIEW_PAGE = 'preview.html';
const SCRIPTS = [
  'vendor/turndown.js',
  'vendor/turndown-plugin-gfm.js',
  'content.js'
];

/* ---------- 小工具 ---------- */

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function guessMime(url) {
  const m = /\.(png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#]|$)/i.exec(url);
  if (!m) return 'image/png';
  const ext = m[1].toLowerCase();
  return ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
}

let badgeTimer = null;
function badge(text, title, revertMs) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: text === '✕' ? '#b91c1c' : '#2563eb' });
  if (title !== undefined) chrome.action.setTitle({ title });
  if (badgeTimer) clearTimeout(badgeTimer);
  if (revertMs) {
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: '另存為 Markdown（Ctrl+Shift+M）' });
    }, revertMs);
  }
}

/* ---------- 抓圖（給頁面端呼叫） ---------- */

const imageCache = new Map(); // 同一張圖不重複抓

async function fetchOne(url, maxBytes) {
  if (imageCache.has(url)) return imageCache.get(url);
  let entry;
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('空檔案');
    if (buf.byteLength > maxBytes) throw new Error('圖太大');
    let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(mime)) mime = guessMime(url);
    entry = { url, mime, base64: bytesToBase64(buf), bytes: buf.byteLength };
  } catch (err) {
    entry = { url, error: String((err && err.message) || err) };
  }
  imageCache.set(url, entry);
  return entry;
}

async function fetchImages(urls, maxBytes, maxTotalBytes) {
  const out = [];
  let total = 0;
  for (const url of urls) {
    const entry = await fetchOne(url, maxBytes);
    if (entry.base64) {
      if (total + entry.bytes > maxTotalBytes) continue;
      total += entry.bytes;
    }
    out.push(entry);
  }
  return out;
}

/* ---------- 主要流程 ---------- */

async function injectTools(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: SCRIPTS,
    injectImmediately: true
  });
}

async function runExtract(tabId, mode) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (m) => {
      if (typeof window.__mdSaveExtract !== 'function') return null;
      try { return await window.__mdSaveExtract(m); } catch (_) { return null; }
    },
    args: [mode],
    injectImmediately: true
  });

  // 每一頁框都會回一份，挑內容最多的那個
  let best = null;
  for (const r of results || []) {
    const value = r && r.result;
    if (!value || !value.markdown) continue;
    if (!best || value.markdown.length > best.markdown.length) best = value;
  }
  return best;
}

async function openPreview() {
  const url = chrome.runtime.getURL(PREVIEW_PAGE);
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.reload(tab.id);
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return tab.id;
}

async function convert(tabId, mode) {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  if (!tabId) return;

  badge('…', '正在轉換…', 0);
  try {
    await injectTools(tabId);
    const result = await runExtract(tabId, mode || 'default');

    if (!result) {
      badge('✕', '這一頁沒有抓到可轉換的內容（可能是 PDF 檢視器、擴充功能商店或空白頁）', 4000);
      return;
    }

    const record = {
      markdown: result.markdown,
      assets: (result.assets || []).filter((a) => a.base64),
      title: result.title || '網頁',
      url: result.url || '',
      createdAt: new Date().toLocaleString('zh-TW', { hour12: false }),
      mode: mode || 'default'
    };

    await MdStore.save(record);
    await openPreview();

    const kb = Math.round(record.markdown.length / 1024);
    badge('✓', `已轉換：${kb} KB，圖片 ${record.assets.length} 張`, 2500);
  } catch (err) {
    badge('✕', '無法在這一頁執行（Chrome 內建頁面、擴充功能商店、PDF 檢視器等不能注入）', 4000);
  }
}

/* ---------- 事件 ---------- */

chrome.action.onClicked.addListener((tab) => convert(tab.id, 'default'));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-as-md') convert(tab && tab.id, 'default');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'fetchImages') {
    fetchImages(msg.urls || [], msg.maxBytes || 1500000, msg.maxTotalBytes || 6000000)
      .then((images) => sendResponse({ ok: true, images }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 非同步回覆
  }
  if (msg && msg.type === 'getLastResult') {
    MdStore.get().then((r) => sendResponse({ ok: true, record: r || null }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'md-page',
      title: '另存為 Markdown（整頁）',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'md-selection',
      title: '另存為 Markdown（只存選取範圍）',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'md-page') convert(tab.id, 'full');
  if (info.menuItemId === 'md-selection') convert(tab.id, 'selection');
});
