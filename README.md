# chrome-md

A Chrome extension that saves the current web page as Markdown (`.md`) — clean output for AI agents to read: real Markdown tables, absolutized links, headings/lists/code preserved, and nav/ads/cookie banners/comment sections stripped.

## Install (one time)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Select this folder

No build step, no dependencies — everything you need is in the repo.

## Use

| What you want | How |
|---|---|
| Save this page as `.md` | Click the toolbar icon, or `Ctrl+Shift+M` |
| Save only the selection | Select text → right-click → "Save as Markdown (selection)" |
| Force-save the whole page | Right-click → "Save as Markdown (full page)" |
| Save / print as PDF | On the preview tab: "Print / Save as PDF" or `Ctrl+P` |
| Download the `.md` file | On the preview tab: "Save .md" or `Ctrl+S` |

Clicking opens a **Markdown preview** tab. There, "Save .md" defaults to **not** embedding images (small file, ideal for agents); check "include images" to inline them as base64 (file gets much larger).

## Notes

- `chrome://` pages, the Web Store, Chrome's built-in PDF viewer and the new tab page can't be injected — the icon shows a ✕ there.
- `content/` is reserved; vendored libraries: [turndown](https://github.com/mixmark-io/turndown) (HTML→Markdown) and [marked](https://github.com/markedjs/marked) (Markdown→HTML preview), both MIT.

## 繁中簡版

把 Chrome 上的網頁存成 Markdown 檔，自動留在正文、表格變真表格、連結補成完整網址。
啟用：`chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選本資料夾。
用法：按工具列圖示或 `Ctrl+Shift+M` 存整頁；選字後按右鍵只存選取範圍；預覽頁可存 `.md`（預設不含圖片）或列印成 PDF。

## License

MIT
