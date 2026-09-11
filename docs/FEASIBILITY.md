# StockDiary 可行性評估（附實測）

- 日期：2026-09-11（週五，盤中 09:10–09:40 台北時間實測）
- 測試位置：作者家用 IP（HiNet）、Cloudflare Workers 邊緣（`wrangler dev --remote` 暫時探針，測完即停，**沒有部署任何 Worker**）、Anthropic 美國 IP（WebFetch）。
- 結論一句話：**上市股票與新聞完全可行；上櫃股票是唯一的硬缺口，需要 GitHub Actions 排程或非官方來源補**；AI 摘要走 TripQuest 既有「自備金鑰、瀏覽器直連」模式，每月成本以美分計。

---

## 1. 台股報價／收盤資料

### 1.1 逐一實測結果

| 端點 | 給什麼 | 瀏覽器直打（CORS） | Cloudflare Worker 打 | 備註 |
|---|---|---|---|---|
| `www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=YYYYMMDD&stockNo=` | 上市個股**當月逐日** OHLC、量 | ✅ `Access-Control-Allow-Origin: *` | ✅ 200（0.26s） | 歷史回補的主力。當日資料何時出現未實測（盤中打今天只到昨天），社群經驗約 14:00–15:00 後 |
| `www.twse.com.tw/exchangeReport/TWT49U?response=json&strDate=&endDate=` | 上市**除權除息計算結果表**（含除權息前收盤、參考價、權值、息值、權／息） | ✅ ACAO * | ✅ 200 | 除權息自動偵測的資料源 |
| `www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=&type=IND` | 加權指數等各指數收盤、漲跌 | ✅ ACAO * | 未測（同主機） | 大盤脈絡 |
| `www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json` | 上市**全市場**當日收盤（含 ETF），~320KB，實際回 CSV | ✅ ACAO * | ✅ | 代號→名稱表可由此生成 |
| `www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=&selectType=ALL` | 個股本益比、殖利率、淨值比 | ✅ ACAO * | 未測 | 加值資訊 |
| `openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL` 等 OpenAPI | 同上 JSON 版；另有 `opendata/t187ap03_L`（上市公司基本資料）、`opendata/t187ap45_L`（股利分派，含發放日）、`holidaySchedule/holidaySchedule`（開休市日） | ❌ **無 ACAO**（OPTIONS 回 200 但無任何 CORS 標頭） | ✅ 200（310KB 花 4.3s） | OpenAPI 檔案 Last-Modified 為前一日資料於**隔日 05:20** 更新——不適合當天結算 |
| `mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw\|otc_6488.tw&json=1&delay=0` | **盤中即時**：最新成交 `z`、昨收 `y`、開 `o`、高 `h`、低 `l`、量 `v`、五檔、時間 `t`；**上市與上櫃同一支 API**；盤後 `z` 即當日收盤 | ❌ 無 ACAO；OPTIONS 回 405 | ✅ 200（上櫃代號也正常） | 一次 30 檔：20KB、0.19s。**非官方**：無文件、`robots.txt` 全站 Disallow、`Cache-Control: no-store`、隨時可能改格式或加驗證；**只有今天**，無歷史 |
| `www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=&date=YYYY/MM/DD&response=json` | 上櫃個股當月逐日 | ❌ 無 ACAO；OPTIONS 回 403 | ❌ **302 → `/errors`** | **櫃買擋 Cloudflare Workers**。換成 Chrome UA、curl UA 都一樣；從家用 IP 與 Anthropic 美國 IP 都能拿到 → 不是地區封鎖，是針對 Cloudflare Worker 的 WAF/Bot 規則（櫃買本身架在 Cloudflare 上） |
| `www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes`（全上櫃當日收盤 356KB）、`tpex_exright_daily`（上櫃當日除權息）、`mopsfin_t187ap03_O`（上櫃公司基本資料） | 上櫃收盤、除權息 | ❌ 無 ACAO | ❌ 302 → `/errors` | 同上 |
| `www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=&endDate=&response=json` | 上櫃除權息**區間**表（等同 TWSE TWT49U） | ❌ | ❌ | 同上；`bulletin/exRight` 已不存在 |
| `query1.finance.yahoo.com/v8/finance/chart/6488.TWO?range=1mo&interval=1d` | 上櫃歷史日線（`.TWO` 後綴；上市為 `.TW`） | 未測（一般認為無 ACAO） | ✅ 200（0.1s） | **非官方**、無 SLA；`adjclose` 口徑與除權息還原方式需自行處理，只當退路 |

### 1.2 頻率限制

- TWSE `www.twse.com.tw`：社群共識約 **3 次／5 秒**，超過會被封 IP 一段時間（多個開源套件內建此限速）。實測連打 6 次 200 未被擋。設計上一律 **≥ 2 秒一次、可快取的一律快取**（同一檔同一月只抓一次）。
- `mis.twse.com.tw`：無公開限制，但非官方；設計上**盤中 ≥ 15 秒才刷新一次、一次請求塞全部持股（一次 30 檔實測 OK）**，盤後只打一次。
- 櫃買：對 Cloudflare 直接封鎖，不是限速問題。
- 來源：[TW Market Data Platform 對 STOCK_DAY_ALL 的說明](https://twmarketdata.com/en/answers/twse-stock-day-all-endpoint-en)、[tw-stock-agent 的 rate limiter](https://glama.ai/mcp/servers/@clsung/tw-stock-agent/blob/c163d1d92b48bc813df49cbbf1419172fabbb85e/tw_stock_agent/utils/rate_limiter.py)、[HackMD：使用證交所 API 爬取股票資訊](https://hackmd.io/@aaronlife/python-ex-stock-by-api)。

### 1.3 盤中即時 vs 盤後收盤：各能拿到什麼

| 需求 | 上市 | 上櫃 |
|---|---|---|
| 盤中即時價（延遲數秒） | mis（經 Worker） | mis（經 Worker） |
| 當日收盤（13:30 後） | mis `z`（經 Worker）或 STOCK_DAY 當日列（直打） | mis `z`（經 Worker） |
| 歷史逐日（回補漏掉的日子） | STOCK_DAY 直打 | **無官方管道可用**（見 1.4） |
| 除權息表 | TWT49U 直打 | **無官方管道可用** |
| 代號→名稱 | STOCK_DAY_ALL 直打；mis 也回 `n` 名稱 | mis 回 `n` 名稱；全表需 GitHub Actions |

### 1.4 上櫃缺口的四條路

| 方案 | 可行性 | 代價 |
|---|---|---|
| (A) 只靠 mis 取「今日」，沒開 App 的日子留白 | 已驗證 | 損益曲線有洞；除權息全手動 |
| (B) mis 取今日＋Yahoo Finance 回補歷史 | Worker 端已驗證可通 | 非官方兩層疊加；Yahoo 對台股除權息還原口徑不透明 |
| (C) **GitHub Actions 每日排程**抓 TWSE＋TPEx 全市場收盤與除權息表，精簡後 commit 進 repo，由 GitHub Pages 同源提供 | **未驗證**（Anthropic 美國 IP 能通，推測 Azure IP 也能；一個 workflow 即可驗證） | 每日一個 commit（~60–100KB）；公開 repo 免費；資料延遲取決於排程時間 |
| (D) 家用電腦自架＋Cloudflare Tunnel（TripQuest 既有退路） | 家用 IP 已驗證能通 | 電腦要開機 |

**建議：先驗證 (C)；(C) 成立則它是主力，mis 只負責盤中／當日即時；(C) 不成立則退到 (B) 並明講「上櫃歷史來自非官方來源」。** 最終選擇見 PLAN.md（三代理投票）。

### 1.5 除權息、股票股利、分割對持股數與報酬率的影響

這是自製記帳最常算錯的地方，必須處理，否則「當日損益」在除息日會憑空出現一筆等於股利的假虧損。

| 事件 | 對股數 | 對成本／損益 | 資料源 | 怎麼處理 |
|---|---|---|---|---|
| **現金股利（除息）** | 不變 | 除息日股價下跌 ≈ 息值；「當日損益」必須以**除息參考價**（或「前收－息值」）為比較基準，並把應收股利記為**應收（未入帳）**，發放日轉為已實現 | 上市：TWT49U（參考價、息值）；發放日：`t187ap45_L` 的現金股利發放日；上櫃：`exDailyQ`／`tpex_exright_daily`（需 Actions） | 自動偵測 → 產生「待確認事件」→ 使用者一鍵套用（可改金額，因為券商實際入帳會扣匯費 10 元、單筆 ≥ 2 萬元扣 2.11% 二代健保補充保費） |
| **股票股利（除權）** | 增加：每 1000 股配 `每仟股配股數`；不足 1 股的畸零部分以現金找零 | 每股成本下降（總成本不變、股數變多）；當日損益以**除權參考價**為基準 | 同上（「權值」「每仟股配股」欄位） | 自動偵測 → 待確認事件 → 套用後股數更新，零股部分提示 |
| **現金增資 / 認購** | 依使用者實際認購 | 新增一筆買入交易 | 表中有「現金增資配股率」「認購價」 | 只提示，不自動；由使用者輸入 |
| **股票分割／反分割**（ETF 曾有案例） | 按比例乘除 | 每股成本按比例調整 | 無簡單表，需人工 | 提供「分割」交易型別，手動輸入比例 |
| **減資（現金減資／彌補虧損）** | 按比例減少 | 現金減資退回現金 → 視同部分賣出 | 無簡單表 | 手動交易型別「減資」 |

原則：**所有事件都是交易帳本裡的一筆記錄**，不直接改數字，這樣可追溯、可撤銷、可重算。

---

## 2. 純前端 PWA 直接打 API 會不會被 CORS 擋？

| 目標 | 直打 | 需要 Worker | Worker 也不行 |
|---|---|---|---|
| TWSE `www.twse.com.tw`（收盤、歷史、除權息、指數） | ✅ | | |
| TWSE OpenAPI `openapi.twse.com.tw` | | ✅ | |
| mis.twse.com.tw（即時） | | ✅ | |
| TPEx 全部 | | | ❌（Actions／自架／非官方） |
| 台灣新聞 RSS（中央社、鉅亨、自由、Yahoo、udn） | | ✅ | |
| CNBC、MarketWatch、NYT RSS | ✅（有 ACAO *） | | |
| BBC RSS | | ✅ | |
| Google News RSS | | | ❌（Google 對雲端 IP 回 503） |
| Anthropic API | ✅（帶 `anthropic-dangerous-direct-browser-access: true`，TripQuest 已實證） | | |

所以 **Worker 一定要有**（mis 即時、台灣 RSS），但可以做得很薄：純轉發＋快取，不解析大檔（免費方案每次 10 ms CPU，解析 300KB JSON 就逼近上限）。

### 2.1 Cloudflare 額度（免費方案，已查證 2026-09）

| 項目 | 免費額度 | 本 App 估計用量 |
|---|---|---|
| Workers 請求 | 100,000／日（全帳號共用，TripQuest 也在用） | 一人一天 < 200 |
| CPU | **10 ms／次，Cron 也是 10 ms** | 轉發＋快取 < 2 ms；**不能在 Worker 解析 300KB JSON** |
| Subrequests | 50／次 | RSS Cron 一次 8 個來源 |
| Cron Triggers | **5 個／帳號**（TripQuest 已用 1） | 新 Worker 用 1–2 個 |
| KV | 100k 讀／日、**1,000 寫／日**、1 GB、值 ≤ 25 MiB | 新聞每小時 1 寫 ≈ 20／日 |
| D1、R2 | 已啟用 | 本 App 不需要 |

新 App 必須是**獨立的 Worker**（`stockdiary`），不動 TripQuest 的 Worker。

---

## 3. 新聞來源

### 3.1 實測

| 來源 | 則數 | 家用 IP | Worker | 前端直打 | robots / 條款訊號 |
|---|---|---|---|---|---|
| 中央社財經 `feeds.feedburner.com/rsscna/finance` | 20 | ✅ | ✅ | ❌ | robots.txt **明示 `Content-signal: search=yes, ai-input=yes, ai-train=no`**——最乾淨的來源 |
| 鉅亨網台股 `news.cnyes.com/rss/v1/news/category/tw_stock` | 99 | ✅ | ✅ | ❌ | `User-agent: * Allow: /` |
| 自由財經 `news.ltn.com.tw/rss/business.xml` | 40 | ✅ | ✅ | ❌ | 擋 GPTBot／ClaudeBot 等**爬蟲**；RSS 開放 |
| Yahoo 股市 `tw.stock.yahoo.com/rss?category=tw-market` | 50 | ✅ | ✅ | ❌ | 擋 AI 爬蟲 UA |
| 經濟日報 `money.udn.com/rssfeed/news/1001/5591/5612?ch=money`；聯合 `udn.com/rssfeed/news/2/6644?ch=news` | 20 | ✅ | ✅ | ❌ | robots.txt **明文：內容不得用於 LLM／AI 或商業用途** |
| Google News RSS（台股搜尋） | 102 | ✅ | ❌ 503 | ❌ | 不用 |
| BBC Business | 55 | ✅ | ✅ | ❌ | |
| CNBC Top News、MarketWatch Top Stories、NYT Business | 30／10／49 | ✅ | ✅ | ✅（ACAO *） | NYT 條款禁 AI 使用內容 |
| 工商時報 RSS | — | ❌ 404 | — | — | 已停 |

### 3.2 版權與 robots 的界線

- RSS 是發布者主動提供的「標題＋連結＋摘要」聯合供稿格式，**顯示標題與連結、點擊導回原站**是它的設計用途，也是各家新聞 App／閱讀器的常態。
- 我們**只存標題、連結、來源、發布時間**（可選：RSS 自帶的一句摘要，但不建議存）；**不抓文章頁、不重製全文、不做全文快取**。
- robots.txt 規範的是爬蟲抓取頁面，不是 RSS 訂閱；但 **udn 在 robots 明文宣告內容不得作 AI 用途**，餵給 Claude 做摘要會踩線 → 建議 udn 二擇一：不接，或只顯示標題連結、不進 AI 輸入。中央社明示 `ai-input=yes` 是最安全的主力。
- 「AI 觀察」的輸入只有標題（每則 20–40 字），輸出是 Claude 自己的整理，不會重製任何一篇文章。
- 非商業、單一使用者、公開 repo 但無廣告。

---

## 4. AI 摘要成本（自備金鑰、瀏覽器直連）

定價（2026-09）：Haiku 4.5 $1/$5、Sonnet 5 $2/$10、Opus 5 $5/$25（每百萬 input／output token）。繁體中文約 1.3–2 token／字。

每日一次「新聞整理＋對持股的觀察」：

| 項目 | 估計 |
|---|---|
| 輸入：系統提示（規則、格式、免責）1.5k ＋ 60 則標題 3–4k ＋ 持股脈絡（代號、名稱、產業、當日漲跌）0.5–1k ＋ 大盤數字 0.2k | **5–8k token** |
| 輸出：600–1000 字繁中 | **1.5–2.5k token** |

| 模型 | 每次 | 每月（22 交易日） | 每年 |
|---|---|---|---|
| Haiku 4.5 | $0.013–0.02 | $0.3–0.45 | ~$5 |
| **Sonnet 5** | $0.025–0.04 | **$0.55–0.9** | ~$10 |
| Opus 5 | $0.06–0.1 | $1.4–2.2 | ~$25 |

- 若加 `web_search`（讓 Claude 自己補查國際大事）：每次搜尋 $0.01，每日 3–5 次 → 每月多 $0.7–1.1，且輸入 token 增加 2–4 倍。
- 「問一下這則新聞跟我持股的關係」這類追問：每次 2–4k 輸入、0.5k 輸出 → Sonnet 5 約 $0.01。
- 系統提示固定放最前面可用 prompt cache（Sonnet 5 最小可快取前綴約 1–2k token，剛好邊緣），每日一次的用法快取意義不大，不必特別設計。
- **不需要伺服器排程跑 AI**：金鑰只在使用者手機，摘要在使用者開 App 時生成（10–20 秒），存 IndexedDB，同一天不重生成。

---

## 5. 「每日結算當天總收益」的定義（先釘死）

| 名稱 | 定義 | 使用者通常想看的時機 |
|---|---|---|
| **當日損益** | Σ 持股 × (今日收盤 − 前一交易日收盤)，除權息日以**參考價**代替前收；＋當日賣出的已實現損益；＋（可選）當日除息的應收股利 | 每天 13:30 後看一眼——**這是使用者原話「每日結算當天總收益」最貼近的東西** |
| **未實現損益** | Σ 持股 × 今日收盤 − 持股成本（含買入手續費，平均成本法） | 看整體部位 |
| **已實現損益** | 歷次賣出（扣手續費、證交稅）− 對應成本 | 月／年結 |
| **累積股利** | 已入帳現金股利（扣匯費、健保補充保費）；應收股利另列 | 存股族最在意 |
| **總報酬** | 未實現 ＋ 已實現 ＋ 累積股利 | 整體績效 |
| **報酬率** | 總報酬 ÷ 累積投入成本（簡單）；年化（XIRR）列為 v2 | |

建議：**當日損益放首頁最上面（那是每日打開的理由），其餘四個放「總覽」頁**。全部都做，因為它們共用同一本帳，多一個定義只是多一個公式。

成本法：**平均成本法**（與台灣券商 App 庫存頁一致，使用者對得起來）；FIFO 對台股個人投資人沒有稅務意義（證券交易所得停徵），不做。

手續費預設 0.1425%（可設折扣）、證交稅賣出 0.3%（ETF 0.1%）、最低手續費 20 元——全部可在設定頁改。

---

## 6. 「我的看法」的界線

Claude 不是持牌投資顧問。App 內定位為「**資訊整理與觀察**」，不是投資建議。

**可以**：
- 把新聞分成「與你的持股直接相關／產業相關／總體環境」，說明**為什麼**相關（供應鏈、客戶、同業、利率、匯率）。
- 描述事實：「這則消息在盤中已反映，2330 今日 −1.2%，大盤 −0.5%」。
- 提歷史脈絡：「過去類似事件市場的反應通常是…」，並標明是過去經驗、不保證重現。
- 指出「值得留意的日期」：法說會、除息日、財報、FOMC、CPI。
- 提醒風險集中：「你的持股 70% 在半導體，這則新聞影響的是整個族群」。

**不可以**：
- 買／賣／加碼／減碼／停損／停利的建議，或任何「該怎麼做」。
- 目標價、支撐壓力位、預測明天／下週漲跌。
- 「看好／看壞」這種帶方向的判斷用於個股。
- 引用不存在的新聞或數字（幻覺）——輸入只給標題，要求引用時只能引用給它的標題編號。

**UI 呈現**：
- 區塊標題固定叫「今日觀察」，不叫「看法」「建議」「分析師觀點」。
- 每段觀察下方以小字列出引用的新聞編號（可點回原文）。
- 區塊底部固定一行：「由 AI 整理，僅供參考，不構成投資建議。資料來源與時間：…」。
- 系統提示要求輸出 JSON 結構（用 `output_config.format`），前端渲染時對「建議買」「目標價」等詞做**輸出端過濾**並記錄，測試中要有對照組確保過濾器真的會抓。
- 第一次啟用 AI 時顯示一次性的說明頁，講清楚「這不是投資建議」與金鑰費用由誰付。

---

## 7. 測試慣例（沿用 TripQuest）

- 每條斷言都要能「改壞會紅」：損益公式的測試要用手算過的固定案例（含除息日、除權日、部分賣出、零股），並做**突變驗證**（把除息參考價邏輯拿掉，測試必須紅）。
- 檢查器要有**對照組**：輸出過濾器（禁用詞）餵已知該被抓的句子，斷言真的抓到。
- 外部請求全部有逾時（`AbortSignal.timeout`）與降級：TWSE 掛了 → 顯示「今日收盤尚未取得」，不顯示 0。
- 打真網路的測試（TWSE、mis、RSS）不進 `npm test`，另開 `npm run livecheck`。
- `layouttest` 式的版面掃描：損益數字在特大字級下最容易擠壓（「+12,345」「−0.52%」並排）。

---

## 8. 未驗證、需觀察的事項

1. GitHub Actions 的 Azure IP 是否能連櫃買（一個 workflow 可驗；Anthropic 美國 IP 可通，推測可行）。
2. TWSE `STOCK_DAY` 當日列出現的實際時間（需在 13:30–16:00 間觀察一次）。
3. `mis.twse.com.tw` 對 Cloudflare 邊緣 IP 的長期容忍度（目前單次 OK；設計上每 15 秒以上才刷新、盤後一次）。
4. 上櫃除權息表若走 Actions，表格欄位名稱與 TWSE 不同，要各寫一個解析器並用固定樣本測。

---

## 9. 第二輪補測（2026-09-11 09:40，回應使用者第一輪回覆）

### 9.1 除權息日曆的正確資料源
- `TWT49U`（除權除息**計算結果表**）只含**已發生**的除權息日：查 9/12–10/31 只回 9/10 的 6 筆。**不能當日曆用。**
- `www.twse.com.tw/exchangeReport/TWT48U?response=json`（除權除息**預告表**）：✅ `Access-Control-Allow-Origin: *`，不帶參數回全部未來公告，實測 72 筆、日期從 9/9 列到 10/28（約 7 週），欄位：除權除息日期、代號、名稱、權／息、無償配股率、現金增資配股率、認購價、現金股利、參考價試算。**日曆用 TWT48U，除息當天的參考價用 TWT49U。**
- `rwd/zh/afterTrading/TWT48U` 回 302，用 `exchangeReport/TWT48U`。

### 9.2 零後端可行性
使用者只在盤後看、開頁更新一次 → 不需要 mis.twse 即時。v1 的價格、結算、除權息、指數、AI、CNBC／MarketWatch 全部可前端直打（見 PLAN.md §3 表）。**唯一需要後端的是國內新聞 RSS（無 CORS）**，最小範圍是一個無狀態轉發 Worker（白名單來源、10 分鐘快取、無 KV、無 Cron）。

### 9.3 尚未驗證
- TWSE `STOCK_DAY_ALL` 與 `STOCK_DAY` 當日列出現的實際時間（本次實測都在盤中，仍是前一日）。開發時要在 13:30–16:00 觀察一次，決定 §4.1 的「≥ 14:30 才抓」門檻。

---

## 10. M0 開發期實測（2026-09-11，Opus 5）

開發 M0 時逐一打過每個要用的端點，記錄與規劃階段不同或規劃階段沒測到的部分。

### 10.1 回應格式：三個會讓數字變假的細節

| 發現 | 實際回應 | 為什麼重要 | 程式怎麼處理 |
|---|---|---|---|
| **當日無成交的證券，價格欄是空字串，漲跌價差卻寫 `0.0000`** | `"1150910","00625K","富邦上証+R","","","","","","","0.0000",""`（2026-09-10 全市場 1,379 檔中有 12 檔如此） | 照抄的話畫面會出現一筆看起來完全正常的「持平」。這是 STATUS「最容易做錯的事」第 2、5 條的共同源頭 | `parseStockDayAll` 對沒成交的列讓 `close` 與 `change` **都回 null**，並回報 `untraded` 檔數 |
| **除權息日的漲跌價差是 `"X0.00"`** | 2330 於 `115/06/11` 除息：前一交易日收 2255、當日收 2250、漲跌價差 `X0.00` | 解成 0 → 顯示假持平；用 2250−2255 = −5 當當日損益 → 少算掉股利。STATUS「最容易做錯的事」第 1 條 | `parseStockDay` 標 `exMark: true` 並讓 `change` 回 **null**，強迫上層改用 TWT49U 參考價（M2） |
| **`STOCK_DAY_ALL` 與 `STOCK_DAY` 的日期格式不同** | `1150910`（民國緊湊）vs `115/09/10`（民國斜線） | 共用一個解析器會整批解不出來 | `js/roc.js` 三種格式各有函式，`anyRocToISO` 自動判斷 |

另外：`STOCK_DAY_ALL` 的數字**沒有**千分位逗號，`STOCK_DAY` 的**有**（`28,931,697`）；`STOCK_DAY_ALL` 的漲跌價差負數帶 `-`、正數**不帶** `+`（`0.0500` 是 +0.05），`STOCK_DAY` 則是 `+25.00` / `-50.00` / `" 0.00"` / `"X0.00"` 四種。

### 10.2 上櫃代號與不存在的代號，TWSE 回應完全相同

```
STOCK_DAY?date=20260901&stockNo=6488  → {"stat":"很抱歉，沒有符合條件的資料!","total":0}   # 上櫃
STOCK_DAY?date=20260901&stockNo=9999  → {"stat":"很抱歉，沒有符合條件的資料!","total":0}   # 不存在
```

**光靠端點分不出「這是上櫃、我們不支援」和「你打錯字」**，所以 `data/stocks.json` 不是加值功能，是必要條件。PLAN §2.4 的兩種文案要靠這張表才分得出來。

### 10.3 `data/stocks.json` 的產業別名稱：規劃指定的來源拿不到

PLAN §2.1 指定用 `t187ap03_L`（上市）與 `mopsfin_t187ap03_O`（上櫃）產代號表。兩者的「產業別」欄位都只有**兩位數代碼**（2330 與 6488 都是 `24`），**沒有名稱**，而 PLAN 要求 `stocks.json` 帶「產業」（集中度圖與 AI 輸入都要用）。

補的來源：`isin.twse.com.tw/isin/C_public.jsp?strMode=2|4|5`（上市／上櫃／興櫃 ISIN 一覽表，Big5 HTML）。它每一檔直接給**產業別名稱**與**證券類別**（股票／ETF／ETN／特別股／創新板／TDR／權證）。

代碼→名稱不是硬編的，是 join 出來的：把 (1)(2) 的「代號→代碼」與 ISIN 的「代號→名稱」對起來，1,985 家公司導出 **34 個代碼，零衝突**；任何代碼對到兩個名稱就整份失敗，不猜。

其他選項是逐一打 `MI_INDEX?type=01..38`（35 個請求到限速主機）才能從表格標題取到名稱——ISIN 表只要 3 個請求，而且順便解決 ETF 分類。

三萬多筆認購（售）權證不放進 `stocks.json`（使用者不會持有，而且會讓檔案大四倍）。

**創新板**（`2237 華德動能-創` 等 30 檔）在 ISIN 表標「上市臺灣創新板」，但它們確實在集中市場成交、也出現在 `STOCK_DAY_ALL`，所以市場別記「上市」（可以抓價），`type` 保留「創新板」。

產出：2,768 檔（上市 1,383／上櫃 1,022／興櫃 363；ETF 360），241 KB。

### 10.4 開休市日：推算結果已用實際成交日核對

`holidaySchedule` 那張表混了兩種公告，不能一律當休市：

- 休市：「依規定放假1日」「市場無交易，僅辦理結算交割作業」
- **照常交易**：「國曆新年開始交易日」「農曆春節前最後交易日」「農曆春節後開始交易日」（2026 年有 3 筆）

判斷規則：名稱含「開始交易／最後交易／補行交易」→ 照常交易，其餘皆休市。

推算出 2026 年 243 個交易日後，用 2330 的 `STOCK_DAY` 實際成交日核對**最容易錯的兩個月**：

| 月份 | 難在哪 | 結果 |
|---|---|---|
| 2026-02 | 農曆春節（2/12–2/20）＋ 和平紀念日 2/27 補假 | 12 天，**與 TWSE 實際成交日完全一致** |
| 2026-04 | 兒童節／掃墓節 4/3 補假 ＋ 4/6 補假 | 20 天，**完全一致** |

`npm run livecheck` 每次都會自動挑「已過去且平日休市最多的兩個月」重跑這個核對（不寫死月份，否則明年會去查未來日期）。

### 10.5 TWT48U 的實際欄位（M2 會用到）

```
除權除息日期、股票代號、名稱、除權息、無償配股率、現金增資配股率、
現金增資認購價、現金股利、詳細資料、參考價<br>試算、
最近一次申報資料 季別/日期、最近一次申報每股 (單位)淨值、最近一次申報每股 (單位)盈餘
```

2026-09-11 實測 72 筆，`Access-Control-Allow-Origin: *`。注意「參考價<br>試算」欄名裡真的有 `<br>`。

### 10.6 頻率

`npm run livecheck` 對 `www.twse.com.tw` 打了 8 次請求、實測間隔全部 ≥ 2,202 ms，未被擋。建置腳本對 `openapi.twse.com.tw`、`isin.twse.com.tw`、`www.tpex.org.tw` 各 1–3 次，間隔 2.5 秒。

### 10.7 尚未完成

- **TWSE 當日收盤的實際公布時間**：2026-09-11 13:25–16:00 觀察中（`scripts/observe-twse-publish-time.mjs`，每 5 分鐘一輪，紀錄寫 `docs/measurements/twse-publish-2026-09-11.jsonl`）。在此之前 `settings` 的「今日資料公布門檻」暫定 **15:00**。
