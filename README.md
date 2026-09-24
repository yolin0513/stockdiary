# StockDiary 股息日記

免帳號、純前端、離線可用的 PWA：記台股**上市**持股與每月變動，每個交易日結算**當日損益**，累積**已領股利**，顯示**除權息日曆**，整理國內外財經大事（標題＋連結），並可用你自己的 Claude 金鑰產生「今日觀察」（資訊整理，**非投資建議**），另附一個定期定額試算器（所有假設由你輸入）。

- 線上位置：`https://yolin0513.github.io/stockdiary/`
- 技術路線與 `../JLPT_App`、`../TripQuest` 相同：原生 JS ES Modules ＋ IndexedDB ＋ Service Worker，無框架、無打包，部署 GitHub Pages。

## 這個 App 不做什麼

- **不提供任何投資建議、目標價、買賣提示。** 試算器的報酬率與配息率一律由使用者輸入，沒有建議值、沒有歷史平均、沒有範例值。
- **不碰券商帳號密碼、不下單、不轉帳。**
- 不支援上櫃／興櫃報價（可以記股數，但不顯示價格與損益）。
- 不做盤中即時、不做技術分析、不算已實現損益與手續費。

## 目前進度

**M0–M5 完成**（持股與每日結算、除權息與股利、定期定額、定期定額試算器、新聞與今日觀察）。開發順序、驗收條件與工作慣例見 `docs/STATUS.md`。

| 文件 | 內容 |
|---|---|
| `docs/PLAN.md` | 規劃書（唯一真相來源）：架構、資料模型、結算定義、AI 界線、成本、功能取捨 |
| `docs/FEASIBILITY.md` | 可行性評估與實測紀錄：各資料源的 CORS／頻率限制／回應格式、新聞來源條款、成本估算 |
| `docs/STATUS.md` | 交接狀態：工作慣例、里程碑驗收條件、接手者最容易做錯的事 |
| `docs/VOTE_2026-09-11.md` | 三代理投票紀錄 |

## 開發

```bash
npm install          # puppeteer（測試用）、wrangler（Worker 用）
npm run dev          # http://localhost:5180
npm test             # 全部離線測試 + 突變測試
npm run livecheck    # 打真網路的巡檢（不在 npm test 裡）
```

### 測試

| 指令 | 內容 |
|---|---|
| `npm run roctest` | 民國日期換算、交易日曆、今日資料公布門檻 |
| `npm run fmttest` | 顯示格式：拿不到的數字顯示「—」，**永遠不顯示 0** |
| `npm run parsetest` | TWSE 回應解析（固定樣本取自實際回應） |
| `npm run settletest` | 每日結算：當日損益、市值、未實現損益（手算過的固定案例） |
| `npm run changestest` | 持股變動：股數＝已確認變動的總和、回推某一天的持股 |
| `npm run dividendtest` | 除權息解析、參考價公式、股利金額與扣費、配股餘數 |
| `npm run throttletest` | TWSE 請求節流（**量實際經過的毫秒數**）與單次開頁上限 |
| `npm run datatest` | `data/*.json` 內容與代號支援判斷 |
| `npm run shelltest` | PWA 殼稽核：import 圖 ⊆ SW SHELL、`h()` 不接受 `html:` prop、每條路由真的畫得出**自己那一頁**、沒有一頁繞過 `render()` |
| `npm run versionmixtest` | 版本混搭：舊 `app.js` ＋ 新 view 會怎樣、不認得的路由要講清楚原因、離線（**真的把伺服器關掉**）開得起來 |
| `npm run backuptest` | 匯出／匯入：round-trip、備份檔不含金鑰、壞檔案擋得下來並講出原因 |
| `npm run concentrationtest` | 產業集中度：整數百分比、算不出市值的不計入分母、不做任何評價 |
| `npm run divrecordtest` | 配息紀錄與**界線**：不填試算欄位、沒有帶入按鈕、零百分比、只做合計不做平均 |
| `npm run uikittest` | 共用元件：全 App 只有一套切換開關（滑塊真的會動）、沒有原生 time 欄位、沒有底線文字連結、觸控區 ≥44px |
| `npm run layouttest` | 版面掃描：7 頁 × 4 字級 × 3 寬度 ＝ 84 組，零溢出、零重疊、零橫向捲動 |
| `npm run insighttest` | 今日觀察的界線：禁用詞過濾（正反對照組）、越界只隱藏該段、prompt 不含股數金額、免責標籤關不掉 |
| `npm run secret-leak-test` | 金鑰不外洩：匯出範圍、靜態掃描、真的存一把假金鑰後把所有序列化出口走一遍 |
| `npm run newstest` | 新聞：六家真實 RSS 樣本、只存標題連結來源時間、節流、14 天清理、未允許 AI 的來源不進 prompt |
| `npm run workertest` | 新聞轉發 Worker：用 wrangler 真跑，白名單擋非法來源、CORS、快取命中、什麼都不存 |
| `npm run upgradecheck` | 換版實測：裝著舊版的人要做什麼才吃得到新版（模仿 GitHub Pages 的 `max-age=600`）；舊版＝往回找版本號不同的最近一個 commit |
| `npm run racetest` | 非同步畫面競態：慢的舊畫面不准蓋掉使用者現在這頁、不准把人從他選的那頁拉走、空窗中間也不准閃出別頁 |
| `npm run holdingtest` | 持股畫面：上櫃列沒有報價數字、未公布時顯示「—」、未實現區塊的出現條件 |
| `npm run plantest` | 定期定額：扣款日展開與順延、估算股數與餘額、平均成本更新 |
| `npm run eventtest` | 除權息端對端：除息日改用參考價、確認流程、配股加股數 |
| `npm run calctest` | 試算器算術：金額法與股數法、餘額結轉、扣費（手算對照到元） |
| `npm run dcatest` | 定期定額端對端：跳過三個月、配息再投入、拿不到收盤價時的處理 |
| `npm run calcviewtest` | 試算器畫面：欄位預設空白、DOM 與屬性都沒有帶判斷意味的字 |
| `npm run scenariotest` | 真實情境端對端：一整天的操作走一遍，畫面上的數字與資料庫對得起來 |
| `npm run pathtest` | 真實使用路徑：第一次開啟、只有一檔、跨月、長假回補、併發更新、慢網路、離線、上游掛掉、賣出 |
| `npm run doctest` | 文件與程式對齊：測試清單、突變條數、版本四處一致、禁用元件真的沒被用回去；凍結區（成本／損益的數學）跟快照一樣、禁用詞清單只有一份 |
| `npm run taptest` | `tap.mjs` 自己的測試：空母體的 `noneOf`／`everyOf`、只有正例或只有反例的 `detects` 都必須紅（在子程序裡跑探針），乾淨的斷言要放行 |
| `npm run buildtest` | 三支 build（`build-calendar`、`build-dividends`、`build-stocks`）的寫檔前關卡與寫檔（F8）：母體是逐字寫出的「單位 × 情境」矩陣——每一份來源空的、取不到、欄位對不上、解析不了、比上一次成功的少一半以上，上一次的輸出壞掉，寫檔那一步出事（暫存檔的位置被佔住、換不上去、清理也失敗）；每一格要回非 0、理由點名那個單位、`data/` 雜湊不變、不吐堆疊，並分「擋／碰巧擋下／沒擋」統計（在暫存複本裡從真實入口跑，`fetch` 換成 `scripts/testfetch.mjs`，不打網路） |
| `npm run buildverifytest` | F9 的 build 驗法登記（`scripts/buildverify.mjs`）：驗法全部擋下、而且被守的檔工作區＝HEAD 才登記，否則舊登記被刪；推送前這次要推的 commit 動到被守的檔（逐個 commit 看）才比對登記，對不上就擋。在暫存的小 repo 裡用假的 buildtest 跑，幾秒 |
| `npm run entrygatetest` | F10：`assertaudit`、`sweep`、`livecheck` 三支入口的「對照組沒過就停」，從真實入口驗——在 `.logs/` 的複本裡把判斷模組或錄好的回應真的弄壞，確認回 1、理由是對照組、沒有往下做（網路用預先載入的模組記錄，一律不打）；依賴沒壞時要過得去（對照） |
| `npm run escscan` | 跳脫掃描：repo 裡所有腳本（`.mjs`／`.js`／`.cjs`／`.sh`，拿 git 追蹤清單核對一支不漏）有沒有 regex 被多跳脫一次、字串少跳脫一次、shell 樣式帶反斜線——語法正確卻默默空轉的那一種，寫的當下攔不到 |
| `npm run controltest` | 不在 `npm test` 裡的檢查器，它們的判斷邏輯每版在這裡用合成樣本驗（不打網路）：`assertaudit`（一定失敗的斷言、空母體、寫出資料前就崩掉，都要判對；必過的乾淨測試不能被挑出來）、`sweep`（線上版本是舊的、讀不到版本、留著舊快取、真的錯誤被當成新聞上游雜訊，都要報；全部一致時什麼都不報）、`livecheck`（用 `scripts/fixtures/` 錄好的證交所回應，每個判斷一對：好的錄音不能報、故意改壞的錄音要報，不打證交所）；另做兩道孤兒檢查：`npm test` 鏈上的每一支都要在 `assertaudit` 的清單裡，或寫明不收的理由；`js/app.js` 註冊的每一條路由都要在 `scripts/routes.mjs` 的逐頁清單裡（`sweep` 與 `upgradecheck` 共用），或寫明不巡的理由 |
| `npm run checkmutations` | 突變清單的秒級檢查：判定邏輯（紅要紅在 `expect` 那一條）、每條 `expect` 都找得到、新突變一律帶 `expect` |
| `npm run gatescan` | 推送閘門、公開前自查、閘門驗法有沒有已知的壞寫法（管線吞結束碼、`\|\| true`、空 catch、`+++` 濾檔頭、取 diff 卻不取訊息與作者……）；登記制，對照組含本 App 真的出過事的原文；另做孤兒檢查：repo 裡看起來是推送、自查、閘門的腳本（含還沒 commit 的）都要登記或寫理由 |
| `npm run gateselftest` | 推送閘門驗法的自我測試（約 7 分鐘，不在 `npm test` 裡；改過 `gatepush.sh`／`gatetest.sh`／`gatereason.mjs` 之後跑）：把第零關改壞三種，看驗法是不是**剛好**報那幾種、驗法沒全過時舊登記有沒有被刪掉、兩種順序結論是否逐一相同 |
| `npm run mutationtest` | **突變測試**：把邏輯改壞，確認對應的測試真的會紅；帶 `expect` 的還要紅在含那段字的斷言上 |

`npm run mutationtest` 是這個專案的測試品質保證。每一條斷言都要能被突變證明它在檢查東西：

```
— 372 條突變：每一條都必須讓對應的測試變紅 —
  ✓ 把「沒成交」的漲跌價差照抄成 0 → parsetest 變紅
  ✓ 不認得除權息的 "X0.00" 標記 → parsetest 變紅
  ✓ 除權息日拿不到參考價時，退回用前一日收盤當基準 → settletest 變紅
  ✓ 把「待公告實際收益分配金額」當成 0 元 → dividendtest 變紅
  ✓ 結算時不理會除權息事件（不改用參考價） → eventtest 變紅
  ✓ 讓上櫃代號也「支援報價」 → datatest 變紅
  ✓ 拿掉 TWSE 請求的最小間隔 → throttletest 變紅
  ✓ 讓 h() 支援 html: prop → shelltest 變紅
  ✓ 定期定額扣款自動確認 → dcatest 變紅
  ✓ 把扣款日收盤價直接當成成交價 → dcatest 變紅
  ✓ 沒填成交價也更新平均成本 → plantest 變紅
  ✓ 試算器的欄位有預設值 → calcviewtest 變紅
  ✓ 試算器的 placeholder 放了範例數字 → calcviewtest 變紅
  ✓ 股數法把湊不滿一股的餘額丟掉 → calctest 變紅
  ...
```

突變的 `find` 字串在原始碼裡找不到（或找到多次）時，突變測試會**失敗**而不是略過——不然重構之後突變會靜默失效，那條斷言就再也沒被驗證過。
這件事不必等整套跑到那一條才知道：`npm run checkmutations` 不到一秒就把全部突變的 `find` 數一遍，每版都跑。

### 靜態資料

`data/stocks.json`（代號表）與 `data/calendar.json`（開休市日）由建置腳本從證交所資料產生，commit 進 repo（來源沒有 CORS，瀏覽器直打不到）：

```bash
npm run build-stocks     # 代號 → 名稱、市場、產業、證券類別（約 2,800 檔）
npm run build-calendar   # 當年交易日
```

`build-stocks` 會下載約 12 MB 的來源檔，可用 `--cache <目錄>` 保留原始回應避免重複下載。兩支腳本產出的內容都有出貨前檢查，不合格就不寫檔。

### 每版流程

1. 改動任何 SHELL 檔案 → bump `sw.js` 的 `VERSION`
2. `npm test`
3. commit / push（push main 即部署 GitHub Pages）
4. `curl` 確認線上版本號
5. 截圖放 `screenshots/features/`
