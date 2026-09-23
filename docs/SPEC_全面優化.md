# SPEC：StockDiary 自主全面優化（稽核結論 ＋ A／B 分級計畫）

- 日期：2026-09-17
- 規劃：Fable 5.1（統籌 Session）。實作：StockDiary 的 Opus 5 Session。
- **實作完成（2026-09-18，線上 `stockdiary-v0.7.22`）**：A 級 17 項全部完成（批次 1＝v0.7.16、2＝v0.7.17、3＝v0.7.20、4＝v0.7.22）；B2、B3 完成；B1 不做；**B4 仍待 Yolin 實機測試**。偏離本文件的地方（B2 對照組改法、A11 保留 subscribe／setCap／hasKey／money.ratio、A14 只做指定的 27 條）記在 `docs/STATUS.md`「被否決的方案」與批次 4 那一節。
- 狀態：**定案（Yolin 2026-09-17 拍板：「都照建議實作」）。** A 級 17 項全部做、照 §8 四批次；B2 做、B3 做替代方案、B1 不做、B4 待 Yolin 實機測試後再決定。決策紀錄見 §7。
- 稽核對象：`stockdiary-v0.7.15`（commit `643ce73`，2026-09-16），工作區乾淨。

---

## 0. 硬性限制（每一項工作都適用，寫在最前面）

1. **成本／損益對帳數學凍結。** 在 Yolin 提供備份 JSON 與券商手續費折數之前，**不碰**下列檔案裡的任何算術，連過期註解也不改：
   `js/avgcost.js` 全部；`js/settle.js` 全部；`js/holdings.js` 的 `recomputeAvgCost`／`setAvgCost`／`confirmChange`；
   `js/plans.js` 的 `estimateDca`／`generatePending`／`generateReinvest`；`js/dividend.js` 的 `dividendAmount`／`stockDividendShares`／`dividendSummary`／`refPriceFromExValue`／`refPriceFromForecast`；
   `js/events.js` 的 `confirm`／`quoteExtrasFor`；`js/calc.js` 的 `simulate`／`compareMulti`／`displayTotals`；`js/money.js` 全部。
   本計畫裡沒有任何一項會改到這些函式；若實作時發現非改不可，**停下來回報**，不要順手改。
2. **不做任何投資建議、不碰下單／轉帳等金融操作**（STATUS 常設規則 6、7）。本計畫沒有任何一項新增判斷性文案；新文案一律走 `calcviewtest`／`insighttest` 的禁用詞掃描。
3. **測試紀律照 STATUS**：每條新斷言用突變證明會紅、不寫假斷言、檢查器有對照組、母體非空、含 regex 的測試碼用 Write 工具寫檔（慣例 30）、平常只跑受影響的測試、全面檢測由 Yolin 叫。
4. **不用互動式提示框**；需要 Yolin 決定的事純文字列出（本文件 §7）。
5. 每一項 A 級工作**獨立 commit、獨立 bump**，回報時逐項對照本文件編號。

---

## 1. 稽核方法與基線量測

不憑感覺列項目：每一項都對得到下面某一個數字或程式位置。

### 1.1 讀過的東西
- 全部程式：`js/*.js`（31 支）、`js/views/*.js`（8 支）、`css/style.css`、`sw.js`、`index.html`、`manifest.webmanifest`、`workers/*`。
- 文件：`docs/STATUS.md`（587 行）、`PLAN.md`、`README.md`、`實機驗收_v0.7.9.md`、`package.json`。
- 測試基礎設施：`scripts/mutationtest.mjs`、`assert-audit.jsonl`（上次全面檢測的斷言清單）。

### 1.2 量到的數字

| 項目 | 數字 | 意義 |
|---|---|---|
| SW SHELL 資產 | 46 個檔，**771 KB**（JS 353 KB、`data/` 361 KB、CSS 22 KB） | `data/stocks.json` 247 KB 佔三分之一；所有 `js/` 檔都在 SHELL 清單裡，沒有漏 |
| 快速 Node 測試（10 支） | 全綠，691 項通過（roc 54、fmt 31、parse 79、settle 101、changes 36、dividend 126、plan 92、calc 94、throttle 21、data 57） | 基線是綠的 |
| `npm test` 鏈 | 27 支 ＋ `mutationtest` | 與 README 的 27 支一致（**這是 2026-09-17 盤點當下的數字**；之後的數字以 `package.json` 的 `test` 鏈扣掉 `mutationtest` 為準，由 `doctest` 從程式數出來盯著，這裡不寫死） |
| 突變條數 | **182 條**（`mutationtest.mjs` 裡有 `find:` 的項目） | STATUS 寫 138、README 寫 138、上線檢查清單寫 **110 條／25 支** → 文件漂移 |
| `assertaudit` 母體 ≤ 2 的斷言 | uikittest 11、pathtest 7、calcviewtest 5、holdingtest 4，其餘 ≤ 3 | 慣例 12 要複查的候選 |
| 靜態資料日期 | `stocks.json` 2026-09-11（2,768 檔、ETF 360）；`calendar.json` **只有 2026 年**（243 個交易日）；`dividends.json` 2026-09-11 | 三份都不會自己更新；日曆跨年就失效（§3 A1） |
| 靜態掃描 | `TODO/FIXME` 0；`!important` 0；`console.*` 2（都是 `console.error`，合理）；`catch {}` 靜默 19 處（逐條看過，都有註解說明理由）；inline `style:` 6 處；`:focus-visible` **0 處**；`inert`／focus trap **0 處**；`aria-*` 13 處；`target: '_blank'` 缺 `rel` **1 處**（`js/views/news.js:197`） | 見 §3 A3～A8 |
| 沒有被 App 任何地方呼叫的匯出 | 95 個，其中 **83 個只有測試在用**（正常，純函式給測試用），**12 個完全沒人用**：`store.subscribe`／`notifyChanged`（呼叫了但零訂閱者）、`secrets.setCap`、`secrets.hasKey`、`holdings.allChanges`／`allPending`、`prices.getCloses`、`money.ratio`、`router.resetHistory`／`navRestoredScroll`、`store.expectedSettleDate`／`isTodayPending`、`insight.CONSENT_KEY` | 其中 `setCap` 是**畫面承諾了卻沒做**（§3 A10）；`subscribe` 是死 API（A11） |
| 重複的小工具 | `divRound` ×2（dividend.js、plans.js）、`roundToYuanMicro` ×2（dividend.js、calc.js，而 money.js 已有一模一樣的 `roundToYuan`）、`newId` ×2（holdings.js、plans.js）、`KIND_LABEL` ×3（dividend.js 語意不同；views/holding.js 與 views/plans.js 完全相同） | 前兩組在凍結區，不動（§5）；後兩組可收（A15） |
| 新聞抓取 | `news.refresh()` **循序**抓 6 個來源，每個逾時 8 秒 → 最壞 48 秒 | §3 A2 |
| SW 導覽請求 | network-first，**沒有逾時**；慢網路要等到 fetch 自己失敗才退回快取 | §4 B2 |
| 更新進度 | `runUpdate` 有 `onProgress`，但 `app.js`／`settings.js` 呼叫 `store.update()` 都沒有接，畫面上看不到「回補 3/12」 | §3 A9 |
| 對比度 | `--fg-muted #93a3b8` 對 `--bg-card #18212e` 約 6:1；`.btn-primary` 深字對淺底 ≥ 10:1 | 合格，不動 |
| 相依套件 | `puppeteer ^23.0.0`、`wrangler ^4.129.0`（浮動版本）；`package.json` `version` 停在 `0.1.0` | A13 |

### 1.3 稽核總評

程式健康度**高**：純函式與畫面分得乾淨、每一條「回 null 不回 0」的規則都有測試盯著、金鑰隔離是結構性的、非同步守門與換版流程都有實證測試。**沒有發現任何會算錯數字的問題**（而且對帳數學凍結中，本來就不動）。

真正的缺口集中在四類，都不是「數字錯」：
1. **維運時間炸彈**：交易日曆只有 2026 年，2027-01-01 起整個更新流程停擺，而且沒有提前警示（A1）。
2. **無障礙**：對話框沒有焦點圈禁與還原、鍵盤焦點沒有可見樣式、整個 `#view` 是 `aria-live` 區域（每次換頁全文朗讀）、分頁列的 emoji 會被讀出來（A3～A6）。
3. **畫面承諾了卻沒做的事**：設定頁寫「或調高上限」但沒有欄位（A10）；`PLAN §2.2` 說回補要顯示進度，畫面沒接（A9）。
4. **文件漂移**：STATUS 標頭停在 2026-09-11、M6 仍寫「進行中」、突變條數三個地方三種數字、實機驗收清單停在 v0.7.9；而且**沒有像 MealMate 那樣的 `doctest` 把文件釘在程式上**（A12）。

---

## 2. 分級定義與工作量刻度

- **A 級**：低風險、明確有益、不改變使用者可見的行為語意（或只補上文件已承諾的行為）。Opus 可直接做，**照 §6 的順序分批**。
- **B 級**：會明顯改變行為或 UX，或有取捨。列出來附建議，由 Yolin 決定；**已於 2026-09-17 定案**（§4 決定欄、§7）。
- 工作量：**S** ＝ 一小時內（含測試）；**M** ＝ 半天；**L** ＝ 一天以上。
- 風險：**低** ＝ 純函式或純新增；**中** ＝ 動到共用檔（css／shell／sw），要跑放大範圍的測試。

---

## 3. A 級（可直接做）

| # | 問題 | 證據 | 風險 | 量 |
|---|---|---|---|---|
| A1 | 交易日曆跨年失效、無預警 | `market.covers()` 只認 `cal.year`；`update.runUpdate` 在 `expected == null` 時直接回 `NO_CALENDAR`，**除權息同步與定期定額待確認都不會跑**；`calendar.json` 只有 2026 | 中 | M |
| A2 | 新聞六來源循序抓，最壞 48 秒 | `js/news.js:110` `for (const source of SOURCES)` 逐一 `await`；每來源 `TIMEOUT_MS = 8000` | 低 | S |
| A3 | 對話框沒有焦點圈禁、關閉後焦點不還原、背景可被鍵盤／讀屏走到 | `js/ui.js modal()`：只 `focus()` 第一個可聚焦元素；沒有 `inert`、沒有 Tab 循環、沒有記住觸發元素 | 低 | S |
| A4 | `#view` 整個是 `aria-live="polite"`；分頁 emoji 被朗讀 | `index.html` `<main id="view" aria-live="polite">`；`shell.js TABS` 的 `.tab-icon` 沒有 `aria-hidden` | 低 | S |
| A5 | 鍵盤焦點不可見（自訂按鈕沒有 `:focus-visible`） | `css/style.css` 零筆 `focus`；`.btn`／`.chip`／`.switch`／`.collapse-head`／`.tab` 都是自訂外觀，瀏覽器預設 outline 在深色底上幾乎看不見 | 低 | S |
| A6 | iOS Safari 的 `100vh` 含工具列高度 | `css/style.css:39` `#app { min-height: 100vh }` | 低 | S |
| A7 | 外連缺 `rel="noopener noreferrer"` | `js/views/news.js:197`（新聞列）—— 其餘 `_blank` 都有 | 低 | S |
| A8 | CSP `style-src` 帶 `'unsafe-inline'`，只為了 6 處 inline style | `index.html` CSP；`ui.js:77`、`views/calc.js:471,479,625,626`、`views/holdings.js:278` | 中 | S |
| A9 | 長假回補時畫面沒有進度 | `update.runUpdate` 的 `onProgress` 在 `app.js:115`、`settings.js` 都沒有接；`pathtest` 只在函式層驗到「有回報進度」（慣例 20 的形狀：兩端只測了一端） | 低 | S |
| A10 | 設定頁說「或調高上限」，但沒有欄位；`secrets.setCap` 沒人呼叫 | `views/settings.js` configuredCard 文案「下個月自動歸零，或調高上限」；`secrets.setCap` 完全沒人用 | 低 | S |
| A11 | `store.subscribe` 死 API：`notifyChanged()` 被叫兩次，訂閱者零個 | `js/store.js` `listeners`；`views/holdings.js:235`、`views/plans.js:123` | 低 | S |
| A12 | 文件漂移，且沒有測試釘住文件 | STATUS 標頭「最後更新 2026-09-11」、進度表 M6「進行中」、`138 條`（STATUS/README）vs 實際 182、上線檢查清單「25 支＋110 條」；`docs/實機驗收_v0.7.9.md` 停在 v0.7.9；`scripts/` 沒有 doctest | 低 | M |
| A13 | 版本與相依浮動 | `package.json version 0.1.0`（App 是 0.7.15）；devDeps 用 `^` | 低 | S |
| A14 | 假斷言複查（慣例 12） | `assert-audit.jsonl` 母體 ≤ 2：uikittest 11、pathtest 7、calcviewtest 5、holdingtest 4 | 低 | S |
| A15 | 非凍結區的重複程式 | `KIND_LABEL` 在 `views/holding.js` 與 `views/plans.js` 一模一樣；`newId()` 在 `holdings.js` 與 `plans.js` 一模一樣 | 低 | S |
| A16 | PWA 補齊 | `manifest.webmanifest` 沒有 `id`；`index.html` 沒有 `<meta name="color-scheme">`（CSS 有 `color-scheme: dark`，但表單控制項在載 CSS 前會先閃白） | 低 | S |
| A17 | 開發迴圈：突變套件 3.5 小時，沒有「只跑受影響的」自動化 | STATUS 慣例要求手動 `--only <關鍵字>`；`mutationtest.mjs` 每條有 `file`，可以從 `git diff --name-only` 自動挑 | 低 | M |

### A1 交易日曆跨年：提前警示 ＋ 多年份 ＋ 跨年測試
**現況。** `covers(cal, iso)` 用 `String(iso).startsWith(`${cal.year}-`)`；日曆只有一年。2027-01-01 開 App：`runUpdate` 回「開休市日只涵蓋 2026 年，今天不在範圍內」，**之後每一天都是這句**，除權息預告、待確認扣款也全部停掉，而 12 月裡沒有任何提示。
**做法。**
1. `data/calendar.json` 改成可放多年：`{ years: { "2026": {tradingDays, closed}, "2027": {...} }, generatedAt }`；`makeCalendar` 合併成一個 `days` 陣列與 `set`，`covers()` 改成「這一年在 `years` 裡」。舊格式（單一 `year`）讀進來自動轉，`datatest` 兩種格式都驗。
2. `scripts/build-calendar.mjs` 加 `--year <YYYY>`，產出時**併入**既有年份而不是覆蓋；證交所 `holidaySchedule` 還沒公布下一年時腳本要明講「證交所尚未公布 2027 年」而不是產出空的年份。Opus 實作時**先查一次** openapi 現在有沒有 2027 年的資料，把結果寫進 STATUS。
3. 提前警示：`store` 新增 `calendarRunway()` 回「日曆涵蓋到哪一天、距今幾天」；**距離涵蓋末日 ≤ 45 天且沒有下一年**時，設定頁「資料來源與狀態」與總覽的當日損益卡各加一行 `muted sm`：「開休市日只到 2026-12-31，之後會無法結算，請更新 App」。文案不含任何判斷詞。
4. 跨年當天的訊息維持誠實（現有那句），但要多一句「更新 App 後就會恢復」。
**測試（各附突變）。** `roctest`／`datatest`：多年份日曆 `covers`／`prevTradingDay` 跨年（2026-12-31 → 2027-01-02）；單年份舊格式相容；`plantest` 跨年扣款（12/26 排定、順延到 1 月的第一個交易日）在多年份下產得出來、單年份下**不會**生出錯的日期（沿用 `MAX_POSTPONE_DAYS` 的保護）；`scenariotest`／`pathtest` 用 `now` 注入 12 月 1 日與 1 月 2 日兩個情境，畫面上分別出現警示句與跨年句；**慣例 19**：fixture 的日期要用注入的 `now`，不要用真的今天。突變：把 45 天門檻改 0 → 警示不出現 → 紅；`covers` 退回只認第一年 → 跨年測試紅。

### A2 新聞並行抓取
`refresh()` 改 `Promise.allSettled(SOURCES.map(fetchOne))`，30 分鐘節流、失敗逐家回報、`mergeItems` 的順序語意都不變（**合併要照 SOURCES 的固定順序**，不能照回來的先後，不然同一批新聞每次排序不同）。
**測試。** `newstest` 注入六個各延遲 300 ms 的 `fetchImpl`，量總時間 < 1 秒（循序會是 1.8 秒）；「一家逾時不拖垮其他家」照舊；結果陣列順序 ＝ SOURCES 順序。突變：改回循序 → 時間斷言紅。

### A3 對話框可及性
`ui.modal()`：開啟時記住 `document.activeElement`，關閉後 `focus()` 回去；`#app` 加 `inert`（關閉時移除）；Tab／Shift+Tab 在卡片內循環；`aria-labelledby` 指向標題。`confirmDialog` 沿用。
**測試。** `uikittest`：開對話框後 `document.activeElement` 在卡片內；連按 Tab 十次仍在卡片內；關閉後焦點回到觸發按鈕；`#app.inert === true` 開啟中、關閉後 false。突變：拿掉 `inert` → 紅；拿掉還原焦點 → 紅。

### A4 朗讀與圖示
`#view` 拿掉 `aria-live`（`#toast` 已有 `role="status"`，那才是該朗讀的東西）；`.tab-icon` 與 `.banner-icon` 加 `aria-hidden="true"`；`.switch` 的 `aria-label` 已有，`switch-state` 文字「開／關」加 `aria-hidden`（`aria-checked` 已表達狀態，重複朗讀）。
**測試。** `shelltest` 靜態：`index.html` 的 `#view` 沒有 `aria-live`；`uikittest`：每個 `.tab-icon` 都有 `aria-hidden`。各一條突變。

### A5 焦點可見
`css/style.css` 加一組 `:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }` 套在 `.btn, .chip, .switch, .collapse-head, .tab, .icon-btn, .field, .row[href], .news-row, .banner`；**不用 `:focus`**（滑鼠點也會亮）。
**測試。** `uikittest`：對每一頁用鍵盤 Tab 走一輪，取樣三個元素 `getComputedStyle(el).outlineStyle !== 'none'` 且 outline 顏色不是透明；`layouttest` 三種字級照掃（outline-offset 不會造成溢出）。突變：把 outline 改 none → 紅。

### A6 視窗高度
`#app { min-height: 100vh; min-height: 100dvh; }`（後者覆蓋前者，舊瀏覽器退回前者）。`layouttest` 照掃即可，不需新斷言（純樣式備援）；在 STATUS 記一筆。

### A7 外連
`js/views/news.js:197` 加 `rel: 'noopener noreferrer'`；`shelltest` 加一條靜態稽核「所有 `target: '_blank'` 都帶 `noopener`」（母體：現在 3 處），突變：拿掉一處 → 紅。

### A8 拿掉 `style-src 'unsafe-inline'`
6 處 inline style 改法：`ui.js:77` 的 `white-space:pre-line` 改 class `.pre-line`；`calc.js:471,479` 的 `margin-top:12px` 改 class `.mt-12`；長條圖與圖表的寬高 **改用 CSS 變數**：`el.style.setProperty('--w', pct + '%')` 配 `.bar-fill { width: var(--w) }`（CSSOM 操作在 CSP 下允許，inline `style` 屬性不允許）。`h()` 的 `style` prop **保留但改成只接受物件並走 `el.style.setProperty`**，再在 `shelltest` 加靜態稽核「`h()` 呼叫裡沒有字串型 `style:`」。
**風險。** 中：CSP 改動如果漏了一處，那一處會靜默不套用（例如長條圖寬度全為 0）。所以**一定要有瀏覽器層的斷言**：`holdingtest`／`calcviewtest` 量 `.bar-fill` 與 `.chart-bar` 的實際寬高 > 0，並且 `shelltest` 斷言 CSP 字串裡沒有 `unsafe-inline`（對照組：故意放回 inline style → 寬度 0 → 紅）。

### A9 回補進度上畫面
`app.js` 開機的 `store.update()` 與設定頁的「重新整理」都接 `onProgress`；進度存進 `store` 狀態（`{ done, total, label }`），總覽當日損益卡與設定頁「目前狀態」在更新中顯示「回補中 3/12：0050 2026-08」。**只在 `total > 1` 時顯示**（單一請求不閃字）。
**測試。** `pathtest` 長假回補情境：畫面上出現過「回補中 N/M」（用 `MutationObserver` 或輪詢取樣，慣例 20：要在空窗中間取樣）；結束後消失。突變：不接 `onProgress` → 紅。

### A10 AI 用量上限可調
設定頁 configuredCard 加「本機上限（美金）」數字欄位 ＋ 儲存（呼叫既有 `secrets.setCap`，單位換算成微美金；`≥ 0` 的整數美金或到小數兩位）。文案不變。
**測試。** `secret-leak-test`／`insighttest`：設 0.5 → `status().capMicroUsd === 500000`；超過後 `generate()` 一次請求都不發（既有斷言，母體改用新上限）；欄位不接受負數。突變：`setCap` 不寫 DB → 紅。

### A11 死 API 與零使用匯出
刪 `store.subscribe`／`notifyChanged`／`emit` 與兩處呼叫；刪其餘「完全沒人用」的 10 個匯出（§1.2 清單，**`setCap` 除外**，A10 會用到）。`secret-leak-test` 的靜態掃描母體會少幾行，確認它仍能抓到對照組。
**只有測試在用的 83 個匯出保留**（純函式給測試用是這個專案的設計）。

### A12 文件對齊 ＋ `doctest`
1. 修 STATUS：標頭日期、進度表（M6 ✅、之後 v0.7.x 各批）、`138` → 從程式數、上線檢查清單第 1 列改「27 支＋N 條」（**當時是 27 支**——現在的數字由 `doctest` 從 `package.json` 的鏈數出來，不要照抄這一行）；README 同步；`實機驗收_v0.7.9.md` 改名 `實機驗收.md` 並加「適用版本」欄，或在 STATUS 標明它是歷史文件。
2. 新增 `scripts/doctest.mjs`（照 MealMate 的形狀）進 `npm test`：`package.json test` 鏈裡的每一支都在 README 表格裡、反之亦然；STATUS／README 提到的突變條數 ＝ `mutationtest.mjs` 實際條數（**寫成「從程式數」的斷言，不是硬編**）；`APP_VERSION`／`sw.js VERSION`／`index.html ?v=` 三處一致（`shelltest` 已有，這裡引用）；STATUS 說有的每一支 `scripts/*.mjs` 都存在；STATUS「元件慣例」表裡禁用的東西（`type="time"`、`link-btn`）程式裡真的沒有。每條附突變（把文件數字改錯 → 紅）。

### A13 版本與相依
`scripts/bump-version.mjs` 順便寫 `package.json.version`（去掉 `stockdiary-v` 前綴）；`shelltest` 加一條四處一致。devDeps 釘死到目前 lock 檔的版本（`npm ls puppeteer wrangler` 抄下來），STATUS 記「升版要人做決定」。

### A14 假斷言複查
逐條打開 `assert-audit.jsonl` 裡母體 ≤ 2 的 27 條（uikittest 11、pathtest 7、calcviewtest 5、holdingtest 4），每條問「這個母體為什麼這麼小」：fixture 本來就只有兩個元素 → 加前置斷言講出來；母體是「有問題的那幾個」→ 改成全部（慣例 12）。修過的每一條要用突變證明會紅（慣例 32）。回報列表：哪幾條改了、哪幾條確認沒問題。

### A15 收重複（非凍結區）
`KIND_LABEL`（變動類型的中文）搬到 `js/holdings.js` 匯出，兩個 view 改 import；`newId()` 搬到 `js/db.js` 匯出。**不動** `divRound`／`roundToYuanMicro`（在凍結檔裡，見 §5）。`holdingtest`／`plantest` 照跑；不需新斷言。

### A16 PWA 補齊
`manifest.webmanifest` 加 `"id": "./"`；`index.html` 加 `<meta name="color-scheme" content="dark">`。`shelltest` 加兩條靜態斷言。

### A17 受影響的突變自動挑選
`mutationtest.mjs` 加 `--changed [base]`：用 `git diff --name-only base` 取改到的檔案，挑 `file` 在其中、或 `test` 對應的測試 import 了那些檔案的突變。STATUS「平常上線」那一節改成建議用 `--changed`。**不改變 `npm test` 全跑的行為。** 測試：`--changed` 對一個假的 diff 清單挑出的集合 ＝ 手算的集合（純函式抽出來測）。

---

## 4. B 級（會改變行為或 UX；**已定案**，決定欄是 Yolin 2026-09-17 拍板的結果）

| # | 議題 | 現況與證據 | 選項 | 決定 |
|---|---|---|---|---|
| B1 | **淺色模式** | 全 App 只有深色（`color-scheme: dark`、所有顏色是深色變數、截圖與 `layouttest` 都在深色下量） | (a) 不做；(b) 跟隨系統 `prefers-color-scheme`，全部變數補淺色版，`layouttest` 兩套顏色都掃（84 → 168 組） | **不做。** 使用者只在盤後看、深色是刻意的設計；(b) 的成本是整套視覺與版面掃描翻倍，收益不明 |
| B2 | **SW 導覽請求加逾時** | `sw.js` 導覽 network-first 無逾時；GitHub Pages 慢或行動網路訊號差時，開 App 會空白等到 fetch 失敗才退回快取（`index.html` 本來就在 SHELL 裡） | (a) 維持；(b) `Promise.race` 3 秒逾時退回快取，換版仍靠 `registration.update()` | **做 (b)。** 這是 SW 行為改動，**必跑** `upgradecheck`、`versionmixtest`、`pathtest`（離線那段）三支端對端；`pathtest` 加「網路很慢」情境（用 `racetest` 那種指定檔案延遲的伺服器把 `index.html` 拖到 6 秒）量開頁時間 < 4 秒且畫面是完整的殼；對照組：逾時改 0 → 每次都走快取 → 「換版後第一次開」那條 `upgradecheck` 斷言要能分辨。突變：拿掉逾時 → 慢網情境紅 |
| B3 | **「試著查一次」（PLAN §2.2）規劃了沒接上** | 代號表查不到 → 只回「找不到代號（代號表產生於 2026-09-11）」；PLAN 說可以打一次 `STOCK_DAY` 查看看。新上市／新 ETF 在代號表重跑前一律加不進來 | (a) 照 PLAN 做（多一種「未在清單」持股，所有畫面要處理它）；(b) 不做，改成代號表**超過 60 天**時設定頁與「找不到代號」訊息提醒「代號表可能過期，請更新 App」；(c) 兩者都做 | **不做 (a)，做 (b)。** 實作：`catalog.staleness(now)` 純函式（比照 `divrecord.staleness`，門檻 `CATALOG_STALE_DAYS = 60`）；設定頁「來源」那行代號表日期後面加「（距今 N 天，可能已經有新上市的代號沒收進來）」；`holdings.checkCode` 的「找不到代號」訊息在過期時多一句同樣的話。文案不含判斷詞。測試：`datatest` 純函式 59／61 天兩側；`holdingtest` 注入 `now` 驗兩種訊息；突變：門檻改 0 → 不過期時也出現 → 紅。PLAN §2.2 那一句改成「代號表過期時提醒更新，不打 STOCK_DAY 試查」並註明本次決定 |
| B4 | **匯出檔在 iPhone 主畫面 App 裡存不存得下來** | 匯出走 `<a download>` ＋ Blob；iOS standalone PWA 對 `download` 的行為版本間不一致；`實機驗收` 第 6 項「匯出檔存得下來」**還沒有人回報結果** | (a) 先請 Yolin 實機試一次；(b) 若失敗，改成 `navigator.share({ files })` 優先、`download` 備援 | **待 Yolin 實機測試，本次實作不含 B4。** 請 Yolin 在主畫面 App 裡「設定 → 匯出備份檔」，回報有沒有存到檔案；失敗再開一張工單做 (b)（S） |
| B5 | **對帳數學凍結期間，畫面上「成本未含手續費」那段說明** | `views/home.js` 已有 `costExcludesFee` 說明 | — | **不動**，只是提醒：這段文案是凍結區的一部分，等 Yolin 給折數後一起處理 |

沒有列進 B 的、使用者明確拿掉過的東西（STATUS「使用者明確決定過的事」）：總覽「看每一檔」按鈕、總覽資料狀態卡、試算列全部持股、新聞進底部分頁。**本計畫沒有任何一項會把它們加回來。**

---

## 5. 量過但不值得動（避免之後有人無中生有）

| 項目 | 量到什麼 | 為什麼不動 |
|---|---|---|
| `divRound`／`roundToYuanMicro` 重複 | 各 2 份，且 `money.roundToYuan` 已存在 | 全在凍結檔（dividend.js、plans.js、calc.js）。等解凍再一起收 |
| 只有測試在用的 83 個匯出 | §1.2 | 純函式給測試直接呼叫是這個專案的設計；刪了測試就要繞路 |
| `stocks.json` 247 KB 每次開頁 `JSON.parse` | 2,768 筆；SW 快取命中、GitHub Pages 有 gzip | 手機上解析是毫秒級；改成分片或壓縮只會多一種格式要維護 |
| `index.html` 的 `modulepreload` 只列 7 個 | store.js 靜態 import 的 catalog／market／twseclient／update／prices 沒預載 | SW 接手後全部從快取拿，預載的差別量不出來；而且 `shelltest` 有「帶不帶版本參數要一致」的規則，多列反而多一種漂移 |
| `home.js` 讀 `events` store 兩次（`pending()` 與 `summary()` 各 `getAll`） | 兩次 IndexedDB 讀取 | 資料量是幾十筆，毫秒級；合併會讓 `events.js` 的 API 變得不對稱 |
| 三個 view 的模組層狀態（`calc.js state`、`news.js relatedFilter`、`holdings.js showClosed`） | 換頁後保留 | 是刻意的（各有註解說明：試算欄位不該換頁就清空、篩選是當下狀態） |
| 19 處靜默 `catch` | 逐條看過 | 每一處都有註解寫為什麼可以吞（剪貼簿權限、SW 註冊失敗、對照資料讀不到等），而且都有降級文案 |
| `mutationtest` 3.5 小時 | 每條改寫原始碼再跑測試 | 改寫工作目錄的機制**不能平行**；改成隔離複本會讓「突變過期＝失敗」的偵測變複雜。A17 的 `--changed` 已把日常成本降到夠低 |
| Worker `compatibility_date = 2024-11-01` | 舊 | 沒有用到任何新 runtime 特性；升了要重跑 `workertest`，零收益 |
| 對比度、觸控區 | 量過 ≥ 6:1；`uikittest` 已掃 ≥ 44px | 合格 |
| `workers/.wrangler/tmp` 六份殘留 | gitignored | 本機暫存，不影響任何人 |
| `js/views/calc.js` 786 行 | 最大的檔 | 結構清楚（帶入／輸入／結果三段），拆檔只是搬家 |
| `secrets.MODELS` 的費率常數 | 寫死在程式 | 這不是程式優化，是要**人**定期對官方價目表核對（§6 維運） |

---

## 6. 維運待辦（不是程式改動，但要有人做）

| 事 | 何時 | 誰 |
|---|---|---|
| `npm run build-calendar -- --year 2027`（A1 做完之後）並 commit | 證交所公布 2027 年休市日之後（通常第四季）；A1 的警示會在 11 月中開始提醒 | Opus 查證公布時間，Yolin 決定何時發版 |
| `npm run build-dividends` 重跑 | 每季；App 從 2026-12-12 起會標「可能已經有新的決議沒收進來」（`STALE_DAYS = 92`） | 開發者 |
| `npm run build-stocks` 重跑 | 每月或有新 ETF 上市時；B3(b) 做完後 App 會提醒 | 開發者 |
| 核對 `secrets.MODELS` 費率 | 每次 Anthropic 改價；用量顯示是估算，文案已講明 | 開發者 |
| 實機驗收清單重跑 | 每次 A 級批次上線後（特別是 A3～A6、A8 動到共用樣式與 CSP） | Yolin |

---

## 7. 決策紀錄（Yolin 2026-09-17 拍板，定案）

| 議題 | 決定 |
|---|---|
| A 級 17 項 | **全部做**，照 §8 四批次順序 |
| B1 淺色模式 | **不做** |
| B2 SW 導覽請求 3 秒逾時退回快取 | **做**，必跑 `upgradecheck`、`versionmixtest`、`pathtest` 三支端對端 |
| B3 「試著查一次」 | **不做**查未在清單的代號；**做替代方案**：代號表超過 60 天的過期提醒（§4 B3 的實作說明） |
| B4 iPhone 主畫面 App 匯出備份 | **待 Yolin 實機測試**；本次實作不含。測完再決定要不要做 Web Share 備援 |
| 硬性限制 | 照 §0：凍結區絕對不碰，碰到非改不可就停下回報 |

---

## 8. 執行順序（定案；給 Opus，每批各自 bump、各自回報）

| 批次 | 內容 | 為什麼先 |
|---|---|---|
| 1 | A12 文件對齊＋doctest、A13 版本與相依、A14 假斷言複查、A17 `--changed` | 先把量尺校正好，後面每一批的回報才對得起來 |
| 2 | A1 日曆跨年、A9 回補進度、A10 用量上限、A2 新聞並行、**B3 代號表過期提醒** | 有時效性（A1 在 11 月前要上線）、都是「畫面承諾了」或「資料會過期」的事；B3 與 A1 同一種形狀（靜態資料過期提醒），一起做 |
| 3 | A3～A7 無障礙與安全小修、A16 PWA | 動到 `ui.js`／`css`／`index.html`，一起跑 `layouttest`／`uikittest`／`shelltest`／`racetest` |
| 4 | A8 CSP、A11 死碼、A15 收重複、**B2 SW 導覽逾時** | A8 與 B2 風險最高放最後，前面的瀏覽器斷言都齊了才動；B2 動 `sw.js` 必跑 `upgradecheck`、`versionmixtest`、`pathtest` |
| （不排） | B4 | 等 Yolin 實機結果 |

每一批的受影響測試照 STATUS「怎麼判斷受影響」的表；**動到 `css/style.css`、`js/ui.js`、`js/shell.js`、`index.html`、`sw.js` 的批次一律加跑 `layouttest`、`uikittest`、`shelltest`、`racetest`、`versionmixtest`、`pathtest`**。

---

## 9. 回報格式（Opus 每批結束時）

逐項列 `A#`／`B#`：做了什麼、改了哪些檔、新增哪些斷言與突變（各幾條、突變是否驗證會紅）、跑了哪些測試、線上版號。沒做或改了做法的要講原因。B2、B3 已由 Yolin 於 2026-09-17 確認；B4 不動。凍結區若被迫要碰，停下來回報，不要自行決定。
