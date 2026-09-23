# SPEC 草稿：交接時規劃中但還沒動工的小項目

- 狀態：**草稿。** 寫於 2026-09-18（交接整理）。前兩項不必等 Yolin 就能做；後兩項要等他的回覆或決定。
- 共同規則照 `docs/STATUS.md`：新斷言用突變證明會紅、含特殊字元的程式碼用 Write 工具寫、做完部署並逐項回報。

## 1. `doctest` 補正則（不必等 Yolin，S）

> **已由 `SPEC_測試可信度.md` 取代並執行（2026-09-23，D1）。** 下面保留原文，不要再照著做。

**問題**：突變條數的正則只認 `(\d+)\s*條突變`。上線檢查清單以前寫「突變 185 條」，所以它漂到 185 而 doctest 全綠（實際 234）。
交接時已經把那一行改成「234 條突變」的寫法，但**其他寫法照樣會漏**。支數的正則也只認三種寫法。

**做法**：
- 突變條數加認 `突變\s*(\d+)\s*條`。
- 反過來也要防誤判：「14 個測試檔」這種不是總數的寫法不可以被當成支數（交接時就差點踩到 —— 「N 支測試」會被抓去比總數）。建議把「文件裡寫總數」的地方收斂成固定寫法，並在 doctest 旁邊註明。
- 突變：把 STATUS 裡「突變 N 條」寫法的數字改錯 → doctest 要紅。

## 2. A14 延伸：其餘 31 條母體 ≤ 2 的斷言（不必等 Yolin，S～M）

> **已由 `SPEC_測試可信度.md` 取代並執行（2026-09-23，D2）。** 結果寫在 STATUS「測試範圍」那一節。下面保留原文，不要再照著做。

**背景**：`npm run assertaudit` 產出的 `assert-audit.jsonl`，母體 ≤ 2 的斷言共 58 條。
`SPEC_全面優化.md` A14 只指定 uikittest、pathtest、calcviewtest、holdingtest 那 27 條，已在 v0.7.16 複查（6 條改、21 條確認沒問題）。
其餘 31 條分布在 parsetest、settletest、changestest、dividendtest、plantest、datatest、eventtest、dcatest、newstest、secret-leak-test、insighttest、concentrationtest、divrecordtest、scenariotest（以及 doctest 新增的 3 條）。

**做法**：先重跑 `npm run assertaudit` 拿最新清單，逐條問兩件事：
1. 母體是**一個字串**（`noneOf([text], 正則)`）的話，那個字串有沒有非空保證？沒有就補前提。
2. 母體是不是「有問題的那幾個」而不是全部？是的話改成全部（慣例 12）。
另外留意 A14 找到的另一種形狀：**母體取自上一個情境的畫面**（holdingtest 的報酬率那條就是）。
修過的每一條都要用突變證明會紅；確認沒問題的列表回報。

## 3. B4 備援：iPhone 主畫面 App 匯出存不下來時（**等 Yolin 實機結果**，S）

> **B4 已結案（Yolin 2026-09-21 實機確認匯出存得下來），不做。**（依據是統籌者在 `SPEC_測試可信度.md` §D 的轉述。）

**觸發條件**：Yolin 在主畫面 App 裡按「匯出備份檔」，檔案 App 裡找不到。

**做法**（`SPEC_全面優化.md` §4 B4 的選項 b）：
- 匯出時先試 `navigator.canShare({ files: [file] })` → `navigator.share({ files })`；不支援或使用者取消才退回 `<a download>` ＋ Blob。
- 畫面講清楚「會跳出分享面板，選『儲存到檔案』」。
- 測試：backuptest 注入假的 `navigator.share` 驗「支援時走 share、不支援時走 download」；突變：永遠走 download → 紅。
- **不能**把備份傳到任何伺服器（`secret-leak-test` 的精神）。

## 4. 舊盤點 C1：設定頁分區收合（**等 Yolin 決定要不要做**，M）

**背景**：v0.7.13 前後量到設定頁 2,382px ≈ 2.8 個螢幕；批次 2 之後又多了用量上限欄位、回補進度、日曆與代號表提醒。

**草案**：
- 常用的留在上面展開：字級、股利開關、今日資料公布門檻。
- 低頻的收進可收合區塊（沿用 `.collapse-head`）：AI 金鑰、備份、資料來源與狀態、關於。
- **警示類不可以被收起來**：日曆快用完、代號表過期、主畫面／Safari 不共用資料 —— 要嘛留在外面，要嘛收合標題上直接顯示「有 1 則提醒」。
- 測試：layouttest 照掃；uikittest 的「設定頁每個控制項都點得到」要改成先展開再掃；新增「警示在收合狀態下仍看得到」的斷言與突變。
