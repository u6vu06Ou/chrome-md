/* 暫存區：剛轉好的 Markdown 先放這裡，預覽頁再從這裡拿。
   放在擴充功能自己的空間（不是網頁的），所以任何一頁存進來都讀得到。
   只留最近一筆，不累積。背景端用 importScripts 叫它，預覽頁用 <script> 叫它。 */

var MdStore = (() => {
  const DB_NAME = 'chrome-md';
  const STORE = 'pending';
  const KEY = 'latest';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // 圖片存成逗號分隔的並排陣列，不寫欄位名，省空間也省時間
  function pack(record) {
    return {
      markdown: record.markdown,
      assets: record.assets || [],
      title: record.title,
      url: record.url,
      createdAt: record.createdAt,
      mode: record.mode
    };
  }

  return {
    save(record) { return run('readwrite', (s) => s.put(pack(record), KEY)); },
    get() { return run('readonly', (s) => s.get(KEY)); },
    clear() { return run('readwrite', (s) => s.delete(KEY)).catch(() => {}); }
  };
})();
