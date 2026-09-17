// 這一版的版本號。**單一來源。**
//
// 同一個字串必須同時出現在三個地方，而且完全一致：
//   1. 這裡（APP_VERSION）—— 執行期的程式碼看得到的版本
//   2. sw.js 的 VERSION —— 決定快取名稱與換版時機
//   3. index.html 裡 app.js 的 ?v= 參數 —— 決定瀏覽器的 HTTP 快取鍵
//
// 第 3 點是修掉「點按鈕跳回首頁」那個 bug 的關鍵：
// GitHub Pages 對每個檔案送 Cache-Control: max-age=600 而且沒有 revalidate，
// 瀏覽器的 HTTP 快取是**逐檔**計時的。Service Worker 還沒接手的那段時間
// （第一次載入、SW 被系統回收、剛換版），一個十分鐘前快取的 app.js 完全可能
// 跟一個剛抓下來的 view 湊在一起 —— 舊的路由表配新的畫面，按下去就找不到路。
// 把版本號放進網址，舊版與新版就是不同的快取鍵，混不起來。
//
// 改版本號用 `npm run bump -- <版本>`，它會一次改完三個地方；
// shelltest 會斷言三者一致，漏改一個就紅。

export const APP_VERSION = 'stockdiary-v0.7.20';

/** 給動態 import 與資源網址用的版本參數。 */
export const V = `?v=${APP_VERSION}`;
