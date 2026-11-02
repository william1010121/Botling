網頁預覽卡片：把一頁式 HTML 結果直接縮小預覽在對話裡，附上標題和「開啟」按鈕，按下就用自己的視窗開成全尺寸。用 `<show name="網頁預覽卡片">JSON</show>` 叫出來。

## 資料格式（window.ccb.data）

```json
{
  "path": "/Users/me/project/.bot/artifacts/competitor-report.html",
  "title": "競品比較報告"
}
```

- `path`：HTML 檔的完整路徑，也可以寫 `file://` 網址或 `~/` 開頭的路徑。
- `title`：卡片上的標題；省略時用檔名。
- `src`、`url`、`name`、`missing` 由 App 自己補上，不用寫。檔案不存在時卡片會顯示「找不到這個檔案」。

## 什麼時候用

- 回覆裡連到 `artifacts` 資料夾裡 .html 的連結，例如 `[競品比較](file:///…/.bot/artifacts/report.html)`，App 會自動畫成這張卡片，照常附連結就好，不必另外寫 `<show>`。
- 想換卡片標題，或頁面不在 `artifacts` 資料夾時，才用 `<show>`。不在 `artifacts` 裡的頁面只會載入那一個檔案，旁邊的圖片不會顯示。
- 一則回覆可以有好幾個 `<show>`，各自畫在寫的位置。
- 不需要使用者回答，不會呼叫 `ccb.answer`。