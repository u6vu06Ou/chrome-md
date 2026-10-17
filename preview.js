/* 預覽頁：把剛轉好的 Markdown 畫成一般網頁。
   兩個出口：
     ① 儲存 .md  → 存原始檔，給 agent 讀
     ② 列印 / 另存 PDF → 用瀏覽器原生列印對話框印排版好的內容 */

/* 介面文字跟著瀏覽器語言走（_locales）；HTML 裡的繁中字串當預設。 */
(function localizeChromeUi() {
  if (typeof chrome === 'undefined' || !chrome.i18n) return;
  const t = (sel, key, attr) => {
    const msg = chrome.i18n.getMessage(key);
    if (!msg) return;
    const el = document.getElementById(sel);
    if (!el) return;
    if (attr) el.setAttribute(attr, msg); else el.textContent = msg;
  };
  t('hint', 'preparing');
  t('withImagesText', 'withImages');
  t('withImagesTip', 'withImagesTip', 'title');
  t('save', 'saveMd');
  t('pdf', 'printPdf');
  const msg = chrome.i18n.getMessage('previewTitle');
  if (msg) {
    const title = document.querySelector('#bar .title');
    if (title) title.textContent = msg;
    document.title = msg;
  }
})();

const tokenPattern = /\]\(md-asset:[^)]+\)/g;

let current = null;

/* 把圖片代號換掉。兩種版本：
     ① 嵌圖版：圖片變成一大串資料塞進檔案，離線也看得到，但檔案很大
     ② 連外版：只留圖片的原始網址，檔案小、給 AI 讀剛好
   預覽畫面用嵌圖版（這樣列印、存 PDF 才有圖）。 */
function hydrateImages(markdown, assets) {
  if (!assets || !assets.length) return { inlined: markdown, linked: markdown };
  const byToken = new Map(assets.map((a) => [a.token, a]));
  let inlined = markdown;
  let linked = markdown;

  markdown.replace(tokenPattern, (whole) => {
    const asset = byToken.get(whole.slice(2, -1));
    if (!asset) return whole;
    linked = linked.replace(whole, `](${asset.url})`);
    if (!asset.base64) return whole;
    inlined = inlined.replace(whole, `](data:${asset.mime || 'image/png'};base64,${asset.base64})`);
    return whole;
  });

  return { inlined, linked };
}

/* 頁面內容是從別的網站抄來的，畫之前先拆掉危險的東西 */
function sanitize(root) {
  root.querySelectorAll('script, style, iframe, frame, object, embed, link, meta, form, base')
    .forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on')) { n.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        n.removeAttribute(attr.name);
      }
    }
    if (n.tagName === 'A') {
      n.setAttribute('target', '_blank');
      n.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return root;
}

function safeName(text) {
  return (text || '網頁')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80) || '網頁';
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showMessage(html) {
  const doc = document.getElementById('doc');
  doc.innerHTML = `<p class="meta">${html}</p>`;
  document.getElementById('hint').textContent = '';
  document.getElementById('save').disabled = true;
  document.getElementById('pdf').disabled = true;
  document.documentElement.dataset.ready = '1';
}

function buildMarkdownFile() {
  const withImages = document.getElementById('withImages').checked;
  const header =
    `<!-- 來源：${current.url}\n` +
    `     標題：${current.rawTitle}\n` +
    `     擷取時間：${current.createdAt} -->\n\n`;
  return header + (withImages ? current.inlined : current.linked);
}

async function main() {
  const params = new URLSearchParams(location.search);

  let record = null;
  try {
    record = await MdStore.get();
  } catch (err) {
    showMessage('讀取暫存內容失敗。請回原網頁重新轉一次。');
    return;
  }

  if (!record || !record.markdown) {
    showMessage('目前沒有內容。<br>請回到要儲存的網頁，重新按一次『另存為 Markdown』。');
    return;
  }

  const { inlined, linked } = hydrateImages(record.markdown, record.assets);
  const title = safeName(record.title);

  current = {
    markdown: linked,
    inlined,
    linked,
    assets: record.assets || [],
    url: record.url || '',
    rawTitle: record.title || '',
    title,
    createdAt: record.createdAt || new Date().toLocaleString('zh-TW', { hour12: false })
  };

  const rendered = document.createElement('div');
  rendered.innerHTML = marked.parse(inlined, { gfm: true, breaks: false });
  sanitize(rendered);

  // 在最前面補一段出處，列印出來才曉得這份是哪來的
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${current.rawTitle || title}　|　${current.url}　|　${current.createdAt}`;
  rendered.prepend(meta);

  const doc = document.getElementById('doc');
  doc.textContent = '';
  doc.appendChild(rendered);

  document.title = `${title} — Markdown`;
  const imgCount = current.assets.filter((a) => a.base64).length;
  document.getElementById('hint').textContent =
    `${linked.length.toLocaleString()} 字元　圖片 ${imgCount} 張`;

  // 等圖片（base64）就緒，列印或截圖才不會缺圖
  await Promise.all([...doc.querySelectorAll('img')].map((img) =>
    img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));

  document.documentElement.dataset.ready = '1';

  if (params.get('print') === '1') setTimeout(() => window.print(), 250);
}

document.addEventListener('DOMContentLoaded', () => {
  main();

  document.getElementById('save').addEventListener('click', () => {
    if (!current) return;
    download(`${current.title}.md`, buildMarkdownFile());
  });

  document.getElementById('pdf').addEventListener('click', () => {
    if (!current) return;
    window.print();
  });

  // Ctrl+S 直接存 .md，不要跳出「儲存網頁」那個對話框
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (current) download(`${current.title}.md`, buildMarkdownFile());
    }
  });
});
