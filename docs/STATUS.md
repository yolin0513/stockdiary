# StockDiary 專案狀態（docs/STATUS.md）

> 最後更新：2026-09-11。**M0／M1／M2 完成；M3 起尚未開發。Worker 尚未建立（M5）。**
> repo `yolin0513/stockdiary` 已建立並部署到 GitHub Pages。
> 給下一個工作階段（Opus 5）快速接手用。規劃細節見 `PLAN.md`（唯一真相來源），實測見 `FEASIBILITY.md`。

## 進度

| 里程碑 | 狀態 | 線上版本 |
|---|---|---|
| M0 驗證與骨架 | ✅ 完成（TWSE 當日收盤公布時間的實測仍在進行，見下） | `stockdiary-v0.1.0` |
| M1 持股與每日結算 | ✅ 完成 | `stockdiary-v0.2.0` |
| M2 除權息與股利 | ✅ 完成 | `stockdiary-v0.3.0` |
| M3 定期定額 | ⬜ 未開始 | |
| M4 定期定額試算器 | ⬜ 未開始 | |
| M5 新聞、Worker、今日觀察 | ⬜ 未開始 | |
| M6 匯出／匯入、集中度、上線 | ⬜ 未開始 | |

開發期的實測發現集中在 `FEASIBILITY.md` §10，其中三項推翻或補充了規劃階段的假設：

1. **TWT49U 的 `strDate`／`endDate` 參數無效**（§10.8）—— 除權息參考價只能在除權息當天抓到並存起來，事後補不回來。回補到的除權息日會標 `exNoRef`，那一檔不計入當日損益，**不會拿前收硬算**。
2. **TWT48U 在金額未公告時放的是 HTML 文字**（§10.8）—— 當成 0 會在日曆上生出「每股 0 元」。72 筆裡有 35 筆是這樣。
3. **`t187ap03_L` 只給產業別代碼、沒有名稱**（§10.3）—— 另接 ISIN 一覽表 join 出代碼→名稱，34 個代碼零衝突（使用者已同意這個增補）。

測試現況：12 支測試、約 660 條斷言，`npm run mutationtest` 用 **41 條突變**逐一證明關鍵斷言改壞會紅。
突變的 `find` 字串在原始碼裡找不到（或找到多次）時，突變測試會**失敗**而不是略過。

## 部署

| 項目 | 位置 |
|---|---|
| 前端（GitHub Pages） | `https://yolin0513.github.io/stockdiary/`（repo `yolin0513/stockdiary`，push main 即部署；`sw.js` 的 VERSION 每版必 bump） |
| 新聞轉發 Worker | `https://stockdiary-news.yolin0513.workers.dev`（`workers/`，`npx wrangler deploy`；**獨立於 TripQuest 的 Worker**，無 D1／KV／R2／Cron） |
| 靜態資料 | `data/stocks.json`、`data/calendar.json` 由 `scripts/build-*.mjs` 從 `openapi.twse.com.tw` 產生（開發者本機執行，commit） |

## 工作慣例（常設規則，給每一個接手的工作階段）

1. **使用者已授權自行執行**查詢、新增檔案、搬移檔案、git 操作（建 repo、commit、push、部署 Worker），**不必逐項請示**。只有「刪除使用者資料」「花錢」「動到其他專案（TripQuest、JLPT_App）」才要問。
2. **重大決策開多代理投票**：架構、資料結構、部署方式、需付費或註冊的服務 → 開 **3 個 Fable 5.1（`claude-fable-5-1`）代理**、同一份 prompt、各自獨立、多數決；分歧採保守；決議寫進回報與本文件。
3. **Fable 額度用盡就自動改用 Opus 5，不要停下來問。** 代理因 429／quota 失敗 → 自動改 `claude-opus-5` **整批重跑**（投票要在同一模型上才可比），回報中註明「因 Fable 額度用盡改用 Opus 5」。只有 Opus 5 也不可用時才暫停。
4. **測試不得有假斷言。** 每條斷言都要能用突變測試證明它真的會紅：把對應邏輯改壞（例如拿掉除息參考價、讓上櫃代號顯示價格、給試算器加預設報酬率），測試必須失敗；修回去必須綠。檢查器（禁用詞過濾、代號判斷）要有**對照組**：餵已知該被抓到的輸入，斷言真的抓到。「應該是 0」的斷言旁邊要有「母體非空」的斷言。註解不是斷言。
5. **繁體中文介面**；文案誠實——拿不到的資料就寫「尚未取得」「不支援」，不顯示 0、不用舊資料冒充新資料。
6. **不得出現任何投資建議、目標價、買賣建議**——AI 輸出、UI 文案、試算器預設值、說明文字全部適用。
7. **不規劃也不實作任何券商帳密、下單、轉帳功能。**
8. 沿用 JLPT_App／TripQuest 技術路線：原生 JS ES Modules ＋ IndexedDB ＋ Service Worker，無框架、無打包；`h()` 全 textNode、URL 屬性白名單；CSP `script-src 'self'`；外部請求一律 `AbortSignal.timeout` ＋ 降級。
9. 每版流程：bump `sw.js` VERSION → `npm test` → commit/push → curl 確認線上 VERSION → `npm run sweep`（線上巡檢）→ 截圖放 `screenshots/features/`。
10. 打真網路的測試（TWSE、RSS、Anthropic）**不進 `npm test`**，另開 `npm run livecheck`；TWSE 請求 ≥ 2 秒間隔，測試也一樣，**不要連打**（社群共識 3 次／5 秒會被封 IP）。
11. 不動 `D:\Claude\App\TripQuest`、`D:\Claude\App\JLPT_App` 的任何檔案（可讀，用來抄慣例）。

## 開發順序與驗收條件

### M0 驗證與骨架（第一步從這裡開始）

| 工作 | 驗收 |
|---|---|
| **觀察 TWSE 當日收盤資料實際公布時間**：在某個交易日 13:30–16:00 之間，每 10 分鐘各打一次 `rwd/zh/afterTrading/STOCK_DAY_ALL?response=json` 與 `exchangeReport/STOCK_DAY?date=<今天>&stockNo=2330`（≥ 2 秒間隔、一天一次觀察即可），記錄第一次出現今天日期的時刻 | 結果寫進 `FEASIBILITY.md` §9.3，並把 `settings` 的「今日資料公布門檻」預設值定下來（暫定 15:00；實測後改） |
| 建 repo `stockdiary`（公開）、GitHub Pages、`package.json`（`type: module`、puppeteer、wrangler devDeps） | `https://yolin0513.github.io/stockdiary/` 開得起來 |
| PWA 殼：`index.html`、`manifest.webmanifest`、`sw.js`、`js/{app,router,db,ui,store}.js`、`css/`；照 TripQuest 的 `ui.js`（h() textNode、URL 白名單）與 SW 換版策略 | `npm test` 至少有：路由完整性稽核（view import ⊆ SW SHELL）、`h()` 不接受 `html:` prop 的斷言 |
| `scripts/build-stocks.mjs`：從 `openapi.twse.com.tw/v1/opendata/t187ap03_L`（上市）、`www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O`（上櫃）、TWSE `STOCK_DAY_ALL`（含 ETF）產 `data/stocks.json`；`scripts/build-calendar.mjs` 從 `holidaySchedule` 產 `data/calendar.json` | 固定樣本解析測試；`stocks.json` 含 `2330 上市`、`6488 上櫃`、至少一檔 ETF |

### M1 持股與每日結算

| 工作 | 驗收 |
|---|---|
| `holdings`／`changes` store、快速設定持股（一筆 `opening`）、代號輸入與不支援判斷（PLAN §2.4） | 上櫃代號在任何畫面出現價格 → 測試紅；總和旁「不含 N 檔」文案斷言 |
| `STOCK_DAY_ALL` 當日結算、`STOCK_DAY` 回補缺漏日、≥ 2 秒節流、同月快取 | 用固定 CSV／JSON 樣本；節流測試量實際間隔 |
| 當日損益、市值、資料狀態列、「今日收盤尚未公布」降級 | 手算固定案例（含跨月、休市日、部分不支援）；「未公布時顯示 0」→ 紅 |
| 選填均價 → 未實現損益、報酬率、「僅含 N 檔」 | 沒填均價的畫面不出現任何未實現數字（斷言 DOM） |

### M2 除權息與股利

| 工作 | 驗收 |
|---|---|
| `TWT48U` 解析 → `events(upcoming)` → 日曆頁；`TWT49U` 解析 → 參考價 | 固定樣本（含「息」「權」「權息」三種）解析測試 |
| 除息日當日損益改用參考價並標「含除息調整」；當日應收股利計入（可關） | **突變驗證：拿掉參考價邏輯 → 除息日出現等於息值的假虧損 → 測試紅** |
| 事件確認流程、實收金額可改、自動扣費開關（預設關） | 開關關閉時金額＝股數 × 每股配息；開啟時 ≥ 20,000 才扣 2.11% |
| 累積已領股利（總計、年度、每檔） | 加總對照固定案例 |
| 配股：股數增加、餘數提示 | 每仟股配股樣本 |

### M3 定期定額

| 工作 | 驗收 |
|---|---|
| `plans` store、扣款日偵測、待確認 `dca` 變動（估算股數＋餘額）、一鍵確認／改實際值 | 「跳過三個月再開 App」→ 產生三筆 pending 且都未確認 |
| 配息再投入 → `dividendReinvest` 待確認 | 只有計畫開啟時才產生 |
| 均價更新公式（有填成交價才更新；否則 `costNote`） | 固定案例 |

### M4 定期定額試算器

| 工作 | 驗收 |
|---|---|
| 金額法（高精度、不捨入）、股數法（餘額結轉）、雙情境並排、逐年表、折線 | 與試算表手算對照到元；股數法期末與金額法差距 < 一股股價的斷言 |
| 所有輸入預設空白、免責文案固定 | **斷言：頁面載入時任何數值欄位都是空字串；DOM 中不含「預期」「保守」「樂觀」「建議」「歷史平均」**；對照組：故意塞一個預設值 → 紅 |

### M5 新聞、Worker、今日觀察

| 工作 | 驗收 |
|---|---|
| `workers/worker.mjs`：`GET /rss?src=` 白名單四來源、Cache API 10 分鐘、CORS、逾時 8 秒、非白名單 400 | `workertest`：用 wrangler 真跑，非白名單來源回 400 |
| 前端 RSS 解析（國內經 Worker、CNBC／MarketWatch 直打）、只存標題連結來源時間、14 天清理 | 固定 RSS 樣本；斷言 `news` store 不含 `description`／全文欄位 |
| 金鑰頁（貼上、驗證、遮罩、清除、用量）、`secrets` 獨立 store | `secret-leak-test`：匯出 JSON、備份、任何序列化結果不含 `sk-ant-` |
| 今日觀察：系統提示、JSON 輸出、禁用詞過濾、免責 UI、首次同意頁、輸入不含股數金額 | 過濾器對照組（餵「建議加碼」「目標價 1200」等 → 全部攔到；餵正常句 → 不攔）；斷言送出的 prompt 不含任何持股股數與金額 |

### M6 匯出／匯入、集中度、上線

| 工作 | 驗收 |
|---|---|
| 匯出／匯入 JSON（`holdings`、`changes`、`plans`、`events`、`settings`；**不含 `secrets`**） | round-trip 測試；secret-leak |
| 產業集中度條狀圖 | 特大字級版面掃描 |
| 版面掃描（比照 TripQuest `layouttest`：多字級 × 多寬度，含展開狀態） | 零重疊、零溢出 |
| 部署：GitHub Pages ＋ Worker；`npm run sweep`；iPhone 主畫面 App 實測 | 線上 VERSION 一致；離線開啟正常 |

## 接手者最容易做錯的事

1. **除息日不改用參考價 → 生出等於息值的假虧損。** 當日損益的基準在除權息日必須是 `TWT49U` 的參考價（或前收 − 息值），不是前一日收盤。這是自製記帳最常見的錯，M2 必須有突變測試。
2. **上櫃／興櫃代號靜默顯示價格。** TWSE 的端點對上櫃代號可能回空資料或錯誤，若程式把空值當 0 或拿到別的東西就會顯示錯的數字。不支援的代號在任何畫面都不能出現價格，總和要標「不含 N 檔」。
3. **試算器出現任何「建議報酬率」**，包括 placeholder、範例值、「常見 5%」、「歷史平均」，或 AI 幫忙填。全部是投資建議。欄位預設空白，測試斷言 DOM 不含那些詞。
4. **除權息日曆用錯表。** `TWT49U` 是結果表，只有已發生的除息日；日曆要用 `TWT48U` 預告表。兩張表欄位不同，各寫解析器、各有樣本測試。
5. **「今日收盤尚未公布」時顯示 0 或用昨天冒充今天。** 盤後幾點資料才出來要靠 M0 實測；門檻前開 App 要明講「尚未公布」並保留昨天的結算日期。
6. **AI 輸入夾帶股數、金額、成本。** 只給代號、名稱、產業、當日漲跌％；一旦給了金額，模型就會開始「幫你算該不該加碼」。
7. **TWSE 連打被封 IP。** 回補多檔多月時一定 ≥ 2 秒一次；測試不打真網路；`livecheck` 也要節流。
8. **金鑰進了匯出檔。** `secrets` 必須是獨立 store 且所有匯出路徑結構性讀不到它，並有 `secret-leak-test`。

## 已知限制與未解事項

- TWSE 當日收盤公布時間未實測（M0）。
- 除權息表只涵蓋上市；上櫃持股（若使用者選擇只記股數）沒有除權息事件。
- 沒有推播；待確認事件只在開 App 時看到。
- iPhone：主畫面 App 與 Safari 儲存分離（見 TripQuest `PLATFORM_NOTES.md` §1）——匯出／匯入 JSON 是換機與救援的唯一路徑，設定頁要明講。
