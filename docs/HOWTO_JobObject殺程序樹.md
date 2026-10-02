# 怎麼在 Windows 上把一整棵程序樹殺乾淨（Job Object）

寫給 MealMate、TripQuest（以及任何用 Node 跑測試、要在逾時時停掉子程序的 App）。StockDiary 2026-10-03 實作並實測；
程式在 `scripts/jobhelper.ps1`、`scripts/jobrun.mjs`，測試在 `scripts/jobtest.mjs`，可以整份抄過去。
每一點後面標【實測】或【推論】（共用慣例 §0.6）。

## 1. 要解決什麼

「殺程序不要靠父程序編號往下找子孫」（v11.6 §5.19）。照父程序編號（ppid）往下找、或只用 handle 殺直接開的那一支，有兩種會漏：

- **漏一：經 Git Bash 開的孫程序。** 殺掉直接開的 bash，它開的 `sleep`（換成真實情況：git、node）還活著。【實測：2 個 sleep 殺完剩 2】
- **漏二：中間那一支用 `detached` 開了目標、自己先結束。** 目標的父程序已經不在，照 ppid 往下找只找得到根。【實測：殺完目標剩 1】
- 對照：node 直接開、沒有 `detached` 的子孫**不會漏**——Node 在 Windows 上把子程序放進它自己的 Job，父程序一死就連帶殺。【實測】
  但 Node 那個 Job 准許孫程序「靜默脫離」，所以隔一層（bash 開的、detached 開的）就漏了。【推論：libuv 的旗標；行為與實測一致】

## 2. 做法：一支協助程序＋一支包裝

Job Object 是 Windows 核心的東西：放進去之後開的每一個子孫**自動**屬於同一個 Job，**不看父程序編號**；Job 的最後一個 handle 關掉時，
設了 `KILL_ON_JOB_CLOSE` 的話，裡面的程序全部被殺。

- `jobhelper.ps1 -TargetPid <pid>`：PowerShell 用 P/Invoke 建 Job、設旗標、把 `<pid>` 放進去，印 `JOB-OK <pid>`，然後一直讀標準輸入；
  標準輸入被關掉（開它的程序結束或被殺）就結束——它手上的 Job handle 跟著關掉。失敗印 `JOB-FAIL <原因>`、回 1。
- `node jobrun.mjs <指令> [參數…]`：開 jobhelper、叫它把 **jobrun 自己**放進 Job，**等到 `JOB-OK` 才開指令**；回傳碼＝指令的回傳碼；
  Job 建不起來回 97（呼叫端當「情境未成立」，不照跑）。
- 呼叫端（測試框架、突變跑器）把原本的 `node 某測試.mjs` 換成 `node jobrun.mjs node 某測試.mjs`；逾時時**照舊用 handle 殺 jobrun 那一支就好**。

### 為什麼要協助程序【實測＋推論】

Node 沒有建立 Job Object 的 API（沒有內建模組做得到；要裝原生套件才行，四個 App 都不裝）。PowerShell 每台 Windows 都有、能 `Add-Type` 編一小段 C# 去呼叫
`kernel32.dll`。代價是每次多起一個 PowerShell，【實測】約 0.85 秒。

### 為什麼順序很重要【推論＋突變實測】

**先把要跑測試的那一層 node 放進 Job、再由它開測試——沒有先開了才放進去的空檔。**
Job 只管「放進去之後才開的」子孫；放進去之前已經開出來的不會被追溯收進來。如果反過來（先開測試、再把測試放進 Job），
測試在被放進去之前那不到一秒裡開的子孫就在 Job 外面——而且平常看不出來，只有剛好在那段空檔裡開子程序時才漏。
【實測】突變「不等 JOB-OK 就開指令」（jobrun 一開就跑指令，跟協助程序賽跑）：四種情境全部漏，`jobtest` 紅。

### 為什麼殺 jobrun 就夠【實測】

jobhelper 是 jobrun 用 Node 開的，jobrun 一死它跟著死（Node 自己的 Job）→ 它的標準輸入關掉、handle 關掉 → 我們的 Job 關閉 → 整棵樹被殺。
jobrun 正常結束時也一樣：指令留下來的背景程序一起被收掉。【實測：正常結束留下的 sleep 剩 0】

## 3. 旗標：只設 KILL_ON_JOB_CLOSE，不准脫離

`JOBOBJECT_EXTENDED_LIMIT_INFORMATION`（`SetInformationJobObject` 第 9 類）的 `LimitFlags`：

- 設 `0x2000`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）。
- **不設** `0x800`（`BREAKAWAY_OK`）、**不設** `0x1000`（`SILENT_BREAKAWAY_OK`）。不准脫離，`detached` 開的也逃不掉。
  【實測】detached 照樣開得起來（不會因為不准脫離而開不了），殺完剩 0。
- `OpenProcess` 要 `PROCESS_SET_QUOTA | PROCESS_TERMINATE`（`0x0100 | 0x0001`）。
- 【實測】突變「准許靜默脫離」（加 `0x1000`）：四種情境全部漏，`jobtest` 紅。
- 【實測＋推論】突變「拿掉 `0x2000`」**沒紅**：jobrun 是 node，孫程序被我們的 Job 擋住、脫離不了 Node 自己那個 Job（它設了連帶殺），
  jobrun 一死就被 Node 的 Job 收掉。兩道共同守著，單拿掉 `0x2000` 會被補上——這是等價突變（§5.12），不要為它補斷言；
  但 `0x2000` 要留著，給「包裝層不是 node」的情況用。**抄過去時如果包裝層不是 node**（例如 PowerShell 直接包），這條突變就該紅，要重新驗。

## 4. 驗法（抄過去之後一定要自己跑一次）

`jobtest.mjs` 的結構，每一項都有前提或對照：

1. **查詢本身的對照**：程序表查得到外層標記、也查得到內層標記（標記在原始碼裡拆開拼，外層的指令列不會被算成內層）。
2. **漏一（Git Bash）**：對照組不經 jobrun，殺掉 bash 之後 sleep 還有 2 個（證明這個情境真的會漏）；經 jobrun，殺之前 2 個（前提）、殺掉最外層之後 **0 個**。
3. **漏二（detached）**：對照組不經 jobrun，目標還活著；經 jobrun，殺之前活著（前提）、殺完 **0 個**。
4. cmd.exe 再開 node（`npx` 那類）：殺完 0 個。
5. 正常結束：指令回 0，留下的背景程序也被收掉。
6. 回傳碼照傳。

突變（放在突變清單裡，每條都要實跑變紅）：

- **拿掉「放進 Job」**（jobhelper 不呼叫 `AssignProcessToJobObject`、照樣印 JOB-OK）→ 必須紅。【實測：四種情境一起紅】
- **不等 JOB-OK 就開**（順序反過來）→ 必須紅。【實測】
- **准許靜默脫離**（`0x2000 | 0x1000`）→ 必須紅。【實測】
- 拿掉 `0x2000`：包裝層是 node 時是等價突變（見 §3），包裝層不是 node 時要紅。

## 5. 還沒做、做不到的【照實寫】

- **非 Windows**：沒有 Job Object，jobrun 直接跑，漏殺沒有處理（要做的話是 process group＋`kill(-pgid)`，StockDiary 沒做、沒驗）。
- 呼叫端若用 `taskkill /T` 或照 ppid 往下找，接上 jobrun 之後就不需要了；StockDiary 的 `proctree.mjs`（建立時間＋名稱清單）還留著給 `workertest` 當第二道。
- 起 PowerShell 的 0.85 秒：每支測試都包的話，突變整套每條多約 1 秒。
- 執行原則：`-ExecutionPolicy Bypass` 只對這一次呼叫有效，不改系統設定。【推論：PowerShell 文件的行為，沒在受限的機器上試過】
- StockDiary 這邊 `workertest`（起 wrangler）與 `gateselftest` 改了呼叫方式、還沒實跑。
