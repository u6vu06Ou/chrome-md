/* 頁面端：把一張網頁抓下來、清乾淨、轉成 Markdown。
   這裡只「定義」工具，真正呼叫由背景端用 executeScript 觸發，
   這樣同一支程式可以注入到每個框（frame），再挑內容最多的那個用。

   關鍵做法：先在「原頁面」的每個元素上貼一個編號，再複製一份，
   之後就靠編號把「複製品」跟「原頁面」對起來——因為判斷元素可不可見、
   圖片真正的網址，都必須問原頁面才準；但複製品砍過東西後順序會變，
   用位置對會對錯。 */

(() => {
  if (window.__mdSaveExtract) return;

  const IDX_ATTR = 'data-md-idx';

  /* ---------- 1. 要丟掉的雜訊 ---------- */

  const DROP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'link', 'meta',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'canvas', 'svg', 'video', 'audio', 'source', 'track',
    'input', 'select', 'textarea', 'button', 'datalist', 'option',
    'map', 'area', 'base', 'param'
  ]);

  const DROP_SELECTORS = [
    'nav', 'aside', 'footer', 'form[role="search"]',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="search"]', '[role="complementary"]', '[role="dialog"]', '[role="alertdialog"]',
    '[aria-hidden="true"]', '[hidden]',
    '.ad', '.ads', '.advert', '.advertisement', '.adsbygoogle', '.sponsored',
    '.cookie', '.cookies', '.consent', '.gdpr', '.cookie-banner',
    '.popup', '.modal', '.overlay', '.lightbox', '.drawer',
    '.sidebar', '.side-bar', '.menu', '.navbar', '.nav-bar', '.topbar', '.site-header',
    '.breadcrumb', '.breadcrumbs', '.pagination', '.pager', '.paging',
    '.social', '.share', '.sharing', '.social-share', '.addthis',
    '.comment', '.comments', '.disqus', '.giscus', '.utterances',
    '.newsletter', '.subscribe', '.signup', '.related', '.recommend', '.recommended',
    '.toolbar', '.skip-link', '.screen-reader-text', '.visually-hidden', '.sr-only',
    '.mw-editsection', '.mw-jump-link', '.mw-indicators',
    '[class*="advert"]', '[id*="advert"]', '[class*="cookie-banner"]',
    '[class*="social-share"]', '[class*="addthis"]', '[class*="share-"]',
    '[class*="nav-menu"]', '[class*="site-nav"]', '[class*="menu-item"]'
  ];

  /* ---------- 2. 可能的「主要內容」區塊 ---------- */

  const CONTENT_SELECTORS = [
    'article', 'main', '[role="main"]',
    '#content', '#main', '#main-content', '#article', '#post', '#mw-content-text',
    '.content', '.main', '.main-content', '.article', '.article-content',
    '.post', '.post-content', '.entry', '.entry-content', '.markdown-body',
    '.rich-text', '.prose', '.text-content', '.body-content'
  ];

  function textLength(el) {
    const t = el.innerText || el.textContent || '';
    return t.replace(/\s+/g, ' ').trim().length;
  }

  function linkLength(el) {
    let n = 0;
    el.querySelectorAll('a').forEach((a) => {
      n += (a.innerText || a.textContent || '').length;
    });
    return n;
  }

  /* 「像不像正文」的分數：字多分數高；連結佔比越高扣越重（選單的特徵） */
  function contentScore(el) {
    const t = textLength(el);
    if (t < 200) return -1;
    const density = linkLength(el) / t;
    if (density > 0.7) return t * 0.05;
    return t * (1 - density);
  }

  function pickRoot(doc) {
    const body = doc.body;
    if (!body) return null;

    let best = null;
    let bestScore = -1;
    const seen = new Set();

    for (const sel of CONTENT_SELECTORS) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (_) { continue; }
      nodes.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const s = contentScore(el);
        if (s > bestScore) { bestScore = s; best = el; }
      });
      if (best && bestScore > 800) break;   // 已經夠像正文就不用再試
    }

    const bodyScore = contentScore(body);
    if (!best || bestScore < bodyScore * 0.6) return body;
    return best;
  }

  function isHidden(el, win) {
    let cs;
    try { cs = win.getComputedStyle(el); } catch (_) { return false; }
    if (!cs || !cs.display) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (cs.opacity !== '' && parseFloat(cs.opacity) === 0) return true;
    if (cs.height === '0px' && cs.overflow === 'hidden') return true;
    return false;
  }

  /* ---------- 3. 貼編號，建立「複製品 ↔ 原頁面」對照表 ---------- */

  function tagAndClone(root) {
    const origNodes = [root];
    root.setAttribute(IDX_ATTR, '0');
    root.querySelectorAll('*').forEach((el, i) => {
      el.setAttribute(IDX_ATTR, String(i + 1));
      origNodes.push(el);
    });

    const clone = root.cloneNode(true);

    // 對照表：複製品文件順序的每個元素 ↔ 原頁面元素
    const pairs = [];
    const cloneAll = [clone, ...clone.querySelectorAll('*')];
    for (const c of cloneAll) {
      const idx = parseInt(c.getAttribute(IDX_ATTR), 10);
      pairs.push({ clone: c, orig: isNaN(idx) ? null : origNodes[idx] });
    }
    // 清掉貼在原頁面上的編號，還原乾淨
    origNodes.forEach((el) => el.removeAttribute(IDX_ATTR));
    cloneAll.forEach((el) => el.removeAttribute(IDX_ATTR));

    return { clone, pairs, origNodes };
  }

  /* ---------- 4. 清理：丟雜訊、把網址補成完整的 ---------- */

  const GENERIC_LINK_TEXT = /^(編輯|编辑|修改|edit|編集|隱藏|隐藏|顯示|显示|hide|show|展開|展开|日本語|English|Deutsch|Français|Español)$/i;

  function resolveUrl(value, base) {
    if (!value) return '';
    try { return new URL(value, base).href; } catch (_) { return ''; }
  }

  function cleanup(pairs, doc, win) {
    const toRemove = [];

    for (const { clone: c, orig: o } of pairs) {
      if (!c || c.nodeType !== 1 || !c.parentNode) continue;
      const tag = c.tagName.toLowerCase();

      if (DROP_TAGS.has(tag)) { toRemove.push(c); continue; }
      if (o && isHidden(o, win)) { toRemove.push(c); continue; }

      // 標題後面那個小小的「編輯」連結，對讀者沒用
      if (tag === 'a') {
        const text = (c.textContent || '').trim();
        if (text && GENERIC_LINK_TEXT.test(text)) {
          const parentTag = c.parentNode && c.parentNode.tagName ? c.parentNode.tagName.toLowerCase() : '';
          if (/^h[1-6]$/.test(parentTag) || parentTag === 'dt' || parentTag === 'li') {
            toRemove.push(c);
            continue;
          }
        }
      }

      // 滑鼠移上去才看到的說明文字，在檔案裡只會變雜訊
      if (c.hasAttribute && c.hasAttribute('title')) c.removeAttribute('title');
      if (tag === 'a' || tag === 'img') {
        const target = tag === 'a' ? 'href' : 'src';
        if (o && o.hasAttribute && o.hasAttribute(target)) {
          const resolved = resolveUrl(o.getAttribute(target), doc.baseURI);
          if (resolved) c.setAttribute(target, resolved);
          else c.removeAttribute(target);
        }
      }
    }

    toRemove.forEach((n) => n.remove());

    // 選擇器型的規則（整棵子樹都算廣告／導覽的就靠這裡）
    for (const sel of DROP_SELECTORS) {
      try { pairs[0].clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch (_) {}
    }
  }

  function sweepEmpty(root) {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 3) {
      changed = false;
      root.querySelectorAll('div, span, section, p, li, td, ul, ol, dl').forEach((n) => {
        const hasText = n.textContent.replace(/\s+/g, '');
        if (hasText) return;
        if (n.querySelector('img, br, hr, table, pre, code, blockquote')) return;
        n.remove();
        changed = true;
      });
    }
  }

  /* ---------- 5. 圖片 ---------- */

  const MAX_IMAGE_BYTES = 1500 * 1024;
  const MAX_TOTAL_BYTES = 6000 * 1024;
  const MAX_IMAGE_COUNT = 60;   // 圖太多的頁面就只留網址，不要一張一張抓

  function mimeFromUrl(url) {
    const m = /\.(png|jpe?g|gif|webp|bmp|avif)(?:[?#]|$)/i.exec(url);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    if (ext === 'jpg') return 'image/jpeg';
    if (ext === 'jpeg') return 'image/jpeg';
    if (ext === 'avif') return 'image/avif';
    return `image/${ext}`;
  }

  function collectImages(pairs, doc) {
    const entries = [];
    const used = new Map();

    for (const { clone: c, orig: o } of pairs) {
      if (!c || c.nodeType !== 1 || !c.parentNode) continue;
      if (c.tagName.toLowerCase() !== 'img') continue;

      let url = (o && (o.currentSrc || o.getAttribute('src'))) || c.getAttribute('src') || '';
      if (url && !url.startsWith('data:')) url = resolveUrl(url, doc.baseURI);
      if (!url || /^(blob:|chrome-extension:|about:|moz-extension:)/i.test(url)) {
        c.remove();
        continue;
      }

      // 1x1 的追蹤像素，肉眼看不到，留著只是垃圾
      const w = (o && o.naturalWidth) || 0;
      const h = (o && o.naturalHeight) || 0;
      if (w > 0 && h > 0 && w <= 2 && h <= 2) { c.remove(); continue; }

      let token = used.get(url);
      if (!token) {
        token = `md-asset:${entries.length}`;
        used.set(url, token);
        entries.push({
          token,
          url,
          mime: url.startsWith('data:') ? (url.slice(5, url.indexOf(';')) || 'image/png') : mimeFromUrl(url),
          alt: (c.getAttribute('alt') || (o && o.getAttribute('alt')) || '').trim()
        });
      }
      c.setAttribute('src', token);
      ['srcset', 'sizes', 'loading', 'decoding'].forEach((a) => c.removeAttribute(a));
    }
    return entries;
  }

  function inlineDataUrls(assets) {
    assets.forEach((a) => {
      if (!a.url.startsWith('data:')) return;
      const comma = a.url.indexOf(',');
      if (comma < 0) return;
      a.mime = a.url.slice(5, a.url.indexOf(';')) || 'image/png';
      a.base64 = a.url.slice(comma + 1);
      a.bytes = Math.round(a.base64.length * 0.75);
    });
  }

  async function fetchAsBase64(assets) {
    inlineDataUrls(assets);
    const need = assets.filter((a) => !a.base64).slice(0, MAX_IMAGE_COUNT);
    if (!need.length) return;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'fetchImages',
        urls: need.map((a) => a.url),
        maxBytes: MAX_IMAGE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES
      });
    } catch (_) {
      return;   // 連絡不上背景就算了，圖留原始網址，至少還點得到
    }
    if (!response || !response.ok) return;

    const byUrl = new Map(response.images.map((r) => [r.url, r]));
    assets.forEach((a) => {
      if (a.base64) return;
      const r = byUrl.get(a.url);
      if (r && r.base64) {
        a.base64 = r.base64;
        a.mime = r.mime || a.mime || 'image/png';
        a.bytes = r.bytes;
      }
    });
  }

  /* ---------- 6. 轉檔 ---------- */

  /* 表格：一律轉成 Markdown 表格。
     現成的套件遇到「第一列不是標題列」的表格（例如維基百科右邊那種資訊框）
     會整坨原封不動塞成 HTML，一份文件瞬間多兩萬字。
     這裡改成自己畫：沒有標題列就補一列空的，欄數對不齊就補空白。 */
  function renderTable(node, service) {
    const rows = [];
    try { rows.push(...node.rows); } catch (_) { return ''; }
    if (!rows.length) return '';

    const extract = (cell) => {
      let text;
      try { text = service.turndown(cell.innerHTML); } catch (_) { text = cell.textContent || ''; }
      return text
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const matrix = rows.map((row) => {
      const out = [];
      [...row.cells].forEach((cell) => {
        out.push(extract(cell));
        // 合併欄位的格子，後面補空位，這樣每一列的欄數才會對齊
        const span = parseInt(cell.getAttribute('colspan') || '1', 10);
        for (let i = 1; i < span; i++) out.push('');
      });
      return { cells: out, allHeader: [...row.cells].every((c) => c.nodeName === 'TH') };
    });

    const cols = Math.max(...matrix.map((r) => r.cells.length), 1);
    const pad = (cells) => {
      const copy = cells.slice(0, cols);
      while (copy.length < cols) copy.push('');
      return copy;
    };

    let head;
    let body = matrix;
    if (matrix[0].allHeader) {
      head = pad(matrix[0].cells);
      body = matrix.slice(1);
    } else {
      head = new Array(cols).fill('');   // 沒有標題列就補一列空的
    }

    const lines = [
      '| ' + head.join(' | ') + ' |',
      '| ' + new Array(cols).fill('---').join(' | ') + ' |'
    ];
    body.forEach((r) => lines.push('| ' + pad(r.cells).join(' | ') + ' |'));

    return '\n\n' + lines.join('\n') + '\n\n';
  }

  function makeTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      br: '  '
    });

    // GFM 的刪除線、任務清單、程式碼區塊要高亮：只取這幾個，表格另外自己處理
    try {
      td.use([
        turndownPluginGfm.strikethrough,
        turndownPluginGfm.taskListItems,
        turndownPluginGfm.highlightedCodeBlock
      ]);
    } catch (_) {
      try { td.use(turndownPluginGfm.gfm); } catch (_) {}
    }

    // 表格自己畫（見上面 renderTable），蓋掉套件原本的行為
    td.addRule('mdTable', {
      filter: (node) => node.nodeName === 'TABLE',
      replacement: (content, node) => renderTable(node, td)
    });

    // 表格格子裡的換行，寫成 <br> 才不會把表格拆掉
    const inTableCell = (node) => {
      let p = node.parentNode;
      while (p && p.nodeName) {
        if (p.nodeName === 'TD' || p.nodeName === 'TH') return true;
        if (p.nodeName === 'TABLE') return false;
        p = p.parentNode;
      }
      return false;
    };
    td.addRule('tableCellBr', {
      filter: (node) => node.nodeName === 'BR' && inTableCell(node),
      replacement: () => '<br>'
    });

    // 只剩圖示的空連結，留著只會變一排沒內容的點
    td.addRule('emptyLink', {
      filter: (node) => node.nodeName === 'A'
        && !node.textContent.trim()
        && !node.querySelector('img'),
      replacement: () => ''
    });

    return td;
  }

  function tidy(markdown) {
    return markdown
      .replace(/ /g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '') + '\n';
  }

  /* ---------- 7. 主流程 ---------- */

  async function extract(mode) {
    const doc = document;
    if (!doc.body) return null;

    let sourceRoot = null;

    if (mode === 'selection') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        const holder = doc.createElement('div');
        holder.appendChild(sel.getRangeAt(0).cloneContents());
        if (holder.textContent.trim() || holder.querySelector('img, table')) sourceRoot = holder;
      }
    }

    if (!sourceRoot) sourceRoot = (mode === 'full') ? doc.body : pickRoot(doc);
    if (!sourceRoot) return null;

    const win = doc.defaultView || window;
    const { clone, pairs } = tagAndClone(sourceRoot);

    cleanup(pairs, doc, win);
    sweepEmpty(clone);

    const assets = collectImages(pairs, doc);
    sweepEmpty(clone);

    const holder = doc.createElement('div');
    holder.appendChild(clone);
    if (!holder.textContent.trim() && !holder.querySelector('img, table, hr')) return null;

    let markdown = tidy(makeTurndown().turndown(holder.innerHTML));
    if (!markdown || markdown.length < 40) return null;

    await fetchAsBase64(assets);

    return {
      markdown,
      assets: assets
        .filter((a) => a.base64)
        .map((a) => ({ token: a.token, url: a.url, mime: a.mime, base64: a.base64 })),
      title: (doc.title || '').trim(),
      url: location.href,
      frameUrl: location.href
    };
  }

  window.__mdSaveExtract = extract;
})();
