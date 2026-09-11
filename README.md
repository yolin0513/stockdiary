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

**M0 完成。** 開發順序、驗收條件與工作慣例見 `docs/STATUS.md`。

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
| `npm run datatest` | `data/*.json` 內容與代號支援判斷 |
| `npm run shelltest` | PWA 殼稽核：import 圖 ⊆ SW SHELL、`h()` 不接受 `html:` prop、每條路由畫得出東西 |
| `npm run mutationtest` | **突變測試**：把邏輯改壞，確認對應的測試真的會紅 |

`npm run mutationtest` 是這個專案的測試品質保證。每一條斷言都要能被突變證明它在檢查東西：

```
— 17 條突變：每一條都必須讓對應的測試變紅 —
  ✓ 把「沒成交」的漲跌價差照抄成 0 → parsetest 變紅
  ✓ 不認得除權息的 "X0.00" 標記 → parsetest 變紅
  ✓ 讓上櫃代號也「支援報價」 → datatest 變紅
  ✓ 讓 h() 支援 html: prop → shelltest 變紅
  ...
```

突變的 `find` 字串在原始碼裡找不到（或找到多次）時，突變測試會**失敗**而不是略過——不然重構之後突變會靜默失效，那條斷言就再也沒被驗證過。

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
