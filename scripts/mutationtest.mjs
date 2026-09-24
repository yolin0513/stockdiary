// 突變測試（npm run mutationtest）。
//
// 為什麼需要這個：一條「跑得過」的斷言，可能根本沒在檢查東西。
// 註解說它在防什麼不算數；要證明它有用，唯一的方法是**把對應的邏輯改壞，看它會不會紅**。
//
// 這支程式對每一條突變做三件事：
//   1. 確認要改的那段程式碼在檔案裡**剛好出現一次** —— 找不到就代表這條突變過期了，
//      那本身是失敗（不然重構之後突變會靜默失效，測試就再也沒被驗證過）
//   2. 改壞、跑指定的測試、確認它**真的失敗**
//   3. 還原，並比對內容與原檔一模一樣
//
// 開頭還會先跑一次「沒有突變」的基準：所有測試必須是綠的。
// 少了這一步，一個「永遠回報失敗」的壞測試也會讓每條突變看起來都通過。
//
// ⚠ **這支程式執行期間會暫時改寫工作目錄裡的原始碼**（改完立刻還原）。
//   所以跑的時候不要同時編輯檔案、也不要並行跑別的測試 ——
//   那會讓基準或某幾條突變出現假性失敗，而且看起來很像真的壞了。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done , note } from './tap.mjs';
import { selectAffected, moduleClosure } from './affected.mjs';
import { judge, countOf, applyMutation } from './mutjudge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 版本號每 bump 一次就會變。突變字串寫死版本的話，每 bump 一次就會有幾條突變
// 「找不到要改的程式碼」而過期 —— 那等於對應的斷言悄悄地不再被驗證。所以從檔案讀。
const APP_VERSION = /APP_VERSION = '([^']+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];

const MUTATIONS = [
  {
    name: '把「沒成交」的漲跌價差照抄成 0',
    why: 'TWSE 對當日沒成交的證券把漲跌價差寫成 "0.0000"。照抄的話，畫面會出現一筆看起來很正常的「持平」。',
    file: 'js/twse.js',
    find: 'change: traded ? num(r[9]) : null,',
    replace: 'change: num(r[9]),',
    test: 'parsetest',
    expect: "漲跌是 null —— 原始回應寫",
    alsoRed: ["**12 檔沒成交的，價格與漲跌全部是 null**","沒成交的列裡沒有任何一個 0"],
    alsoRedWhy: "沒成交那一列的漲跌變成 0：單看那一檔、看全部 12 檔、看「沒有任何一個 0」三條，看的是同一批值。",
  },
  {
    name: '把空字串的數字當成 0',
    why: '沒公布、沒成交、查不到，全部會變成 0 —— 這是「今日收盤尚未公布時顯示 0」的源頭。',
    file: 'js/twse.js',
    find: "if (t === '' || t === '--' || t === '---') return null;",
    replace: "if (t === '' || t === '--' || t === '---') return 0;",
    test: 'parsetest',
    expect: "空字串不能變成 0",
    alsoRed: ["非數字一律 null","\"--\" 不能變成 0","01010T 當天沒有成交","收盤價是 null","開盤價是 null","漲跌是 null —— 原始回應寫","沒成交的檔數有被數出來","**12 檔沒成交的，價格與漲跌全部是 null**","沒成交的列裡沒有任何一個 0","有成交股數但沒有收盤價的，一律算沒成交","有成交的列都有正的收盤價","（對照）有成交 ","指數是 \"--\" 時解成 null"],
    alsoRedWhy: "num() 是所有欄位共用的解析：空字串與 -- 變成 0 之後，收盤價、開盤價、漲跌、「有沒有成交」的判斷、大盤指數都從它來，一起錯。",
  },
  {
    name: '不認得除權息的 "X0.00" 標記',
    why: '除權息日 TWSE 回 "X0.00"。當成持平的話，除息日會生出一筆等於息值的假虧損（或假持平）。',
    file: 'js/twse.js',
    find: 'const exMark = /X/i.test(rawChange);',
    replace: 'const exMark = false;',
    test: 'parsetest',
    expect: "這個月有一天除權息",
  },
  {
    name: '欄位順序變了還硬解',
    why: '欄位錯位解出來的數字看起來都很正常，但每一個都是別欄的值。',
    file: 'js/twse.js',
    find: 'throw new Error(`STOCK_DAY_ALL 欄位與預期不同：第 ${i + 1} 欄是「${r[i].trim()}」，預期「${SDA_HEADER[i]}」`);',
    replace: 'continue;',
    test: 'parsetest',
    expect: "代號與名稱對調 → 丟錯",
  },
  {
    name: '民國年換算差一年',
    why: '日期差一年，回補與除權息對照全部會對到錯的資料。',
    file: 'js/roc.js',
    find: 'const ROC_OFFSET = 1911;',
    replace: 'const ROC_OFFSET = 1912;',
    test: 'roctest',
    expect: "民國 99 年（7 碼補零）",
    alsoRed: ["STOCK_DAY_ALL 的 7 碼格式","民國 99 年（6 碼）","STOCK_DAY 的斜線格式","月日沒補零也要能解","中文年月日格式","anyRocToISO 認得中文格式","anyRocToISO 認得斜線格式","anyRocToISO 認得緊湊格式","2024 是閏年，2/29 存在","ISO → 7 碼民國","ISO → 斜線民國"],
    alsoRedWhy: "ROC_OFFSET 是每一種格式、兩個方向共用的常數，差一年，每一條換算都差一年。",
  },
  {
    name: '忽略「今日資料公布門檻」，盤中就去抓今天',
    why: '門檻前抓今天只會拿到昨天的資料，接著被當成今天 —— 使用者會看到一筆假的當日損益。',
    file: 'js/market.js',
    find: 'if (isTd && mins >= threshold) return today;',
    replace: 'if (isTd) return today;',
    test: 'roctest',
    expect: "交易日盤中 → 最新應有收盤是昨天",
    alsoRed: ["門檻前一分鐘 → 還是昨天"],
    alsoRedWhy: "兩條都是門檻之前的時刻：盤中與門檻前一分鐘。",
  },
  {
    name: '把每一天都當成交易日',
    why: '休市日會被算成「缺漏日」，程式就會去打 TWSE 回補一堆不存在的日子。',
    file: 'js/market.js',
    find: 'return cal.set.has(iso);',
    replace: 'return true;',
    test: 'roctest',
    expect: "9/12 週六不是交易日",
    alsoRed: ["9/25 中秋節不是交易日","休市判斷有對照組","週六晚上 → 最後一個交易日是週五","中秋節晚上 → 9/24","週六不是「今日收盤尚未公布」，是休市","中秋節不是「尚未公布」，是休市","2027-01-01 不是（元旦）"],
    alsoRedWhy: "「是不是交易日」是每一條日期推算的基礎：週末、國定假日、跨年、最後一個交易日、「尚未公布」與「休市」的區分都靠它。",
  },
  {
    name: '用 toISOString 取今天（時區差一天）',
    why: '台北時間早上八點以前，toISOString() 會給出前一天 —— App 整天都在算昨天。',
    file: 'js/roc.js',
    find: "return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;",
    replace: 'return d.toISOString().slice(0, 10);',
    test: 'roctest',
    expect: "早上七點半仍然是 9/11",
    alsoRed: ["（對照）toISOString() 在這個時刻確實會給出不同的日期"],
    alsoRedWhy: "對照組證明 toISOString 在這個時刻會給出不同的日期；突變把取今天改成它，兩條看的是同一個時刻。",
  },
  {
    name: '讓上櫃代號也「支援報價」',
    why: '上櫃代號在 TWSE 查不到東西，一旦被判成支援，畫面上就會出現空的或錯的價格。',
    file: 'js/catalog.js',
    find: "supported: s.market === '上市',",
    replace: 'supported: true,',
    test: 'datatest',
  },
  {
    name: '把「照常交易」的公告也當成休市',
    why: '農曆春節前最後交易日會被算成休市，那一天的損益就永遠補不回來。',
    file: 'scripts/build-calendar.mjs',
    find: 'return /開始交易|最後交易|補行交易/.test(name);',
    replace: 'return false;',
    test: 'datatest',
  },
  {
    name: '交易日不排除週末',
    why: '週六週日會被當成交易日，缺漏日永遠補不完。',
    file: 'scripts/build-calendar.mjs',
    find: 'if (forceTrade.has(iso) || (!weekend && !closedSet.has(iso))) out.push(iso);',
    replace: 'if (forceTrade.has(iso) || !closedSet.has(iso)) out.push(iso);',
    test: 'datatest',
  },
  {
    name: '讓 h() 支援 html: prop',
    why: 'h() 一旦能把字串當 HTML 解析，任何外部文字（股票名稱、新聞標題、AI 輸出）都變成注入點。',
    file: 'js/ui.js',
    find: "    if (k === 'class') el.className = v;",
    replace: "    if (k === 'html') { el.innerHTML = v; }\n    else if (k === 'class') el.className = v;",
    test: 'shelltest',
    expect: "html: prop 沒有生出 <img> 節點",
    alsoRed: ["html: prop 沒有生出任何子元素","html: prop 連文字都沒有進來","整個頁面沒有多出 <img>"],
    alsoRedWhy: "h() 一接受 html:，同一段注入從四個角度都看得到：生出 <img>、生出子元素、字串不再只是屬性、整頁多了一個 <img>。",
  },
  {
    name: '網址屬性不過白名單',
    why: 'javascript: 連結會變成可執行的程式碼。',
    file: 'js/ui.js',
    find: '      if (SAFE_URL.test(String(v).trim())) el.setAttribute(k, v);',
    replace: '      el.setAttribute(k, v);',
    test: 'shelltest',
    expect: "危險的協定全部被丟掉（href 屬性根本不存在）",
  },
  {
    name: 'SHELL 清單漏掉一個 view',
    why: '換版當下舊程式動態 import 到不在快取裡的新檔案，畫面會被踢回首頁；離線時則是白畫面。',
    file: 'sw.js',
    find: "  './js/views/settings.js',\n",
    replace: '',
    test: 'shelltest',
    expect: "每條路由的 view 檔都在 SHELL 清單裡",
    alsoRed: ["每一個會被載到的模組都在 SHELL 清單裡","（對照）清單少了 views/home.js 時","稽核器只管 JS 模組，抽掉非模組資產不會誤報"],
    alsoRedWhy: "四條共用同一份 sw.js 的 SHELL 清單當母體：少一支 view，它同時是「路由的 view」與「會被載到的模組」；兩條對照是拿這份清單再抽掉一項，母體先少了一支，對照的預期也跟著對不上。",
  },
  {
    name: 'Service Worker 連跨網域回應也快取',
    why: 'TWSE 的收盤價被快取之後，隔天開 App 會拿到昨天的價格，而且看起來完全正常。',
    file: 'sw.js',
    find: '  if (url.origin !== self.location.origin) return;',
    replace: '  if (url.origin !== self.location.origin) { /* 照樣往下走 */ }',
    test: 'shelltest',
    expect: "跨網域請求直接走網路，不進快取（拿舊收盤價冒充今天比拿不到更糟）",
  },
  {
    name: '拿不到的金額顯示 0',
    why: '「今日收盤尚未公布」時顯示 0，使用者會以為今天真的沒賺沒賠。',
    file: 'js/ui.js',
    find: "  if (n == null || !Number.isFinite(n)) return NO_VALUE;\n  const rounded = Math.round(n);",
    replace: '  if (n == null || !Number.isFinite(n)) return \'0\';\n  const rounded = Math.round(n);',
    test: 'fmttest',
    expect: "fmtMoney 對所有「沒有值」回「—」",
    alsoRed: ["「沒有值」的輸出裡不含任何數字","「沒有值」與「值是 0」分得開"],
    alsoRedWhy: "沒有值改回傳 '0'：回「—」、不含數字、跟 0 分得開，三條從三個角度看同一個回傳值。",
  },
  // ---- M1：結算、金額運算、節流、持股 ----
  {
    name: '除權息日拿不到參考價時，退回用前一日收盤當基準',
    why: 'STATUS 列的第 1 條，也是自製記帳最常見的錯：除息日會生出一筆等於息值的假虧損。'
      + '自算備援上線之後這條更重要 —— 備援是「補位」不是「退路」，推不出來就該不計入。',
    file: 'js/settle.js',
    find: "    if (refPrice == null) return { basis: null, source: 'none' };",
    replace: "    if (refPrice == null) return { basis: prevClose, source: 'prevClose' };",
    test: 'settletest',
  },
  {
    name: '一檔都算不出來時，當日損益回 0 而不是 null',
    why: '「今日收盤尚未公布」會變成「今天沒賺沒賠」—— 使用者看到的是一句假話。',
    file: 'js/settle.js',
    find: '  const priceMicro = counted > 0 ? sumMicro(plParts) : null;',
    replace: '  const priceMicro = sumMicro(plParts);',
    test: 'settletest',
  },
  {
    name: '不支援報價的持股也拿去算損益',
    why: 'STATUS 列的第 2 條：上櫃代號在 TWSE 查不到東西，算出來的不是空的就是別人的數字。',
    file: 'js/settle.js',
    find: '    if (!hd.supported) {',
    replace: '    if (!hd.supported && false) {',
    test: 'settletest',
  },
  {
    name: '沒填平均成本時，未實現損益回 0 而不是 null',
    why: '成本 0、市值 245 萬 → 畫面會顯示「未實現 +245 萬、報酬率 ∞」。',
    file: 'js/settle.js',
    find: '  if (withCost === 0) {',
    replace: '  if (false) {',
    test: 'settletest',
  },
  {
    name: '金額總和把「不知道」當成 0 加進去',
    why: '少一檔的總和會看起來像完整的總和，而且完全看不出來少了。',
    file: 'js/money.js',
    find: '    if (m == null) return null;',
    replace: '    if (m == null) continue;',
    test: 'settletest',
  },
  {
    name: '空字串進到金額換算（Number("") 是 0）',
    why: '沒成交、沒公布的欄位都是空字串，全部會變成 0 元。',
    file: 'js/money.js',
    // money.js 裡有兩個函式做同樣的檢查（toMicro 與 toNano），
    // 所以要連上下文一起指定，指到 toMicro 的那一個。
    find: "    const s = String(x).trim();\n    if (s === '') return null;\n    n = Number(s);\n  }\n  if (!Number.isFinite(n)) return null;\n  // 先轉成字串處理",
    replace: "    const s = String(x).trim();\n    n = Number(s);\n  }\n  if (!Number.isFinite(n)) return null;\n  // 先轉成字串處理",
    test: 'settletest',
  },
  {
    name: '拿掉 TWSE 請求的最小間隔',
    why: '連打會被證交所封 IP 一段時間 —— 後果是使用者接下來完全打不開 App。',
    file: 'js/twseclient.js',
    find: '    if (wait > 0) await sleep(wait);',
    replace: '    if (wait > 0 && false) await sleep(wait);',
    test: 'throttletest',
  },
  {
    name: '拿掉單次開頁的請求上限',
    why: '持股多又缺很多天時會一口氣打上百個請求。',
    file: 'js/twseclient.js',
    find: '    if (count >= maxRequests) throw new BudgetExceededError(maxRequests);',
    replace: '',
    test: 'throttletest',
  },
  {
    name: '請求不排隊，同時發出去',
    why: '畫面同時叫了幾個地方，就會同時打出去 —— 間隔設定等於沒有。',
    file: 'js/twseclient.js',
    find: '      const task = queue.then(() => run(url, opts));',
    replace: '      const task = run(url, opts);',
    test: 'throttletest',
  },
  {
    name: '不核對 STOCK_DAY_ALL 回應裡的日期',
    why: 'STOCK_DAY_ALL 沒有日期參數，永遠回「最新已公布的那天」。不核對就會把昨天的收盤當成今天結算。',
    file: 'js/update.js',
    find: '    if (dayAll.date !== expected) {',
    replace: '    if (false) {',
    test: 'holdingtest',
  },
  {
    name: '未確認的持股變動也算進股數',
    why: '使用者還沒對過券商通知，那個股數還不是真的；當日損益會用錯的股數去乘。',
    file: 'js/holdings.js',
    find: "  let total = 0;\n  for (const c of changes) {\n    if (c.status !== 'confirmed') continue;\n    total += Number(c.deltaShares) || 0;\n  }\n  return total;",
    replace: '  let total = 0;\n  for (const c of changes) {\n    total += Number(c.deltaShares) || 0;\n  }\n  return total;',
    test: 'changestest',
    expect: "沒有把未確認的 400 股算進去",
    alsoRed: ["1000 + 500 + 300 − 200 = 1600","全部都未確認 → 0 股","時間線最後一天的股數等於「已確認總和」"],
    alsoRedWhy: "加總不再跳過未確認的，所有用到確認股數的數字（總和、全部未確認、時間線最後一天）一起錯。",
  },
  {
    name: '回推某一天的股數時忽略日期',
    why: '回補三個月前的損益時會用今天的股數去乘，每一天都算錯。',
    file: 'js/holdings.js',
    find: '    if (c.date > date) continue;',
    replace: '',
    test: 'changestest',
    expect: "買進前一天：0 股",
    alsoRed: ["買進當天就算進去","第二次扣款前：1000 股","第二次扣款當天：1500 股","六月底：1800 股","（前提）時間線上的股數真的有變動過："],
    alsoRedWhy: "不看日期就是每一天都拿總和：時間線上每一個時點、以及「股數真的有變動」那條前提，都變成同一個數。",
  },
  {
    name: '持股頁把不支援報價的持股當成一般持股畫',
    why: '那一列會出現收盤價與當日損益 —— 但那些數字沒有來源。'
      + '（v0.7.4 起持股明細在持股頁，總覽不再重複列一次。）',
    file: 'js/views/holdings.js',
    find: '  if (!hd.supported) {',
    replace: '  if (!hd.supported && false) {',
    test: 'holdingtest',
  },
  // ---- M2：除權息與股利 ----
  {
    name: '把「待公告實際收益分配金額」當成 0 元',
    why: 'TWSE 在金額未定時放的是一段 HTML，不是空字串。當成 0 的話日曆會出現「每股 0 元、預估 0 元」——那不是不配息，是還不知道配多少。',
    file: 'js/dividend.js',
    find: '  const t = textOf(raw).replace(/,/g, \'\');\n  if (t === \'\' || t === \'--\') return null;\n  if (!/^-?\\d+(\\.\\d+)?$/.test(t)) return null;',
    replace: '  const t = textOf(raw).replace(/,/g, \'\');\n  if (t === \'\' || t === \'--\') return null;\n  if (!/^-?\\d+(\\.\\d+)?$/.test(t)) return 0;',
    test: 'dividendtest',
  },
  {
    name: '除權息參考價改成四捨五入（而不是捨去）',
    why: '96.699523 會變成 96.70，跟證交所公布的 96.69 對不上，除息日的基準價就錯了。',
    file: 'js/dividend.js',
    find: '  const floored = micro >= 0n ? (micro / unit) * unit : -(((-micro) + unit - 1n) / unit) * unit;',
    replace: '  const floored = ((micro + unit / 2n) / unit) * unit;',
    test: 'dividendtest',
  },
  {
    name: '補充保費的門檻改成「超過」而不是「達到」',
    why: '剛好 20,000 元的那一筆會少扣 422 元。',
    file: 'js/dividend.js',
    find: '  const nhiFeeMicro = grossMicro >= toMicro(NHI_THRESHOLD)',
    replace: '  const nhiFeeMicro = grossMicro > toMicro(NHI_THRESHOLD)',
    test: 'dividendtest',
  },
  {
    name: '自動扣費關閉時還是扣了匯費',
    why: '開關預設是關的（PLAN §1）。關著還扣，使用者對帳會差 10 元而且找不到原因。',
    file: 'js/dividend.js',
    find: '  if (!autoFees) {\n    return { grossMicro, wireFeeMicro: 0n, nhiFeeMicro: 0n, netMicro: grossMicro };\n  }',
    replace: '  if (!autoFees && false) {\n    return { grossMicro, wireFeeMicro: 0n, nhiFeeMicro: 0n, netMicro: grossMicro };\n  }',
    test: 'dividendtest',
  },
  {
    name: '配股用微元算（0.04999999 會被進位成 0.05）',
    why: '1000 股會從「49 股 ＋ 餘 0.99999 股」變成「50 股」—— 多給一股，現金找零的餘數也不見了。',
    file: 'js/dividend.js',
    find: '  const { whole, fraction } = sharesTimesRate(shares, stockRate);',
    replace: '  const m = BigInt(Math.round(shares)) * toMicro(stockRate);\n  const whole = Number(m / MICRO);\n  const fraction = Number(m % MICRO) / 1e6;',
    test: 'dividendtest',
  },
  {
    name: '累積股利把未確認的也算進去',
    why: '使用者還沒對過券商通知，那些金額只是預估。',
    file: 'js/dividend.js',
    find: "    if (e.status !== 'confirmed') continue;",
    replace: "    if (e.status === 'dismissed') continue;",
    test: 'dividendtest',
  },
  {
    name: '累積股利優先用預估金額而不是使用者填的實收金額',
    why: '使用者對過對帳單改成 3,490，結果總計還是用 3,500。',
    file: 'js/dividend.js',
    find: '    const raw = e.amountActual ?? e.amountEst ?? null;',
    replace: '    const raw = e.amountEst ?? e.amountActual ?? null;',
    test: 'dividendtest',
  },
  {
    name: '除權息事件不把參考價存下來',
    why: 'TWT49U 只給得到「最近一次」的結果，當下沒存就永遠補不回來，除息日的當日損益會一直缺一檔。',
    file: 'js/events.js',
    find: "      refPrice: r.refPrice,\n      refPriceSource: r.refPrice == null ? null : 'twse',",
    replace: '      refPrice: null,\n      refPriceSource: null,',
    test: 'eventtest',
  },
  {
    name: '結算時不理會除權息事件（不改用參考價）',
    why: 'STATUS 列的第 1 條：除息日會生出一筆等於息值的假虧損。',
    file: 'js/update.js',
    find: '  const extras = await events.quoteExtrasFor({ codes, date, prevDate });',
    replace: '  const extras = {};',
    test: 'eventtest',
  },
  {
    name: '確認配股時不產生持股變動',
    why: '股數不會增加，之後每一天的市值與損益都用少掉的股數在算。',
    file: 'js/events.js',
    find: "    if (wholeShares > 0) {",
    replace: '    if (wholeShares > 0 && false) {',
    test: 'eventtest',
  },
  {
    name: '重抓預告表時蓋掉已確認的事件',
    why: '使用者填好的實收金額會被每次開頁的自動更新洗掉。',
    file: 'js/events.js',
    find: '    if (prev && (prev.status === STATUS.CONFIRMED || prev.status === STATUS.DISMISSED)) continue;',
    replace: '',
    test: 'eventtest',
  },
  // ---- 參考價的自算備援 ----
  {
    name: '推導出來的參考價不標示來源（跟證交所公布的混在一起）',
    why: '使用者有權知道畫面上這個數字不是證交所直接給的。',
    file: 'js/settle.js',
    find: "    return { basis: refPrice, source: refPriceSource === 'derived' ? 'refPriceDerived' : 'refPrice' };",
    replace: "    return { basis: refPrice, source: 'refPrice' };",
    test: 'settletest',
  },
  {
    name: '推導時把「配息待公告」當成 0 元配息',
    why: '會算出一個「完全沒扣息」的參考價，除息日的當日損益憑空多出一整筆息值。',
    file: 'js/dividend.js',
    find: '  if (prevClose == null || cashPerShare == null || stockRate == null || rightsRate == null) return null;',
    replace: '  if (prevClose == null) return null;\n  cashPerShare = cashPerShare ?? 0; stockRate = stockRate ?? 0; rightsRate = rightsRate ?? 0;',
    test: 'dividendtest',
  },
  {
    name: '結算時不去推導參考價',
    why: '除權息當天沒開 App 的話，那一天的那一檔就永遠不計入 —— 備援等於沒接。',
    file: 'js/events.js',
    find: '    if (refPrice == null && prevDate) {',
    replace: '    if (false) {',
    test: 'eventtest',
  },
  {
    name: '推導時不看前一交易日（拿當天自己的收盤價當前收）',
    why: '參考價會等於當天收盤，價格部分永遠是 0 —— 看起來很正常，其實什麼都沒算。',
    file: 'js/update.js',
    find: '  const extras = await events.quoteExtrasFor({ codes, date, prevDate });',
    replace: '  const extras = await events.quoteExtrasFor({ codes, date, prevDate: date });',
    test: 'eventtest',
  },

  // ---- M3：定期定額與平均成本 ----
  {
    name: '扣款日的下界比對「順延後」的日期',
    why: '日曆缺一段時，上個月的扣款會被順延成這個月，生出一筆根本不存在的扣款。',
    file: 'js/plans.js',
    find: '      if (from && scheduled <= from) continue;',
    replace: '      if (from && moved <= from) continue;',
    test: 'plantest',
  },
  {
    name: '順延不限制跳躍距離',
    why: '日曆有缺口時會跳到幾週後，扣款日期完全錯掉 —— 那不是放假，是資料不完整。',
    file: 'js/plans.js',
    find: '  return gap <= MAX_POSTPONE_DAYS ? next : null;',
    replace: '  return next;',
    test: 'plantest',
  },
  {
    name: '扣款不扣手續費就估股數',
    why: '券商先收手續費再買，可用金額會少一點；不扣的話估出來的股數會偏多。',
    file: 'js/plans.js',
    find: '  const feeMicro = divRound(amt * rateNano, NANO);',
    replace: '  const feeMicro = 0n;',
    test: 'plantest',
  },
  {
    name: '拿不到收盤價時把扣款估成 0 股',
    why: '0 股代表「買不到一股」，null 代表「不知道」。混在一起，使用者會以為那個月真的什麼都沒買到。',
    file: 'js/plans.js',
    find: '  if (price == null) return { shares: null, usableMicro, spentMicro: null, remainderMicro: null };',
    replace: '  if (price == null) return { shares: 0, usableMicro, spentMicro: null, remainderMicro: null };',
    test: 'plantest',
  },
  {
    name: '定期定額扣款自動確認',
    why: '等於幫使用者記一筆他沒有對過券商通知的帳。股數是估的，很可能跟實際差一點。',
    file: 'js/plans.js',
    find: "        status: 'pending',\n        planId: plan.id,",
    replace: "        status: 'confirmed',\n        planId: plan.id,",
    test: 'dcatest',
  },
  {
    name: '把扣款日收盤價直接當成成交價',
    why: '使用者按一下確認就記了一筆他沒對過的成本，而平均成本會看起來很精確 —— 其實是我們猜的。',
    file: 'js/plans.js',
    find: '        price: null,\n        estimatePrice: close?.close ?? null,',
    replace: '        price: close?.close ?? null,\n        estimatePrice: close?.close ?? null,',
    test: 'dcatest',
  },
  {
    name: '配息再投入不看計畫有沒有開',
    why: '沒開這個功能的人也會冒出待確認的買進，而他根本沒有再投入。',
    file: 'js/plans.js',
    find: '  const byCode = new Map(plans.filter((p) => p.active && p.reinvestDividend).map((p) => [p.code, p]));',
    replace: '  const byCode = new Map(plans.filter((p) => p.active).map((p) => [p.code, p]));',
    test: 'dcatest',
  },
  {
    name: '沒填成交價也更新平均成本',
    why: '會拿一個我們自己猜的價格去改使用者的成本，而且完全看不出來。',
    file: 'js/avgcost.js',
    find: "  if (price == null || price === '') return { avgCost: oldAvg, reason: REASON.UNCHANGED_NO_PRICE };",
    replace: "  if (price == null || price === '') price = oldAvg;",
    test: 'plantest',
  },
  {
    name: '賣出也改平均成本',
    why: '平均成本法賣掉一部分不影響每股成本。改了的話報酬率會跟著漂。',
    file: 'js/avgcost.js',
    find: '  if (d < 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED_SELL };',
    replace: '',
    test: 'plantest',
  },
  {
    name: '配股不稀釋每股成本',
    why: '總成本沒變、股數變多，每股成本一定下降。不算的話未實現損益會虛胖。',
    file: 'js/avgcost.js',
    find: "  if (kind === 'stockDividend') {",
    replace: "  if (kind === 'stockDividend' && false) {",
    test: 'plantest',
  },
  {
    name: '沒有成本基礎時，拿新買的一筆當整個部位的均價',
    why: '1000 股沒填成本、新買 500 股 @120 → 均價變成 120，報酬率整個錯。',
    file: 'js/avgcost.js',
    find: '    if (oldShares > 0) return { avgCost: null, reason: REASON.UNCHANGED_NO_BASE };',
    replace: '',
    test: 'plantest',
  },
  {
    name: '確認變動時不檢查股數',
    why: '股數留空的扣款會被確認成「沒有股數」，之後的股數加總就少了一筆。',
    file: 'js/holdings.js',
    find: "    return status === 'pending' ? null : '確認的時候要填股數';",
    replace: '    return null;',
    test: 'dcatest',
  },
  {
    name: '沒有持股就不跑更新（定期定額永遠不會產生）',
    why: '「我要開始定期定額」的第一天，使用者還沒有任何持股 —— 扣款會永遠不出現。',
    file: 'js/update.js',
    find: '  if (held.length === 0 && planList.length === 0) {',
    replace: '  if (held.length === 0) {',
    test: 'dcatest',
  },
  {
    name: '回補月份不含扣款日',
    why: '「跳過三個月再開 App」那三筆扣款會因為抓不到當天收盤價而全部估不出股數。',
    file: 'js/update.js',
    find: '  for (const need of dcaNeeds) {\n    const month = prices.monthOf(need.date);',
    replace: '  for (const need of []) {\n    const month = prices.monthOf(need.date);',
    test: 'dcatest',
  },
  // ---- 版本混搭（使用者回報：點按鈕直接跳回主頁）----
  {
    name: '不認得的路由靜默導回首頁',
    why: '使用者回報的原症狀：按「管理定期定額計畫」直接跳回主頁，沒有任何訊息，'
      + '完全不知道發生什麼事，也不知道可以做什麼。',
    file: 'js/app.js',
    find: 'setNotFound(({ path }) => {\n  showVersionMismatch(path);\n});',
    replace: "setNotFound(() => navigate('/', { replace: true }));",
    test: 'versionmixtest',
  },
  {
    name: 'index.html 載 app.js 時不帶版本參數',
    why: 'GitHub Pages 每個檔案 max-age=600 且不 revalidate，瀏覽器快取逐檔計時。'
      + '不帶版本參數的話，十分鐘前的舊 app.js 會配上剛抓的新 view —— 那就是這個 bug 的成因。',
    file: 'index.html',
    find: `<script type="module" src="./js/app.js?v=${APP_VERSION}"></script>`,
    replace: '<script type="module" src="./js/app.js"></script>',
    test: 'shelltest',
    expect: "index.html 每個 .js 引用的網址都跟模組圖實際請求的一致（該帶版本的帶 ?v=",
  },
  {
    name: '版本號三個地方不一致（sw.js 忘了跟上）',
    why: '漏改一個，快取鍵與快取名稱就對不起來，新舊檔案又會混在一起。',
    file: 'sw.js',
    find: `const VERSION = '${APP_VERSION}';`,
    replace: "const VERSION = 'stockdiary-v0.0.0-mutant';",
    test: 'shelltest',
    expect: "sw.js 的 VERSION 與 js/version.js 一致",
    alsoRed: ["VERSION 格式正常："],
    alsoRedWhy: "突變把 sw.js 的版本換成 stockdiary-v0.0.0-mutant，格式檢查與一致性檢查讀的是同一個值。",
  },
  {
    name: '動態 import 不帶版本參數',
    why: '新版的 app.js 會配上瀏覽器快取裡的舊 view —— 同一個 bug 的反方向。',
    file: 'js/app.js',
    find: "route('/plans', async () => (await import(`./views/plans.js${V}`)).default());",
    replace: "route('/plans', async () => (await import('./views/plans.js')).default());",
    test: 'shelltest',
    expect: "每一個動態 import 都帶 ${V} 版本參數",
    alsoRed: ["沒有任何一個是沒帶版本的字面字串"],
    alsoRedWhy: "拿掉版本參數後，那一行同時「沒帶 ${V}」而且「是沒帶版本的字面字串」，兩條從正反兩面看同一行。",
  },
  {
    name: 'SW 快取比對不忽略查詢字串',
    why: '帶版本參數的請求永遠命中不了預快取的檔案。線上看不出來（會走網路），**離線整個打不開**。',
    file: 'sw.js',
    find: "    e.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));",
    replace: '    e.respondWith(caches.match(request).then((hit) => hit || fetch(request)));',
    test: 'versionmixtest',
  },

  // ---- M4：定期定額試算器 ----
  {
    name: '試算器把空白欄位當成 0',
    why: '沒填成長率會變成「假設 0% 成長」並算出一個結果 —— 使用者以為那是他要的假設。',
    file: 'js/calc.js',
    find: "    if (v == null || String(v).trim() === '') { errors[key] = `請填${label}`; return; }",
    replace: "    if (v == null || String(v).trim() === '') { values[key] = 0; return; }",
    test: 'calctest',
    expect: "空白輸入時，沒有任何必填欄位被填上預設值",
    alsoRed: [" 留空時不會被當成 0"," 留空 → 報錯「","成長率空白 → undefined，**不是 0%**","股數法沒填股價 → 不合法","輸入檢查有對照組","成長率沒填 → compareScenarios 回 null","simulate 也回 null","每個必填欄位都有自己的錯誤訊息"],
    alsoRedWhy: "驗證的那一行被改成「空白就填 0」，所有必填欄位（金額、年數、成長率、配息率、股價）與依賴驗證結果的 compareScenarios、simulate 都一起放行。",
  },
  {
    name: '股數法把湊不滿一股的餘額丟掉',
    why: 'PLAN §6 明訂餘額結轉。丟掉的話，每一期都憑空少掉最多一股的錢。',
    file: 'js/calc.js',
    find: '        cash -= bought * priceMicro;\n      } else {\n        value += usableEach;',
    replace: '        cash = 0n;\n      } else {\n        value += usableEach;',
    test: 'calctest',
    expect: "餘額 300 元結轉著，沒有被丟掉",
    alsoRed: ["買到 51 股","期末 51 × 700 + 300 = 36,000 元","餘額有算進期末市值","零成長時金額法與股數法期末差距是 0","股數法與金額法的差距小於一股："],
    alsoRedWhy: "餘額被歸零，之後每一期能買的股數、期末市值、以及拿金額法當基準的兩條差距比較，都從同一個少掉的餘額算出來。",
  },
  {
    name: '股利扣費開關關閉時照樣扣',
    why: '開關預設是關的。關著還扣，使用者算出來的數字比他的假設少一截。',
    file: 'js/calc.js',
    find: '  if (!applyFees || grossMicro <= 0n) return grossMicro;',
    replace: '  if (grossMicro <= 0n) return grossMicro;',
    test: 'calctest',
    expect: "關閉自動扣費：領到 50,000 元",
    alsoRed: ["配息再投入十年對得上手算：","領現累積 500,000 元","領現手上總共 1,500,000 元"],
    alsoRedWhy: "扣費開關被忽略，配息那一步每一次都多扣一筆，再投入與領現兩條路的累積金額都從同一個配息算出來。",
  },
  {
    name: '年化成長率用「除以 12」而不是複利換算',
    why: '12% 年化用單利拆成每月 1% 的話，一年後會變成 12.68%，跟使用者填的假設不一樣。',
    file: 'js/calc.js',
    find: '  return BigInt(Math.round(Math.pow(annual, 1 / 12) * 1e12));',
    replace: '  return BigInt(Math.round((1 + (annual - 1) / 12) * 1e12));',
    test: 'calctest',
    expect: "月成長倍數連乘 12 次剛好回到 12%",
    alsoRed: ["純複利十年對得上手算："],
    alsoRedWhy: "月成長倍數換錯，十年期末市值是它連乘 120 次的結果，對不上手算。",
  },
  {
    name: '股數法的期末市值不含未投入的現金',
    why: '那筆錢還是使用者的。不算進去會讓股數法看起來比實際差，兩種算法的比較就失真。',
    file: 'js/calc.js',
    find: '    ? BigInt(shares) * priceMicro + cash',
    replace: '    ? BigInt(shares) * priceMicro',
    test: 'calctest',
    expect: "餘額有算進期末市值",
    alsoRed: ["期末 51 × 700 + 300 = 36,000 元","零成長時金額法與股數法期末差距是 0"],
    alsoRedWhy: "期末市值少了那 300 元餘額，逐元對帳與「零成長時兩種算法一樣」都看得到。",
  },
  {
    name: '試算器不扣扣款手續費',
    why: '使用者填了手續費率卻沒被用到，算出來的期末會偏高。',
    file: 'js/calc.js',
    find: '  const usableEach = contribEach - mulRate(contribEach, BigInt(Math.round(v.feeRate * 1e12)));',
    replace: '  const usableEach = contribEach;',
    test: 'calctest',
    expect: "差額剛好是 120 次 × 14.25 元",
    alsoRed: ["期末市值 1,198,290 元（扣掉 1,710 元手續費）"],
    alsoRedWhy: "不扣手續費，期末市值與「差額剛好是手續費總和」是同一件事的兩種寫法。",
  },
  {
    name: '試算器的欄位有預設值',
    why: 'STATUS「最容易做錯的事」第 3 條：畫面上先出現一個數字，使用者就會把它當成我們認為合理的值。',
    file: 'js/views/calc.js',
    find: '    value: state[key],',
    replace: "    value: state[key] || '5',",
    test: 'calcviewtest',
  },
  {
    name: '試算器的 placeholder 放了範例數字',
    why: 'placeholder 裡的「例如 5%」跟預設值一樣是在暗示「大概填多少」，那是投資判斷。',
    file: 'js/views/calc.js',
    find: "    // placeholder 只說明格式，**不給數字**\n    placeholder: '',",
    replace: "    placeholder: '例如 5',",
    test: 'calcviewtest',
  },
  {
    name: '拿不到的日期顯示成今天',
    why: '資料狀態列會顯示一個看起來很新的日期，使用者以為資料是今天的。',
    file: 'js/ui.js',
    find: "  if (!m) return NO_VALUE;\n  return `${Number(m[2])}/${Number(m[3])}`;",
    replace: "  if (!m) { const t = new Date(); return `${t.getMonth() + 1}/${t.getDate()}`; }\n  return `${Number(m[2])}/${Number(m[3])}`;",
    test: 'fmttest',
    expect: "壞掉的日期顯示「—」，不顯示今天",
  },
  {
    name: '開機自動更新回來時，自己 import 首頁畫上去',
    why: '「還在首頁嗎」只在 update 回來那一瞬間檢查一次；import 加上首頁自己讀資料還要好幾百毫秒，'
      + '使用者在那段時間點任何按鈕都會被首頁蓋掉 —— 就是使用者回報的「點了就跳回主頁」。',
    file: 'js/app.js',
    find: `    if (currentPath() === '/') refresh();`,
    replace: `    if (currentPath() === '/') import('./views/home.js').then((m) => m.default());`,
    test: 'racetest',
  },
  {
    name: '過期的畫面照畫不誤',
    why: 'view 是 async 的，畫到一半使用者換頁是常態。少了這道守門，最後畫完的那個贏 —— '
      + '網址是新的、畫面是舊的。',
    file: 'js/shell.js',
    find: `  if (renderIsStale()) return;
  mount(view, node);`,
    replace: '  mount(view, node);',
    test: 'racetest',
  },
  {
    name: '兩個畫面同時跑',
    why: 'paintGen 在一個 view 跑到一半被下一次導覽改掉的話，「有沒有人在我背後換過頁」就問不準了，'
      + '守門形同虛設。',
    file: 'js/router.js',
    find: `  if (running) return; // 現在這一輪跑完會自己接著跑最新的
  runLatest();`,
    replace: '  runLatest();',
    test: 'racetest',
  },
  {
    name: '有一頁繞過 render() 直接寫 #view',
    why: '繞過 render() 就繞過「這個畫面是不是已經過期」的守門，那一頁就會有跳錯頁的 bug。'
      + '這條靠 shelltest 的靜態稽核擋 —— 一頁一頁跑測試抓不完，也抓不到還沒寫的新頁。',
    file: 'js/views/settings.js',
    find: `  render([
    fontSection(),`,
    replace: `  mount(document.getElementById('view'), [
    fontSection(),`,
    test: 'shelltest',
    expect: "每一頁都透過 app.js 的 render() 上畫面（那裡才有「畫面過期就不畫」的守門）",
  },
  {
    name: '過期的畫面還是可以把使用者轉去別頁',
    why: 'holding.js 查不到代號時會 navigate 回持股頁，但那個判斷在 await 之後。'
      + '少了守門，使用者早就點去別頁了還是會被 location.replace 硬扯回來 —— 就是「按了跳到別頁」。',
    file: 'js/router.js',
    find: `  if (renderIsStale()) return;
  const target`,
    replace: '  const target',
    test: 'racetest',
  },
  {
    name: '過期的畫面還是可以改頂列標題',
    why: '會變成「內容是這一頁、標題是上一頁」，使用者以為自己在別的地方。',
    file: 'js/shell.js',
    find: `  if (renderIsStale()) return;
  document.getElementById('topTitle')`,
    replace: "  document.getElementById('topTitle')",
    test: 'racetest',
  },
  // ---- M5：新聞 ----
  {
    name: '未明示允許 AI 輸入的來源也拿去餵模型',
    why: 'ltn／yahoo 的 robots 沒有明示允許 AI 輸入。放寬這個過濾，等於拿別人明確沒答應的內容去餵模型。'
      + '使用者已經定調：未標記允許的來源連標題都不進 prompt。',
    file: 'js/news.js',
    find: `  const allowed = new Set(SOURCES.filter((s) => s.aiInput).map((s) => s.id));`,
    replace: '  const allowed = new Set(SOURCES.map((s) => s.id));',
    test: 'newstest',
  },
  {
    name: '解析 RSS 時順手把內文也收進來',
    why: 'PLAN §7.1：只存標題、連結、來源、時間，不重製全文。收了內文就是轉載別人的文章。',
    file: 'js/rss.js',
    find: "    out.push({ title, link, publishedAt: publishedOf(block) });",
    replace: "    out.push({ title, link, publishedAt: publishedOf(block), description: text(tagContent(block, 'description')) });",
    test: 'newstest',
  },
  {
    name: '新聞時間解析不出來就當成現在',
    why: '會讓一則不知道什麼時候發的舊聞，在畫面上顯示成「剛剛」。',
    file: 'js/rss.js',
    find: `  return null;
}

/**
 * 解析一份 RSS／Atom`,
    replace: `  return new Date().toISOString();
}

/**
 * 解析一份 RSS／Atom`,
    test: 'newstest',
  },
  {
    name: '同一則新聞每次重抓都算成新的一筆',
    why: 'id 改用流水號的話，同一則在多次抓取之間會變成好幾筆，清單會被同樣的標題灌爆。',
    file: 'js/news.js',
    find: '  for (const it of [...(oldItems ?? []), ...(newItems ?? [])]) byId.set(it.id, it);',
    replace: '  for (const it of [...(oldItems ?? []), ...(newItems ?? [])]) byId.set(it.id + Math.random(), it);',
    test: 'newstest',
  },
  {
    name: '新聞不做 14 天清理',
    why: '只存標題連結也一樣 —— 講好保留 14 天就要真的清掉，不然 IndexedDB 會一直長。',
    file: 'js/news.js',
    find: '  const stale = all.filter((r) => r.date < cutoffDate);',
    replace: '  const stale = [];',
    test: 'newstest',
  },
  {
    name: '30 分鐘節流失效，每次開頁都重抓六家',
    why: '對六個來源連打，而且沒有必要 —— 新聞不會每分鐘都變。',
    file: 'js/news.js',
    find: '    const fresh = last && now.getTime() - Date.parse(last) < REFETCH_MS;',
    replace: '    const fresh = false;',
    test: 'newstest',
  },
  {
    name: '外部來源的 javascript: 連結照收',
    why: '外部資料流進畫面的連結必須只收 http(s)。收了 javascript: 就是讓別人的 RSS 決定按下去會執行什麼。',
    file: 'js/rss.js',
    find: String.raw`    if (cand && /^https?:\/\//i.test(cand)) return cand;`,
    replace: '    if (cand) return cand;',
    test: 'newstest',
  },
  // ---- M5：金鑰 ----
  {
    name: '把 secrets 放進匯出範圍',
    why: '匯出的備份檔會直接夾帶 API 金鑰。這是整個 App 最嚴重的一種錯，而且看不出來 —— '
      + '備份檔傳給別人或放進雲端硬碟的那一刻才爆。',
    file: 'js/db.js',
    find: `export const EXPORTABLE_STORES = ['holdings', 'changes', 'plans', 'events', 'settings'];`,
    replace: `export const EXPORTABLE_STORES = ['holdings', 'changes', 'plans', 'events', 'settings', 'secrets'];`,
    test: 'secret-leak-test',
  },
  {
    name: 'scrub 不抹金鑰',
    why: '金鑰最常見的外洩方式不是被偷，是被自己印在錯誤訊息裡 —— 上游回應常把送出的標頭原樣回 echo。',
    file: 'js/secrets.js',
    find: `  return String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');`,
    replace: '  return String(text);',
    test: 'secret-leak-test',
  },
  {
    name: '遮罩露出完整金鑰',
    why: '設定頁會把整把金鑰印在畫面上，截圖、錄影、旁邊的人都看得到。',
    file: 'js/secrets.js',
    find: '  return `${KEY_PREFIX}…${tail}`;',
    replace: '  return key;',
    test: 'secret-leak-test',
  },
  {
    name: 'status() 順手把金鑰一起回傳',
    why: 'status() 是畫面唯一拿得到的東西，一旦帶著金鑰，它就會流進 DOM 與任何序列化的地方。',
    file: 'js/secrets.js',
    find: '    configured: !!r?.key,',
    replace: `    configured: !!r?.key,
    key: r?.key ?? null,`,
    test: 'secret-leak-test',
  },
  {
    name: '把金鑰放進 request body',
    why: 'body 會被記進各種除錯工具與錯誤回報，標頭比較不會。金鑰只該待在 x-api-key。',
    file: 'js/secrets.js',
    find: '  const body = { model, max_tokens: maxTokens, system, messages };',
    replace: '  const body = { model, max_tokens: maxTokens, system, messages, key };',
    test: 'secret-leak-test',
  },
  {
    name: '金鑰格式照單全收',
    why: '貼錯東西（例如整段 curl 指令）會被存起來，然後每次呼叫都失敗，使用者查不出為什麼。',
    file: 'js/secrets.js',
    find: '  if (!k.startsWith(KEY_PREFIX)) return { ok: false, error: `金鑰應該以 ${KEY_PREFIX} 開頭` };',
    replace: '  if (false) return { ok: false, error: `` };',
    test: 'secret-leak-test',
  },
  {
    name: '用量費率抄錯',
    why: '「本月約 $X」會低估，使用者以為還很便宜，實際帳單不是這樣。',
    file: 'js/secrets.js',
    find: `  { id: 'claude-opus-5', name: 'Opus 5', inRate: 5, outRate: 25, note: '最貴' },`,
    replace: `  { id: 'claude-opus-5', name: 'Opus 5', inRate: 5, outRate: 5, note: '最貴' },`,
    test: 'secret-leak-test',
  },
  // ---- M5：今日觀察 ----
  {
    name: '禁用詞過濾整個關掉',
    why: '模型偶爾就是會越界。前線（系統提示）擋不住的時候，後線是唯一的防線 —— '
      + '關掉它，買賣建議與目標價就會直接出現在畫面上。',
    file: 'js/insight.js',
    find: '      if (b.rx.test(s)) { hits.push({ sentence: s, why: b.why }); break; }',
    replace: '      if (false) { hits.push({ sentence: s, why: b.why }); break; }',
    test: 'insighttest',
  },
  {
    name: '禁用詞過濾改成「全部都擋」',
    why: '「攔得到」的斷言會全過，但使用者打開今日觀察只會看到一片「已隱藏」，功能等於沒有。'
      + '這條突變證明「不會亂擋」那一節是真的在檢查東西。',
    file: 'js/insight.js',
    find: '      if (b.rx.test(s)) { hits.push({ sentence: s, why: b.why }); break; }',
    replace: '      if (true) { hits.push({ sentence: s, why: b.why }); break; }',
    test: 'insighttest',
  },
  {
    name: '越界的段落照樣顯示原文',
    why: '標了 hidden 卻還是把原文畫出來，等於沒擋。',
    file: 'js/insight.js',
    find: '    return hits.length ? { ...s, hidden: true, hiddenWhy: [...new Set(hits.map((h) => h.why))] } : s;',
    replace: '    return s;',
    test: 'insighttest',
  },
  {
    name: '把整包持股原封不動送給模型',
    why: '股數、成本、市值會全部送出去。PLAN §7.2：只給代號、名稱、產業、當日漲跌％。',
    file: 'js/insight.js',
    find: `    lines.push(\`· \${h.code} \${h.name ?? ''}｜\${h.industry ?? '產業未知'}｜\${pct}\`);`,
    replace: '    lines.push(`· ${JSON.stringify(h)}`);',
    test: 'insighttest',
  },
  {
    name: '未允許 AI 的來源也送進 prompt',
    why: '使用者定的規則：未明示允許的來源連標題都不進 prompt。',
    file: 'js/insight.js',
    find: '  const allowed = forAI(news).slice(0, maxItems);',
    replace: '  const allowed = news.slice(0, maxItems);',
    test: 'insighttest',
  },
  {
    name: '沒有金鑰也照樣送出請求',
    why: '會對 api.anthropic.com 發一個必定失敗的請求，而且把持股資料送出去了。',
    file: 'js/insight.js',
    find: `  if (!st.configured) return { ok: false, error: '還沒有設定 AI 金鑰' };`,
    replace: '  if (false) return { ok: false, error: `` };',
    test: 'insighttest',
  },
  {
    name: '超過用量上限還是繼續打 API',
    why: '使用者設的上限形同虛設，帳單會繼續長。',
    file: 'js/insight.js',
    find: '  if (st.overCap) return { ok: false, error: `本月用量已達上限 ${secrets.fmtUsd(st.capMicroUsd)}，暫停產生` };',
    replace: '  if (false) return { ok: false, error: `` };',
    test: 'insighttest',
  },
  {
    name: '同一天重複問就重複打 API',
    why: '每次進新聞頁都重打一次，費用是使用者在付。',
    file: 'js/insight.js',
    find: '  if (existing && !force) return { ok: true, cached: true, ...existing };',
    replace: '  if (false) return { ok: true, cached: true, ...existing };',
    test: 'insighttest',
  },
  {
    name: '免責標籤加上關閉鈕',
    why: '免責聲明不是通知，是這塊內容的一部分。可以關掉就等於可以不存在。',
    file: 'js/views/news.js',
    find: `    'AI 整理，非投資建議。內容未經查證，請以原始新聞與公開資訊為準。');`,
    replace: `    'AI 整理，非投資建議。內容未經查證，請以原始新聞與公開資訊為準。',
    h('button', {}, '知道了，不再顯示'));`,
    test: 'insighttest',
  },
  {
    name: '沒勾同意也能啟用今日觀察',
    why: '首次啟用的一次性說明必須勾選才生效，不然等於沒有告知。',
    file: 'js/views/news.js',
    find: `    if (!box.checked) { toast('要先勾選才能啟用'); return; }`,
    replace: '    if (false) { return; }',
    test: 'insighttest',
  },
  // ---- M6：匯出／匯入、集中度、版面 ----
  {
    name: '匯入時把認不得的 store 當成沒看到',
    why: '夾帶 secrets 的備份檔會被靜默接受。雖然 applyImport 只走 EXPORTABLE_STORES 不會真的寫進去，'
      + '但「悄悄忽略」跟「明確拒絕」對使用者是兩回事 —— 他會以為整份都匯入了。',
    file: 'js/backup.js',
    find: '  if (unknown.length) {',
    replace: '  if (false) {',
    test: 'backuptest',
  },
  {
    name: '匯入時連 secrets 也一起寫',
    why: '別人傳來的備份檔就能覆蓋掉你這台裝置上的 API 金鑰。',
    file: 'js/backup.js',
    find: `  for (const store of db.EXPORTABLE_STORES) {
    const rows = Array.isArray(data[store]) ? data[store] : [];`,
    replace: `  for (const store of [...db.EXPORTABLE_STORES, 'secrets']) {
    const rows = Array.isArray(data[store]) ? data[store] : [];`,
    test: 'backuptest',
  },
  {
    name: '匯出時連 secrets 也一起倒出來',
    why: '備份檔會夾帶 API 金鑰 —— 傳給別人或放進雲端硬碟的那一刻就外洩了。',
    file: 'js/backup.js',
    find: `  for (const store of db.EXPORTABLE_STORES) {
    const rows = await db.getAll(store);`,
    replace: `  for (const store of [...db.EXPORTABLE_STORES, 'secrets']) {
    const rows = await db.getAll(store);`,
    test: 'backuptest',
  },
  {
    name: '匯入不先清空（變成合併）',
    why: '講好是取代就要真的取代。殘留舊資料會讓股數重複計算，而且使用者完全看不出來。',
    file: 'js/backup.js',
    find: `    await db.clear(store);
    for (const row of rows) await db.put(store, row);`,
    replace: '    for (const row of rows) await db.put(store, row);',
    test: 'backuptest',
  },
  {
    name: '集中度把算不出市值的持股當成 0',
    why: '分母會多出幾檔 0 元的，百分比看起來很精準其實是錯的；而且使用者不知道有幾檔沒算到。',
    file: 'js/concentration.js',
    find: `    if (close == null) { excluded.push({ code: hd.code, why: '沒有收盤價' }); continue; }`,
    replace: `    if (close == null) { parts.push(0n); continue; }`,
    test: 'concentrationtest',
  },
  {
    name: '集中度把不支援報價的持股也算進去',
    why: '上櫃股票的價格這個版本抓不到，硬算會得到一個看起來合理但錯誤的佔比。',
    file: 'js/concentration.js',
    find: `    if (hd.supported === false) { excluded.push({ code: hd.code, why: '不支援報價' }); continue; }`,
    replace: '    if (false) { continue; }',
    test: 'concentrationtest',
  },
  {
    name: '佔比改用浮點數算',
    why: '各項加起來會變成 99.9 或 100.1，使用者一看就知道哪裡不對，但看不出是哪裡。',
    file: 'js/concentration.js',
    find: '  return Number((partMicro * 1000n) / totalMicro) / 10;',
    replace: '  return Math.round((Number(partMicro) / Number(totalMicro)) * 1000) / 10.0000001;',
    test: 'concentrationtest',
  },
  {
    name: '條狀圖的寬度不夾在 0–100%',
    why: '超過 100% 的填色會撐爆容器，在窄螢幕或特大字級下把旁邊的文字擠出畫面。',
    file: 'js/views/holdings.js',
    // v0.7.22（A8）把寬度改成 CSS 變數 --w，這條的 find 沒跟上，從那一版起過期（2026-09-21 全面檢測才發現）。
    // 2026-09-23 跟上現在的寫法；照 SPEC_測試可信度 C 補 expect，確認紅的是「超出畫面寬度」那一條。
    find: String.raw`      h('div', { class: 'bar-fill', style: { '--w': ` + '`${Math.max(0, Math.min(100, pct))}%`' + String.raw` } })),`,
    replace: String.raw`      h('div', { class: 'bar-fill', style: { '--w': ` + '`${pct * 3}%`' + String.raw` } })),`,
    test: 'layouttest',
    expect: '沒有任何元素超出畫面寬度',
  },
  // ---- v0.7.2：今日觀察的失敗路徑 ----
  {
    name: '不送 output_config（回到只靠 prompt 要 JSON）',
    why: '這就是使用者實機看到「模型回的不是 JSON」的原因。官方文件明說，就算 prompt 寫得再清楚，'
      + '沒有結構化輸出還是會拿到解析不了的東西。',
    file: 'js/secrets.js',
    find: '  if (outputConfig) body.output_config = outputConfig;',
    replace: '  if (false) body.output_config = outputConfig;',
    test: 'insighttest',
  },
  {
    name: '不看 stop_reason',
    why: 'refusal 與 max_tokens 都是 HTTP 200。不看它的話，兩種完全不同的失敗都會變成'
      + '同一句莫名其妙的「模型回的不是 JSON」，使用者不知道該重試還是該改設定。',
    file: 'js/insight.js',
    find: `  const stop = res?.stop_reason ?? null;`,
    replace: '  const stop = null;',
    test: 'insighttest',
  },
  {
    name: '解析失敗時還是把半成品存起來',
    why: '半截的 JSON 進了 insights，明天開 App 會直接拿那份壞掉的來畫。',
    file: 'js/insight.js',
    find: `      detail: secrets.scrub(parsed.raw ?? ''),`,
    replace: `      detail: secrets.scrub(parsed.raw ?? ''), stored: await db.put('insights', { date, model: st.model, json: { summary: '', sections: [], watchDates: [] }, usage: {}, createdAt: now.toISOString() }),`,
    test: 'insighttest',
  },
  {
    name: '挖 JSON 用正則而不是括號配對',
    why: '正則抓不出巢狀結構，遇到 {"a":{"b":1}} 會在第一個 } 就停，救回來的是半個物件。',
    file: 'js/insight.js',
    find: String.raw`    if (c === '"') { inStr = true; continue; }`,
    replace: '    if (false) { inStr = true; continue; }',
    test: 'insighttest',
  },
  {
    name: '送給模型的新聞則數不設上限',
    why: '實機那天可餵的有 70 則，而且會越來越多。輸出被撐爆就是截斷，成本也跟著上去。',
    file: 'js/insight.js',
    find: '  const allowed = forAI(news).slice(0, maxItems);',
    replace: '  const allowed = forAI(news);',
    test: 'insighttest',
  },
  {
    name: '所有失敗都給同一句罐頭訊息',
    why: '「模型回的不是 JSON」對使用者毫無意義 —— 他不知道是金鑰錯、額度滿、網路問題還是程式壞了。',
    file: 'js/insight.js',
    find: `  if (stopReason === 'max_tokens' || parsed.kind === 'truncated') {`,
    replace: '  if (false) {',
    test: 'insighttest',
  },
  {
    name: 'HTTP 狀態碼只丟數字不翻成人話',
    why: '「Anthropic 回 401」使用者看不懂，也不知道要去設定重貼金鑰。',
    file: 'js/secrets.js',
    find: `    case 401: return '金鑰不正確、已撤銷或已過期。請到設定重新貼一次';`,
    replace: `    case 401: return '請求沒有成功';`,
    test: 'insighttest',
  },
  // ---- v0.7.3：個股篩選與分組摺疊 ----
  {
    name: '個股篩選只比對第一個代號',
    why: '一則新聞可能同時關係到好幾檔（供應鏈新聞常常如此）。只看第一個的話，'
      + '那一則在其他檔的篩選裡就不見了 —— 使用者會以為那檔今天沒新聞。',
    file: 'js/views/news.js',
    find: `    ? items.filter((it) => (it.relatedCodes ?? []).includes(relatedFilter))`,
    replace: `    ? items.filter((it) => (it.relatedCodes ?? [])[0] === relatedFilter)`,
    test: 'newstest',
  },
  {
    name: '篩選按鈕列出所有持股，包括今天沒新聞的',
    why: '按下去是一片空白。按鈕存在就代表「這裡有東西可看」。',
    file: 'js/views/news.js',
    find: '    for (const code of it.relatedCodes ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);',
    replace: '    for (const code of it.relatedCodes ?? []) counts.set(code, counts.get(code) ?? 0);',
    test: 'newstest',
  },
  {
    name: '摺疊狀態不寫進設定',
    why: '使用者收起來就是不想看，每次進來又全部展開等於沒收。',
    file: 'js/views/news.js',
    find: '    await prefs.set(prefKey, !open);',
    replace: '    void prefKey;',
    test: 'newstest',
  },
  {
    name: '收起來只是視覺上藏起來，內容還在版面上',
    why: 'hidden 換成只改樣式的話，收合等於沒收 —— 而且螢幕閱讀器還是讀得到。',
    file: 'js/views/news.js',
    find: '  body.hidden = !open;',
    replace: '  body.style.opacity = open ? `1` : `0.001`;',
    test: 'newstest',
  },
  // ---- v0.7.4：元件收斂 ----
  {
    name: '切換開關退回「一顆會換字的按鈕」',
    why: '使用者實機回報這個很不直覺：寫「開啟」到底是目前開著、還是按了會開？'
      + '軌道＋滑塊沒有這個歧義，換字有。',
    file: 'css/style.css',
    find: '.switch.on .switch-knob { transform: translateX(20px); background: #0d1520; }',
    replace: '.switch.on .switch-knob { background: #0d1520; }',
    test: 'uikittest',
  },
  {
    name: '切換開關不標 aria-checked',
    why: '螢幕閱讀器讀不出現在是開還是關，而且測試也分不出它有沒有真的切換。',
    file: 'js/ui.js',
    find: `    'aria-checked': checked ? 'true' : 'false',`,
    replace: `    'aria-checked': 'false',`,
    test: 'uikittest',
  },
  {
    name: '時間門檻改回原生 time 欄位',
    why: 'iOS 會把它拉滿整個卡片、文字置中（使用者實機回報「跑版」），而且空值時顯示'
      + '當下時間，看起來像已經設好了。TripQuest 踩過同一個坑。',
    file: 'js/views/settings.js',
    find: `  const t = timeSelect({ value: prefs.get('todayDataThreshold'), minuteStep: 5 });`,
    replace: `  const t = { node: h('input', { class: 'field', type: 'time', value: prefs.get('todayDataThreshold') }), value: '15:00' };`,
    test: 'uikittest',
  },
  {
    name: '「管理定期定額計畫」用跟「新增一檔」不同的樣式',
    why: '同一個層級的兩個入口長得不一樣，使用者會以為其中一個比較次要。',
    file: 'js/views/holdings.js',
    find: `      h('a', { class: 'btn btn-primary', href: '#/plans' }, '管理定期定額計畫'),`,
    replace: `      h('a', { class: 'btn', href: '#/plans' }, '管理定期定額計畫'),`,
    test: 'uikittest',
  },
  {
    name: '持股頁把兩個入口放回「目前持股」上面',
    why: '每次進持股頁都要先捲過兩張卡片才看得到自己的持股。',
    file: 'js/views/holdings.js',
    // v0.7.7 之後「目前持股」在最上面，所以改成**把產業分布插回它前面** ——
    // 一樣是使用者回報過的症狀：每次進持股頁都要先捲過一張圖表才看得到自己的持股。
    find: `  render([
    held.length === 0`,
    replace: `  render([
    concentrationCard(withIndustry, quotes),
    held.length === 0`,
    test: 'uikittest',
  },
  // ---- v0.7.5：配息紀錄（界線） ----
  {
    name: '配息查詢結果自動填進試算的配息率欄位',
    why: '這是整個功能唯一不能做的事。把歷史配息換算成配息率填進去，'
      + '等於我們替使用者決定了未來會配多少 —— 那正是「試算器不得有預設值、'
      + '不得給建議值或歷史平均」要防的。',
    file: 'js/views/calc.js',
    find: '  state.lookup = { key, info, announced, upcoming, received };',
    replace: `  state.lookup = { key, info, announced, upcoming, received };
  state.yieldRate = String(upcoming.cashPerShare || announced.totalCash || 0);`,
    test: 'divrecordtest',
  },
  {
    name: '合計改成平均',
    why: '實測每檔中位數只有 1 筆紀錄。拿 1–3 筆算「平均」沒有統計意義，'
      + '卻會讓畫面看起來像在說「大概就是這個數」。加總是事實，平均是推論。',
    file: 'js/divrecord.js',
    find: '    totalCash: round8(list.reduce((a, r) => a + (r.cash ?? 0), 0)),',
    replace: '    totalCash: round8(list.reduce((a, r) => a + (r.cash ?? 0), 0) / list.length),',
    test: 'divrecordtest',
  },
  {
    name: '查不到的代號回空陣列假裝「這檔沒配過息」',
    why: '「沒有這筆資料」跟「沒有配過息」是兩件事。ETF 根本不在這份資料裡，'
      + '回一個「合計 0 元」會讓人以為它不配息。',
    file: 'js/divrecord.js',
    find: '  if (!list) return { found: false, code: key, records: [] };',
    replace: '  if (!list) return { found: true, code: key, records: [], totalCash: 0, totalStock: 0, periods: 0 };',
    test: 'divrecordtest',
  },
  {
    name: '待確認的除權息也算進「你實際領到的」',
    why: '還沒確認的金額只是估算，算進去會讓使用者以為那筆已經入袋。',
    file: 'js/divrecord.js',
    find: `  const mine = events.filter((e) => e.code === code && e.status === 'confirmed');`,
    replace: '  const mine = events.filter((e) => e.code === code);',
    test: 'divrecordtest',
  },
  {
    name: '沒有填金額的除權息當成 0 元加進合計',
    why: '「不知道多少」被當成「領了 0 元」，合計會偏低而且看不出來。',
    file: 'js/divrecord.js',
    find: `    if (raw == null) { unknown += 1; rows.push({ exDate: e.exDate, micro: null }); continue; }`,
    replace: '    if (raw == null) { unknown += 1; rows.push({ exDate: e.exDate, micro: 0n }); counted += 1; continue; }',
    test: 'divrecordtest',
  },
  {
    name: '資料過期不講',
    why: '配息資料要定期重跑 build 才會更新。不標出表日期與「可能已過期」，'
      + '使用者會以為看到的是最新決議。',
    file: 'js/divrecord.js',
    find: '  return { known: true, stale: days > STALE_DAYS, days, iso };',
    replace: '  return { known: true, stale: false, days, iso };',
    test: 'divrecordtest',
  },
  {
    name: '每股金額四捨五入到兩位',
    why: '0.125 會變成 0.13 —— 那是真的改了公司公告的數字。',
    file: 'js/divrecord.js',
    find: '  return String(Math.round(n * 1e4) / 1e4);',
    replace: '  return String(Math.round(n * 1e2) / 1e2);',
    test: 'divrecordtest',
  },
  // ---- v0.7.6：ETF 的配息紀錄 ----
  {
    name: '「下一次除權息」把待公告的金額當成 0',
    why: '「還沒公告」跟「這次配 0 元」是兩件事。ETF 的預告表常常先出日期、'
      + '金額過幾天才公告（實測 72 筆裡有 35 筆是這樣）。',
    file: 'js/divrecord.js',
    find: '    cashPerShare: Number.isFinite(next.cashPerShare) ? next.cashPerShare : null,',
    replace: '    cashPerShare: Number.isFinite(next.cashPerShare) ? next.cashPerShare : 0,',
    test: 'divrecordtest',
  },
  {
    name: '「下一次除權息」取最遠的那一次',
    why: '使用者要知道的是「最近要除息的是哪一天」，給他三個月後那次沒有意義。',
    file: 'js/divrecord.js',
    find: '    .sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)));',
    replace: '    .sort((a, b) => String(b.exDate).localeCompare(String(a.exDate)));',
    test: 'divrecordtest',
  },
  {
    name: '已確認的除權息也被當成「下一次」',
    why: '已經領過的變成「下一次要配」，使用者會以為還有一次。',
    file: 'js/divrecord.js',
    find: `    .filter((e) => e.code === code && e.exDate >= today && e.status !== 'confirmed' && e.status !== 'dismissed')`,
    replace: '    .filter((e) => e.code === code && e.exDate >= today)',
    test: 'divrecordtest',
  },
  {
    name: '不把持股列成按鈕，逼使用者自己打代號',
    why: '使用者的三檔全是 ETF，原本的設計對他一檔都查不到 —— 他甚至不知道該查什麼。'
      + '列出他自己的持股，他不必先知道哪一檔查得到。',
    file: 'js/views/calc.js',
    find: '    ...(state.holdings ?? []).map((hd) => {',
    replace: '    ...[].map((hd) => {',
    test: 'divrecordtest',
  },
  {
    name: 'ETF 查不到時只寫一句含糊的「不含 ETF」',
    why: '含糊的說法會讓使用者以為是我們偷懶。要講出限制在哪裡（證交所沒有公開資料）'
      + '以及他的紀錄會怎麼長出來。',
    file: 'js/views/calc.js',
    find: `      'ETF 的歷史收益分配，證交所沒有公開資料可以查（我們實際查過了）。'`,
    replace: `      '不含 ETF。'`,
    test: 'divrecordtest',
  },
  {
    name: '把真正持平的有成交證券也解成 null',
    why: '「沒成交 → null」跟「持平 → 0」是兩件事。分不開的話，'
      + '真的收平盤的那一天會變成「今天沒有這檔的報價」，畫面整格空白。',
    file: 'js/twse.js',
    find: 'change: traded ? num(r[9]) : null,',
    replace: 'change: traded && num(r[9]) !== 0 ? num(r[9]) : null,',
    test: 'parsetest',
    expect: "真正的持平解成 0，不是 null",
  },
  {
    name: '用成交股數判斷「有沒有成交」',
    why: '有幾檔（1472、2024、2891B）有成交股數與筆數，價格欄卻是空的。'
      + '用股數判斷的話，這幾檔會被當成有成交，然後帶著 null 價格走進結算。',
    file: 'js/twse.js',
    find: 'const traded = close != null;',
    replace: 'const traded = num(r[3]) > 0;',
    test: 'parsetest',
    expect: "有成交股數但沒有收盤價的，一律算沒成交",
    alsoRed: ["沒成交的檔數有被數出來","有成交的列都有正的收盤價"],
    alsoRedWhy: "判斷改成看成交股數，同一批「有股數、沒收盤價」的列被當成有成交，沒成交的檔數與「有成交的都有收盤價」一起錯。",
  },
  {
    name: '大盤漲跌％拿當日指數當分母',
    why: '應該除以前一日指數（當日 − 點數）。除以當日算出來的百分比每一天都偏，'
      + '而且跌得越多偏越大 —— 這個數字會直接進「今日觀察」的提示內容。',
    file: 'js/twse.js',
    find: 'const prev = index - changePoints;',
    replace: 'const prev = index;',
    test: 'parsetest',
    expect: "漲跌％由點數與前一日指數算出來",
  },
  {
    name: '大盤算不出百分比時給 0',
    why: '「沒公布」會被講成「大盤持平」，而且是講給模型聽的。',
    file: 'js/twse.js',
    find: '    let changePct = null;',
    replace: '    let changePct = 0;',
    test: 'parsetest',
    expect: "算不出百分比時是 null，不是 0",
  },
  {
    name: '大盤挑回應裡的第一列，不是指定的那一天',
    why: 'FMTQIK 回的是一整個月。挑第一列等於永遠拿月初那天的漲跌當今天的。',
    file: 'js/prices.js',
    find: '  return r.rows.find((x) => x.date === iso) ?? null;',
    replace: '  return r.rows[0] ?? null;',
    test: 'insighttest',
  },
  {
    name: '今日觀察的呼叫端不傳大盤與個股漲跌％',
    why: 'PLAN §7.2 要求這兩個輸入。buildUserContent 早就會處理它們、模組測試也全綠，'
      + '但呼叫端沒傳 —— 這正是實際發生過的漏接，只有從按鈕按下去的測試照得到。',
    file: 'js/views/news.js',
    find: '      holdings: await withChangePct(held, today),',
    replace: '      holdings: held,',
    test: 'insighttest',
  },
  {
    name: '結算不是今天的也照樣拿來當今日漲跌％',
    why: '收盤還沒公布時，手上最新的結算是前一個交易日的。'
      + '把那一天的漲跌講成今天的，使用者與模型都會被誤導。',
    file: 'js/views/news.js',
    find: '  const rows = rec?.date === today ? (rec.byCode ?? []) : [];',
    replace: '  const rows = rec?.byCode ?? [];',
    test: 'insighttest',
  },
  {
    name: '版本比對放寬成「開頭一樣就算同一版」',
    why: '版本號只差一個 patch 也會被當成一致，新舊檔案混在一起的那個 bug 就再也擋不住。',
    file: 'scripts/shelltest.mjs',
    find: 'const sameVersion = (v) => v === appVersion;',
    replace: 'const sameVersion = (v) => String(v).trim().toLowerCase().startsWith(String(appVersion).slice(0, 12).toLowerCase());',
    test: 'shelltest',
    expect: "版本比對是嚴格字串相等：多一個空白、少一個字、只差一個 patch 都算不同",
  },
  {
    name: '除權息日拿不到參考價就退回前一日收盤',
    why: '除息日用前收當基準 ＝ 把整筆股利算成當天的虧損。'
      + '單元測試看得到 basisFor 的回傳值，但真正會出事的是它一路走到畫面上 ——'
      + 'scenariotest 是從 IndexedDB 與真的畫面上抓這個數字。',
    file: 'js/settle.js',
    find: "    if (refPrice == null) return { basis: null, source: 'none' };",
    replace: "    if (refPrice == null) return { basis: prevClose, source: 'prevClose' };",
    test: 'scenariotest',
  },
  {
    name: '定期定額估股數拿「最近一筆」收盤價，不是扣款日那一天的',
    why: '平常兩者一樣，所以很難發現。除息日當天差最多：扣款日收 2455、前一日收 2460，'
      + '估出來的每股成本就錯了，而使用者按一下確認就把它記成自己的成本。',
    file: 'js/plans.js',
    find: "      const close = await db.get('closes', [plan.code, occ.date]);",
    replace: "      const close = (await db.getAll('closes'))\n        .filter((c) => c.code === plan.code && c.date <= occ.date)\n        .sort((a, b) => (a.date < b.date ? 1 : -1))[1]\n        ?? await db.get('closes', [plan.code, occ.date]);",
    test: 'scenariotest',
  },
  {
    name: '沒有收盤價時把當日損益算成 0',
    why: '「不知道」變成「持平」。停牌、沒成交、還沒公布全都會顯示一筆看起來很正常的 0。',
    file: 'js/settle.js',
    find: "      row.status = 'noClose';",
    replace: "      row.status = 'noClose'; row.plMicro = 0n; plParts.push(0n); counted += 1;",
    test: 'scenariotest',
  },
  {
    name: '兩次更新並行（force 不等前一次跑完）',
    why: '新增持股、儲存計畫、按重新整理都會 force 一次，而開機那一次通常還在飛。'
      + '並行跑的話同一檔同一個月會被抓兩次 —— TWSE 連打是會被封 IP 的。',
    file: 'js/store.js',
    // 要改的是**守門那一行**：force 跳過去就會跟進行中的那次並行跑。
    // 只換掉區塊裡面兩行的話，force 會拿到同一個 promise（等於 force 被忽略），
    // 請求數不會變兩倍，測試也就不會紅 —— 那條突變本身是錯的。
    find: '  if (state.updating) {',
    replace: '  if (state.updating && !force) {',
    test: 'pathtest',
  },
  {
    name: '沒有持股也去打全市場收盤',
    why: '第一次開 App 的人什麼都還沒設定，那一個請求是純浪費 ——'
      + '而且剛裝好的人最可能在網路差的地方。',
    file: 'js/update.js',
    find: "    return { status: STATUS.NO_HOLDINGS, settled: [], message: '還沒有持股，也還沒有定期定額計畫' };",
    replace: "    await prices.fetchDayAll(client).catch(() => null);\n    return { status: STATUS.NO_HOLDINGS, settled: [], message: '還沒有持股，也還沒有定期定額計畫' };",
    test: 'pathtest',
  },
  {
    name: '全新裝置的總覽回到三張「—」',
    why: '什麼都還沒設定的人看到三個破折號，分不出是 App 壞了、今天還沒開盤、還是自己還沒設定，'
      + '而且那個畫面上**一個帶得到持股頁的按鈕都沒有**（實測過）。',
    file: 'js/views/home.js',
    find: '  if (held.length === 0 && plansList.length === 0) {',
    replace: '  if (false) {',
    test: 'pathtest',
  },
  {
    name: '持股列的漲跌％用比例，不乘 100',
    why: 'fmtPct 收的是百分比數字。直接把 0.0133 丟進去，−1.33% 會顯示成 −0.01% ——'
      + '看起來完全正常，數字卻小了一百倍。（寫的時候真的踩到。）',
    file: 'js/views/holdings.js',
    find: '    ? ((r.close - r.basis) / r.basis) * 100',
    replace: '    ? (r.close - r.basis) / r.basis',
    test: 'uikittest',
  },
  {
    name: '持股列算不出當日損益就留白',
    why: '留白跟「今天沒漲沒跌」在畫面上長得一樣。算不出來要寫出原因'
      + '（尚未取得收盤價、除權息日還沒有參考價…）。',
    file: 'js/views/holdings.js',
    find: "    return [h('span', { class: 'muted sm' }, STATUS_TEXT[r.status] ?? '沒有當日損益')];",
    replace: '    return [];',
    test: 'uikittest',
  },
  {
    name: '按鈕的觸控區縮回 36px',
    why: '使用者定的底線是 44px，而 .btn-sm 正好用在最常按的那幾顆：'
      + '確認扣款、確認股利、取消確認、修改、停用。',
    file: 'css/style.css',
    find: '.btn-sm { padding: 6px 12px; min-height: 44px; font-size: 0.9em; }',
    replace: '.btn-sm { padding: 6px 12px; min-height: 36px; font-size: 0.9em; }',
    test: 'uikittest',
  },
  {
    name: '手續費率填成百分比也照收',
    why: '券商講「0.1425%」，欄位要的是 0.001425。填錯一個單位，估出來的股數少一成四，'
      + '而畫面只會寫「手續費率 14.2500%」—— 看起來很正常。',
    file: 'js/plans.js',
    find: '    if (f > MAX_FEE_RATE) {',
    replace: '    if (false) {',
    test: 'plantest',
  },
  {
    name: 'ETF 歸到「產業未知」',
    why: 'ETF 本來就沒有單一產業別，那不是資料缺了。'
      + '這位使用者的定期定額三檔全是 ETF，整批落在那一格會像 App 沒抓到東西。',
    file: 'js/concentration.js',
    find: "    const key = hd.industry || (hd.type === 'ETF' ? 'ETF' : '產業未知');",
    replace: "    const key = hd.industry || '產業未知';",
    test: 'concentrationtest',
  },
  {
    name: '累積已領股利退回自相矛盾的文案',
    why: '同一張卡片一邊說「還沒有確認過任何一筆股利」、一邊說「另有 2 筆已確認」，'
      + '看的人不知道到底有沒有。',
    file: 'js/views/dividends.js',
    find: "      ? h('p', { class: 'muted sm' }, s.unknown > 0",
    replace: "      ? h('p', { class: 'muted sm' }, false",
    test: 'uikittest',
  },
  {
    name: '帶入時順便把成長率與配息率也填了',
    why: '那兩個是對未來的假設，不是他已經有的事實。填了就等於我們替他預測，'
      + '而且他會把那個數字當成我們認為合理的值 —— 這是使用者從第一天就定的界線。'
      + '（要塞 leg.* 不是 state.*：v0.7.11 改成每檔分別設定之後，畫面欄位的值來自 leg，'
      + '塞 state 是塞在一條沒人走的路上 —— 突變會「成功」但測試不會紅。）',
    file: 'js/views/calc.js',
    find: '  if (pos?.close != null) {',
    replace: '  leg.growthRate = "5"; leg.yieldRate = "4";\n  if (pos?.close != null) {',
    test: 'calcviewtest',
  },
  {
    name: '帶入的市值算錯',
    why: '帶進去的數字是他自己的部位，錯了他不會發現 —— 因為那正是他懶得自己算才用帶入的。',
    file: 'js/views/calc.js',
    find: '    leg.startValue = String(pos.marketValue);',
    replace: '    leg.startValue = String(Math.round(pos.marketValue * 1.1));',
    test: 'calcviewtest',
  },
  {
    name: '試算的手續費率上限放寬回 0.999',
    why: '填 0.1425 會被當成 14.25%，每一期都少扣一成四，而畫面上看不出來。'
      + '定期定額那一頁擋得住、試算這一頁擋不住的話，使用者在一頁學到的東西到另一頁就不成立。',
    file: 'js/calc.js',
    find: "  values.feeRate = optionalNumber(raw.feeRate, errors, 'feeRate', { min: 0, max: MAX_FEE_RATE, label: '扣款手續費率' }) ?? 0;",
    replace: "  values.feeRate = optionalNumber(raw.feeRate, errors, 'feeRate', { min: 0, max: 0.999, label: '扣款手續費率' }) ?? 0;",
    test: 'calctest',
    expect: "把百分比當比例填會被擋，真的比例放行",
    alsoRed: ["訊息講得出「你填的等於幾 %」與「應該填什麼」"],
    alsoRedWhy: "上限放寬後 0.1425 不再被擋、沒有錯誤訊息，檢查訊息內容的那一條拿到的是 undefined。",
  },
  {
    name: '持股列改回 flex（右側數字會被擠到下一行）',
    why: '左側寬度不固定（代號 4 或 5 碼、名稱 2～7 字、有沒有產業標籤），'
      + '只要撐開一點右側整組就換行，那一列變兩倍高、跟別列對不齊。'
      + '使用者實機回報的「跑版」就是這個，而溢出與重疊兩種掃描都看不到它。',
    file: 'css/style.css',
    find: '.row-holding {\n  display: grid;',
    replace: '.row-holding {\n  display: flex;',
    test: 'layouttest',
  },
  {
    name: '待確認的提示列合併成一條（只給一件事）',
    why: '提示列寫「1 筆除權息、1 筆扣款等你確認」卻只帶去股利頁，'
      + '而股利頁上一個通往定期定額的連結都沒有（實測過）—— 另一半等於沒有路。'
      + '每個月扣款日之後如果剛好也有除權息就會踩到。',
    file: 'js/views/home.js',
    find: '  if (changes.length) {',
    replace: '  if (false) {',
    test: 'uikittest',
  },
  {
    name: '把「看每一檔的當日損益」按鈕加回總覽',
    why: '那顆是 v0.7.10 加的，使用者在 v0.7.11 之後**明確說不要**。'
      + '這條突變守的是「不要自動加回來」—— 加回去測試就要紅。',
    file: 'js/views/home.js',
    find: "    // 這裡**刻意沒有**「看每一檔的當日損益」那顆按鈕。",
    replace: "    h('a', { class: 'btn', href: '#/holdings', dataset: { link: 'perHolding' } }, '看每一檔的當日損益'),\n    // 這裡**刻意沒有**「看每一檔的當日損益」那顆按鈕。",
    test: 'uikittest',
  },
  {
    name: '股利那一列的日期不標「除息」',
    why: '證交所沒有公布現金股利發放日（TWT48U／TWT49U／TWT48U_ALL／'
      + 'openapi t187ap45_L 四個端點都實測過），所以這個 App 只知道除息日。'
      + '不標的話，三個月後回來看會以為那是入帳日。',
    file: 'js/views/dividends.js',
    find: "      h('span', { class: 'row-code' }, `除息 ${fmtDate(e.exDate)}`),\n      h('span', { class: 'row-name' }, `${e.code} ${e.name}`),\n      // 認不得的 kind",
    replace: "      h('span', { class: 'row-code' }, fmtDate(e.exDate)),\n      h('span', { class: 'row-name' }, `${e.code} ${e.name}`),\n      // 認不得的 kind",
    test: 'uikittest',
  },
  {
    name: '扣款確認的回饋退回「已確認」三個字',
    why: '他按完確認的當下手上正拿著券商通知在對。只說「已確認」的話，要驗證股數與均價對不對得走到 持股 → 該檔 才看得到。',
    file: 'js/views/plans.js',
    find: '      const after = (await holdings.list()).find((x) => x.code === c.code);',
    replace: '      const after = { shares: null, avgCost: null }; const added = 0; toast("已確認"); store.notifyChanged(); plansView(); return;',
    test: 'uikittest',
  },
  {
    name: '沒填完的那一檔當成 0 照樣算進去',
    why: '空白代表「還沒決定」，不是「假設它不成長、不配息」。當成 0 會生出一個'
      + '看起來很正常的結果，而且合計也被汙染 —— 使用者不會發現那一檔根本沒填。',
    file: 'js/calc.js',
    find: "    if (missing.length) { skipped.push({ code: leg.code, name: leg.name, missing }); continue; }",
    // 2026-09-24 補 expect 時發現：以前寫的是 `leg = { ...leg, … }`，leg 是 for…of 的 const，一跑就 TypeError——
    // 測試是被語法錯誤弄崩的，不是抓到「空白被當成 0」。改成直接改寫那一檔的欄位，行為才是它 why 講的那樣。
    replace: "    if (missing.length) { Object.assign(leg, { growthRate: leg.growthRate || 0, yieldRate: leg.yieldRate || 0, amount: leg.amount || 0 }); }",
    test: 'calctest',
    expect: "沒填完的那一檔沒有算",
    alsoRed: ["填完的兩檔算進去了"],
    alsoRedWhy: "沒填完的那一檔被當成 0 算進去，列表從兩檔變三檔，「填完的兩檔」那條數的是同一份列表。",
  },
  {
    name: '一檔都沒填完時合計回 0 而不是 null',
    why: '0 會被讀成「算出來是零」。什麼都沒算就是沒有答案，那要回 null。',
    file: 'js/calc.js',
    find: '  if (rows.length === 0) return { rows, skipped, total: null };',
    replace: '  if (rows.length === 0) return { rows, skipped, total: { reinvest: { totalEndMicro: 0n, investedMicro: 0n, dividendTotalMicro: 0n }, payout: { totalEndMicro: 0n, investedMicro: 0n, dividendTotalMicro: 0n, paidOutMicro: 0n }, counted: 0, yearly: [] } };',
    test: 'calctest',
    expect: "**合計是 null，不是 0** —— 0 會被讀成「算出來是零」",
  },
  {
    name: '每一檔共用同一組成長率與配息率',
    why: '0050、0056、00878、2330 的性質差很多，用同一組假設算出來的東西沒有意義 ——'
      + '那正是使用者要求分開設定的原因。',
    file: 'js/calc.js',
    find: '      growthRate: Number(leg.growthRate),\n      yieldRate: Number(leg.yieldRate),',
    replace: '      growthRate: Number(legs[0].growthRate),\n      yieldRate: Number(legs[0].yieldRate),',
    test: 'calctest',
    expect: "兩檔的成長率各自是 6% 與 3%",
    alsoRed: ["配息率也各自不同"],
    alsoRedWhy: "突變把成長率與配息率都改成拿第一檔的，兩條各看一個欄位。",
  },
  {
    name: '試算的成長率欄位不再說明為什麼沒有參考值',
    why: '使用者問過「為什麼不自動帶出長期平均」。留白不解釋，他會以為是壞了或偷懶；'
      + '而真正的理由（未還原價、0050 做過 1:4 分割）用實例講才聽得懂。',
    file: 'js/views/calc.js',
    find: "  return h('p', { class: 'muted sm', dataset: { note: 'noGrowthReference' } },",
    replace: "  return h('p', { class: 'muted sm', dataset: { note: 'gone' } },",
    test: 'calcviewtest',
  },
  {
    name: '試算頁把個股也列進來',
    why: '使用者明確要求只顯示 ETF。個股與 ETF 的假設差很多，混在一起只是雜訊，'
      + '而且他每次都要一檔一檔按「不算這一檔」。',
    file: 'js/views/calc.js',
    find: "    if (isETF(hd.code)) etfs.push(newLeg(hd.code, hd.name ?? ''));",
    replace: "    etfs.push(newLeg(hd.code, hd.name ?? ''));",
    test: 'calcviewtest',
  },
  {
    name: '選了某一檔之後還是列出全部',
    why: '使用者要求「選擇其中一檔的話，下方請只顯示選中的那檔」。'
      + '全部列出來的話他得一檔一檔按「不算這一檔」才能只試算一檔。',
    file: 'js/views/calc.js',
    find: '  state.legs = [legFor(plan.code)];',
    replace: '  legFor(plan.code);',
    test: 'calcviewtest',
  },
  {
    name: '拿掉「成本不含手續費」的說明',
    why: '使用者拿券商 App 對帳，成本會有一點差（多年累積的手續費，'
      + '加上部分個股走一般下單）。那是定義不同不是算錯，但不講的話他每次對帳都會重新懷疑一次。',
    file: 'js/views/home.js',
    find: "    h('p', { class: 'muted sm', dataset: { note: 'costExcludesFee' } },",
    replace: "    h('p', { class: 'muted sm', dataset: { note: 'gone' } },",
    test: 'uikittest',
    expect: '未實現損益卡片上有說明',
    alsoRed: ["講出「我們沒加手續費、券商有加」：「","而且講出方向（券商的成本會比較高）","講出「成本沒有算進手續費」","講出「各家券商的算法不一樣」","講出「沒辦法一模一樣，差一點是正常的」","而且點名損益與報酬率是約略值"],
    alsoRedWhy: "說明整段拿掉，說明裡的每一句各有一條斷言，一起紅。",
  },
  {
    name: '未實現損益的標題不標「約略值」',
    why: '成本是使用者自己填的、不含手續費，推出來的損益與報酬率跟券商一定對不起來。'
      + '標題不標的話，使用者會以為這是可以跟券商分毫對帳的數字。',
    file: 'js/views/home.js',
    find: "    h('h2', { class: 'card-title' }, '未實現損益（約略值）'),",
    replace: "    h('h2', { class: 'card-title' }, '未實現損益'),",
    test: 'uikittest',
    expect: '未實現損益卡的標題帶著',
    alsoRed: ["整個首頁只有一張卡的標題帶這個詞"],
    alsoRedWhy: "「只有一張卡帶這個詞」數的就是這張卡的標題，它不標，數量變成 0。",
  },
  {
    name: '把「約略值」也標到市值上',
    why: '市值＝收盤價 × 股數，沒有任何估計成分；跟券商差是因為**時點**不同。'
      + '到處標約略值，使用者會覺得整個畫面的數字都不可信。',
    file: 'js/views/home.js',
    find: "    h('h2', { class: 'card-title' }, '持股市值'),",
    replace: "    h('h2', { class: 'card-title' }, '持股市值（約略值）'),",
    test: 'uikittest',
    expect: '當日損益、持股市值這些卡的標題都沒有被標成約略值',
    alsoRed: ["整個首頁只有一張卡的標題帶這個詞","市值那張卡沒有被標成約略值"],
    alsoRedWhy: "多標一張卡，同時違反「只有一張」與「市值卡不標」。",
  },
  {
    name: '市值改講今天的日期，不是結算那天',
    why: '市值用的是最後一次結算那天的收盤價。印今天的日期等於宣稱這是今天的數字 ——'
      + '使用者拿去跟券商對，會以為是券商錯了。',
    file: 'js/views/home.js',
    find: "        `用 ${fmtDate(settleDate)} 的收盤價計算`)",
    replace: "        `用 ${fmtDate(new Date().toLocaleDateString('sv'))} 的收盤價計算`)",
    test: 'uikittest',
    expect: '而且那個日期是結算日',
    alsoRed: ["（對照）它不是直接印今天 "],
    alsoRedWhy: "改成印今天，「不是直接印今天」那條對照同時紅。",
  },
  {
    name: '新的成本說明裡放一個禁用詞',
    why: '「建議」這種字放進損益的說明，就從「講清楚差在哪」變成投資建議了。',
    file: 'js/views/home.js',
    find: "      + '損益和報酬率是用這個成本算的，請當成約略值。'),",
    replace: "      + '損益和報酬率是用這個成本算的，建議當成約略值。'),",
    test: 'uikittest',
    expect: '成本說明沒有任何「建議」意味的字',
    alsoRed: ["（對照）同一個判準抓得到含禁用詞的句子，也不會誤殺現在這段說明"],
    alsoRedWhy: "對照組的反例用的就是現在這段說明；放進禁用詞，反例變成會被抓，那條對照一起紅。",
  },
  {
    name: '拿掉「主畫面 App 與 Safari 不共用」的警告',
    why: '在 Safari 匯出、到主畫面 App 匯入，資料會不見 —— 而匯出／匯入是'
      + '這個 App 換機與救援的唯一路徑。不講等於備份功能是壞的。',
    file: 'js/views/settings.js',
    find: "    h('p', { class: 'warn sm', dataset: { note: 'storageSplit' } },",
    replace: "    h('p', { class: 'warn sm', dataset: { note: 'gone' } },",
    test: 'uikittest',
  },
  {
    name: '賣光的那一檔繼續留在清單裡（還帶著均價）',
    why: '0 股旁邊擺一個均價是沒有意義的數字（實測過的殭屍列：'
      + '「2330 台積電 0 股 均價 500.00」）。出清了就不該佔版面。',
    file: 'js/views/holdings.js',
    find: '  const held = all.filter((x) => Number(x.shares) > 0);',
    replace: '  const held = all;',
    test: 'pathtest',
  },
  {
    name: '賣光的那一檔直接消失，不講「另有 N 檔已出清」',
    why: '這個 App 沒有雲端，任何「東西不見了」都很嚇人。'
      + '出清的檔可以收起來，但一定要讓他知道紀錄還在。',
    file: 'js/views/holdings.js',
    find: '  if (closed.length === 0) return [];',
    replace: '  return [];',
    test: 'pathtest',
  },
  {
    name: '賣出的對話框不再說「不記錄已實現損益」',
    why: 'UI 提供了賣出卻不說後果，他賣完找不到賺賠只會以為 App 壞了。',
    file: 'js/views/holding.js',
    find: "        '這個 App 不記錄已實現損益 —— 賣掉的那一筆賺賠不會出現在任何地方。'",
    replace: "        '賣出之後股數會減少。'",
    test: 'uikittest',
  },
  {
    name: '沒填平均成本的也硬算未實現損益',
    why: '沒有成本基礎就算不出報酬率。硬拿一個數字去算，畫面上會出現一個'
      + '看起來很正常、其實完全是編的報酬率 —— 這是 holdingtest「畫面上沒有『報酬率』'
      + '後面接著一個值」那條守的事（那條的 regex 一度壞掉，從來沒檢查過任何東西）。',
    file: 'js/settle.js',
    find: '    if (hd.avgCost == null) continue;',
    replace: '    const _avg = hd.avgCost == null ? 1 : hd.avgCost;',
    test: 'holdingtest',
  },
  {
    name: '把跳脫壞掉的 regex 放回 scenariotest',
    why: '\\s 在 regex 裡是「一個反斜線接著字母 s」，永遠不會命中 ——'
      + '而且**不會報錯**，那條斷言只是靜靜地從此再也不檢查東西。'
      + '這條突變守的是 shelltest 的靜態掃描真的抓得到。',
    file: 'scripts/scenariotest.mjs',
    find: "(t) => /當日損益\\s*[+-]?[\\d,]+/.test(t)",
    replace: "(t) => /當日損益\\\\s*[+-]?[\\\\d,]+/.test(t)",
    test: 'shelltest',
    expect: "沒有任何 regex 的反斜線被跳脫兩次（那種 regex 永遠不會命中，等於假斷言）",
  },
  {
    name: '配股不稀釋均價',
    why: '配股是「總成本不變、股數變多」。均價不跟著降的話，成本被高估、報酬率被低估 —— 而成本正是使用者在跟券商對帳的那個數字。eventtest 情境 5 只驗股數，驗不到這件事（那筆持股沒填均價）。',
    file: 'js/avgcost.js',
    find: 'return { avgCost: divToNumber(totalCost, newShares), reason: REASON.STOCK_DIVIDEND };',
    replace: 'return { avgCost: oldAvg, reason: REASON.STOCK_DIVIDEND };',
    test: 'eventtest',
  },
  {
    name: '配股稀釋時除以配股前的股數',
    why: '除錯股數的話均價完全沒變（等於沒稀釋），但 reason 還是 stockDividend —— 看起來一切正常。這是比「不稀釋」更難發現的版本。',
    file: 'js/avgcost.js',
    find: 'return { avgCost: divToNumber(totalCost, newShares), reason: REASON.STOCK_DIVIDEND };',
    replace: 'return { avgCost: divToNumber(totalCost, oldShares), reason: REASON.STOCK_DIVIDEND };',
    test: 'eventtest',
  },
  {
    name: '匯入前不逐列檢查主鍵',
    why: 'applyImport 是「先 clear 再逐列 put」。缺主鍵的那一列會在 store 已經被清空之後才丟 DataError —— 使用者原本的持股不見了、新資料只進了一半、別的 store 還是舊的。實測過一次真的會少資料。',
    file: 'js/backup.js',
    find: "  if (badRows.length) {",
    replace: "  if (badRows.length && false) {",
    test: 'backuptest',
  },
  {
    name: 'package.json 沒有 version 欄位',
    why: 'package.json 的 version 是「這包是哪一版」的第一個判斷依據。它停在 0.1.0 而 App 已經 0.7.x 的時候，看 repo 的人會以為這個專案沒在動 —— 而且沒有任何程式會因此出錯，所以只能靠斷言盯著。',
    file: 'package.json',
    find: '  "version": "',
    replace: '  "versionX": "',
    test: 'shelltest',
    expect: "package.json 的 version 與 js/version.js 一致（",
  },
  {
    name: '突變挑選器不看測試的相依',
    why: 'mutationtest --changed 少挑幾條的樣子跟全綠一模一樣。不看相依的話，改 js/money.js 會一條都挑不到 —— 沒有任何測試直接 import 它，全是經由 settle.js／dividend.js 間接用到。',
    file: 'scripts/affected.mjs',
    find: '    for (const f of changed) if (deps(m.test).has(f)) return true;',
    replace: '    // 不看相依',
    test: 'shelltest',
    expect: "改到 js/money.js → settletest 的兩條都挑",
    alsoRed: ["改到 js/ui.js → uikittest 與 shelltest 的都挑"],
    alsoRedWhy: "兩條都是「靠相依才挑得到」的情境；拿掉看相依那一行，兩條一起挑不到。",
  },
  {
    name: 'moduleClosure 只展開一層，不遞移',
    why: '只展開一層的話，測試碰得到的模組清單會少掉一大半（settletest 會只剩 settle.js，看不到 money.js），--changed 就會漏挑。',
    file: 'scripts/affected.mjs',
    find: "      if (next.startsWith('js/')) walk(next);",
    replace: "      if (false) walk(next);",
    test: 'shelltest',
    expect: "遞移展開：直接 import settle.js，連帶把 money.js 與 format.js 都算進來",
  },
  {
    name: 'npm test 鏈裡少一支，文件的數字沒跟上',
    why: '文件漂移不會讓任何測試變紅。實際發生過：STATUS 與 README 一起寫「138 條突變」而實際 182、上線檢查清單寫「110 條／25 支」—— 三處數字三個版本，全部綠燈。從 test 鏈拿掉一支，文件寫的支數就該對不上，而且那一支還留在 README 表格裡（等於 README 列了一支沒人跑的測試）。',
    file: 'package.json',
    find: 'node scripts/roctest.mjs && ',
    replace: '',
    test: 'doctest',
    expect: "文件裡每一處寫的測試支數都等於實際的 ",
    alsoRed: ["README 有但 npm test 沒有的，就是刻意排除的那幾支"],
    alsoRedWhy: "鏈上少一支 roctest：支數對不上，README 列著它卻不在鏈上、又不是刻意排除的。",
  },
  {
    name: 'README 的測試表格漏掉一支',
    why: 'README 表格原本就漏了 scenariotest 與 pathtest —— 那兩支加起來 140+ 條斷言，看 README 的人根本不知道它們存在，也就不會在改動後想到要跑。',
    file: 'README.md',
    find: '| `npm run pathtest` |',
    replace: '| `npm run pathtest-打錯字了` |',
    test: 'doctest',
    expect: "npm test 跑的每一支都列在 README 表格裡（漏了的話，沒人知道它存在）",
  },
  {
    name: '把被禁用的 type="time" 用回去',
    why: 'STATUS 元件慣例表明文禁止 <input type="time">（iOS 會拉滿整個卡片、空值時顯示當下時間）。uikittest 有掃，但要開瀏覽器；doctest 是純靜態的第二道，改壞了要立刻紅。',
    file: 'js/ui.js',
    find: 'export function timeSelect(',
    replace: 'const _banned = { type: \'time\' };\nexport function timeSelect(',
    test: 'doctest',
    expect: "程式裡沒有任何一處用到被禁用的元件",
  },
  {
    name: 'A14：holdingtest 的頁面文字抓成空的',
    why: '「畫面上沒有報酬率數字」這條的母體是一個字串 —— 字串是空的時候它照樣通過。這條斷言踩過兩層坑（正則少了反斜線、母體抓成上一個情境的頁面），兩層都讓它變成永遠通過。前提斷言就是為了讓「母體是空的」這件事會紅。',
    file: 'scripts/holdingtest.mjs',
    find: '  const viewText = () => page.$eval(\'#view\', (el) => el.textContent.replace(/\\s+/g, \' \'));',
    replace: '  const viewText = () => Promise.resolve(\'\');',
    test: 'holdingtest',
  },
  {
    name: 'A14：holdingtest 的不支援列一列都不種',
    why: 'fixture 裡只要沒有上櫃代號，「所有標示不支援的列都沒有報價數字」就是拿空母體在講話。noneOf 本身會擋空母體，但「剛好 1 列」這個前提被破壞時也要有人講話。',
    file: 'scripts/holdingtest.mjs',
    find: '      { code: \'6488\', shares: 500, date: \'2026-01-05\' },',
    replace: '',
    test: 'holdingtest',
  },
  {
    name: 'A14：pathtest 的持股頁文字抓成空的',
    why: '「畫面上沒有 NaN／Infinity／undefined」的母體是一個字串。持股頁沒渲染時那句話等於沒說 —— 而「頁面根本沒畫出來」正是最該被抓到的失敗。',
    file: 'scripts/pathtest.mjs',
    find: '        holdingsText: view.textContent.replace(/\\s+/g, \' \'),',
    replace: '        holdingsText: \'\',',
    test: 'pathtest',
  },
  {
    name: 'A14：uikittest 的總覽文字抓成空的',
    why: '「總覽上沒有資料狀態那張卡」的母體是一個字串，總覽沒畫出來時它照樣通過。',
    file: 'scripts/uikittest.mjs',
    find: '    const homeText = document.querySelector(\'#view\').textContent.replace(/\\s+/g, \' \');',
    replace: '    const homeText = \'\';',
    test: 'uikittest',
  },
  {
    name: 'A14：calcviewtest 的試算頁文字抓成空的',
    why: '「沒填完不會生出結果」那一組（沒有結果區塊、沒有期末數字、沒有預設值）在畫面整個沒渲染時會一起通過 —— 三條都是在問「有沒有出現某個東西」。前提斷言負責先證明頁面還在。',
    file: 'scripts/calcviewtest.mjs',
    find: '  const pageText = await page.$eval(\'#view\', (el) => el.textContent.replace(/\\s+/g, \' \'));',
    replace: '  const pageText = \'\';',
    test: 'calcviewtest',
  },
  {
    name: 'A14：calcviewtest 的 fixture 不種個股',
    why: '「個股不在裡面」只有在 fixture 真的種了個股時才有意義。把 2330／2317 拿掉，那條會變成恆真而且沒人會發現 —— 前提斷言就是為了擋這個。',
    file: 'scripts/calcviewtest.mjs',
    find: '    for (const [c, sh] of [[\'0050\', 3000], [\'00878\', 8000], [\'2330\', 1000], [\'2317\', 500]]) {',
    replace: '    for (const [c, sh] of [[\'0050\', 3000], [\'00878\', 8000]]) {',
    test: 'calcviewtest',
  },
  {
    name: 'A1：日曆用完前不提醒（門檻改成 0 天）',
    why: '2027-01-01 一到，沒有隔年日曆就整個更新流程停擺 —— 除權息同步與定期定額待確認也一起停。門檻是 0 的話，要到日曆真的用完那天才提醒，而那時已經來不及更新了。實測（2026-09-17）證交所的 holidaySchedule 只有 2026 年，所以這個提醒是目前唯一的防線。',
    file: 'js/market.js',
    find: 'export const CALENDAR_WARN_DAYS = 45;',
    replace: 'export const CALENDAR_WARN_DAYS = 0;',
    test: 'roctest',
    expect: "剛好 45 天就開始提醒",
  },
  {
    name: 'A1：covers 退回只認第一年',
    why: '多年份日曆的意義就在跨年那一步。只認第一年的話，2027-01-04 的 covers 回 false，prevTradingDay 回 null，整條回補鏈斷在跨年那天 —— 而這是每年都會發生一次的事。',
    file: 'js/market.js',
    find: '  return cal.years.includes(y);',
    replace: '  return cal.years[0] === y;',
    test: 'roctest',
    expect: "也涵蓋 2027",
    alsoRed: ["2027 第一個交易日的前一個交易日是 2026-12-31","2027-01-04 是交易日","2027-01-01 不是（元旦）","跨年的區間也算得出來","跨年的缺漏日回補得出來"],
    alsoRedWhy: "日曆只認第一年，所有落在 2027 的推算（交易日、休市、跨年接續、區間、缺漏回補）一起錯。",
  },
  {
    name: 'A1：makeCalendar 看不懂多年格式',
    why: 'calendar.json 已經是多年格式。看不懂的話會退回舊格式那條路、days 變成空陣列，於是「有沒有日曆」變成 false —— App 會說「尚未取得開休市日」，而檔案明明就在那裡。',
    file: 'js/market.js',
    find: '  if (json?.years && typeof json.years === \'object\' && !Array.isArray(json.years)) {',
    replace: '  if (false) {',
    test: 'datatest',
  },
  {
    name: 'A1：日曆快用完時總覽不出聲',
    why: '提醒只寫在設定頁的話，等於沒有 —— 使用者每天看的是總覽，不會特地去翻設定。這條把總覽那一行拿掉，pathtest 路徑 9 必須紅。',
    file: 'js/views/home.js',
    find: '    runway?.warn && runway.lastDay',
    replace: '    false && runway?.warn && runway.lastDay',
    test: 'pathtest',
  },
  {
    name: 'A1：跨年的訊息不講怎麼恢復',
    why: '只說「今天不在範圍內」的話，使用者不知道這是 App 該更新了 —— 會以為自己的資料壞了，或以為 App 整個掛掉。訊息要講得出下一步。',
    file: 'js/update.js',
    find: '      message: `開休市日只涵蓋 ${span} 年，今天不在範圍內。更新 App 之後就會恢復。`,',
    replace: '      message: `開休市日只涵蓋 ${span} 年，今天不在範圍內。`,',
    test: 'pathtest',
  },
  {
    name: 'A2：六個來源排隊抓（回到循序）',
    why: '循序的時候最壞是 6 × 8 秒逾時 ＝ 48 秒：按下「看新聞」之後盯著空白將近一分鐘，而且第一家掛掉就拖垮後面全部。這條讓每一家等前一家跑完，newstest 量到的總時間就會從約 300ms 變成 1,800ms。',
    file: 'js/news.js',
    find: '    const r = await fetchSource(source, { fetchImpl });',
    replace: '    const prev = globalThis.__newsSeq ?? Promise.resolve();\\n    let release; globalThis.__newsSeq = new Promise((z) => { release = z; });\\n    await prev;\\n    const r = await fetchSource(source, { fetchImpl });\\n    release();',
    test: 'newstest',
  },
  {
    name: 'A2：合併順序跟著「誰先回來」跑',
    why: 'allSettled 之後回應的先後是隨機的。照那個順序合併的話，同一批新聞每次開啟的排序都不一樣 —— 看起來像資料在跳，而且完全不會報錯。這是並行最容易忽略的副作用。',
    file: 'js/news.js',
    find: '  for (let i = 0; i < SOURCES.length; i += 1) {',
    replace: '  for (let i = SOURCES.length - 1; i >= 0; i -= 1) {',
    test: 'newstest',
  },
  {
    name: 'A9：算好的進度沒有人接',
    why: 'PLAN §2.2 說長假回補時畫面要顯示進度。onProgress 一直都有在回報，但 app.js 開機那次與設定頁的重新整理都沒接 —— 算好的進度沒有任何畫面看得到，使用者盯著一個不動的畫面，分不出它在做事還是當掉了。這正是慣例 20 的形狀：契約的兩端只測了一端。',
    file: 'js/store.js',
    find: '      state.progress = info;',
    replace: '      // state.progress = info;',
    test: 'pathtest',
  },
  {
    name: 'A9：跑完不把進度收起來',
    why: '留著的話畫面會一直掛著「回補中 12/12」，看起來像卡住了 —— 實際上早就跑完。',
    file: 'js/store.js',
    find: '    state.progress = null;',
    replace: '    // 不收',
    test: 'pathtest',
  },
  {
    name: 'A10：上限存不進去',
    why: '設定頁寫著「下個月自動歸零，或調高上限」，但以前沒有任何地方可以調，secrets.setCap 一直存在、從來沒有人呼叫 —— 畫面承諾了一件做不到的事。',
    file: 'js/secrets.js',
    find: '  await db.put(\'secrets\', { ...r, capMicroUsd: microUsd });',
    replace: '  // 不寫',
    test: 'secret-leak-test',
  },
  {
    name: 'A10：上限的單位沒換算（美金當成微美金）',
    why: '畫面收美金、存進去是微美金，差一百萬倍。換算漏掉的話，填 2 會變成 0.000002 美金上限 ——「今日觀察」立刻被停用，而畫面上的數字看起來完全正常。',
    file: 'js/views/settings.js',
    find: '    const micro = Math.round(Number(raw) * 1e6);',
    replace: '    const micro = Math.round(Number(raw));',
    test: 'secret-leak-test',
  },
  {
    name: 'B3：代號表一產生就說它過期（門檻改 0）',
    why: '門檻是 0 的話，每次「找不到代號」都會附上「可能已經有新上市的代號沒收進來」—— 那句話就變成雜訊，使用者很快會學會忽略它，真的過期時也不會注意。',
    file: 'js/catalog.js',
    find: 'export const CATALOG_STALE_DAYS = 60;',
    replace: 'export const CATALOG_STALE_DAYS = 0;',
    test: 'datatest',
  },
  {
    name: 'B3：找不到代號時不提代號表可能過期',
    why: '使用者想加一檔新上市的股票、代號表還沒收進去 —— 他看到的只有「找不到代號」，會以為自己打錯了，於是重打一次、再重打一次。',
    file: 'js/holdings.js',
    find: '    const note = catalog.stalenessNote();',
    replace: '    const note = null;',
    test: 'holdingtest',
  },
  {
    name: '設定頁：畫到一半丟例外',
    why: '使用者回報「設定頁無法點擊」。一個沒被攔住的例外會讓 render() 根本沒跑到 —— 畫面停在上一頁的內容、什麼都點不動，而且不會有任何提示。',
    file: 'js/views/settings.js',
    find: '  const key = await secrets.status();',
    replace: '  const key = await secrets.status(); if (key) throw new Error(\'設定頁畫到一半壞掉\');',
    test: 'uikittest',
  },
  {
    name: '設定頁：一張卡片變成整頁遮罩',
    why: '任何 position: fixed; inset: 0 的東西（例如沒收乾淨的 modal 遮罩）都會讓整頁看起來正常、卻什麼都點不到。命中測試（elementFromPoint）是唯一抓得到這種事的斷言。',
    file: 'js/views/settings.js',
    find: '  return h(\'section\', { class: \'card\', dataset: { card: \'about\' } },',
    replace: '  return h(\'section\', { class: \'card modal-overlay\', dataset: { card: \'about\' } },',
    test: 'uikittest',
  },
  {
    name: '設定頁：開關點了不會翻',
    why: '「點得到」跟「點了有反應」是兩件事。事件處理器綁壞了的話，命中測試照樣全過，只有真的去點、再看狀態有沒有變，才抓得到。',
    file: 'js/ui.js',
    find: '  sw.addEventListener(\'click\', toggle);',
    replace: '  sw.addEventListener(\'dblclick\', toggle);',
    test: 'uikittest',
  },
  {
    name: 'view 炸了只印 console，畫面不講',
    why: '使用者回報「底部的設定按了沒反應」。view 丟例外時路由只 console.error：hash 換了、分頁亮了、#view 還是上一頁，而 iPhone 沒有 console。畫面上不講，使用者就沒有任何東西可以回報。',
    file: 'js/router.js',
    find: '      if (viewError) {',
    replace: '      if (false) {',
    test: 'shelltest',
    expect: "view 丟例外時，畫面上出現錯誤卡",
    alsoRed: ["頂列標題換成「這一頁打不開」","把打不開的那條路徑寫出來","**例外訊息原樣放在畫面上**：「","先安撫：資料沒事","寫出目前執行的版本 ","有「更新到最新版」的按鈕","也留了一條回總覽的路"],
    alsoRedWhy: "錯誤卡整張沒出來，卡片上的每一項（標題、路徑、訊息、安撫、版本、兩個按鈕）各有一條斷言，一起紅。",
  },
  {
    name: 'view 炸了的錯誤卡片不放例外訊息',
    why: '卡片上只寫「打不開」而不放 e.message 的話，使用者截圖回報也看不出根因 —— 等於沒講。',
    file: 'js/app.js',
    find: '      h(\'p\', { class: \'mono sm\', dataset: { field: \'viewErrorMessage\' } }, message),',
    replace: '      h(\'p\', { class: \'mono sm\', dataset: { field: \'viewErrorMessage\' } }, \'（略）\'),',
    test: 'shelltest',
    expect: "**例外訊息原樣放在畫面上**：「",
  },
  {
    name: '開機沒有硬期限（store.init 吊死就整個不開）',
    why: '使用者回報：按下「更新」之後只剩標題列、下面整片空白，只能把 App 滑掉重開。iOS 在 SW 剛換手時 fetch／IndexedDB 有機會永遠不回來，boot() 無條件等 store.init() 的話，路由與分頁永遠不啟動。把期限拉到 60 秒等於沒有期限：pathtest 路徑 10 的 freshApp 會先逾時。',
    file: 'js/app.js',
    find: 'const BOOT_DEADLINE_MS = 6000;',
    replace: 'const BOOT_DEADLINE_MS = 60000;',
    test: 'pathtest',
  },
  {
    name: '換版重載之後路由沒啟動（畫面就是那片空白）',
    why: '「更新之後畫面是空的」以前沒有任何斷言看得見 —— upgradecheck 只驗快取名稱換了。重載後 boot() 若走不到 startRouter()，沒有任何 view 會被 render，分頁與卡片都不會出現，使用者看到的正是「只剩標題列、下面整片空白」。（第一版突變改的是 boot 裡的 renderTabs()，但 shell.render() 自己也會畫分頁，拿掉沒效果 —— 第 34 條那種改在死路上。）',
    file: 'js/app.js',
    find: '  prefs.applyFontScale();\n  startRouter();',
    replace: '  prefs.applyFontScale();\n  // startRouter();',
    test: 'upgradecheck',
  },
  {
    name: 'A3：對話框開著時後面的頁面不 inert',
    why: '讀屏與鍵盤使用者按 Tab 會跑到對話框後面那一頁，畫面上什麼都看不出來。',
    file: 'js/ui.js',
    find: '    if (app) app.inert = true;',
    replace: '    // 不 inert',
    test: 'uikittest',
  },
  {
    name: 'A3：關掉對話框之後焦點不還原',
    why: '焦點掉回 body，讀屏會從頁面頂端重唸一遍；鍵盤使用者要重新 Tab 回原本的位置。',
    file: 'js/ui.js',
    find: '      if (opener && opener.isConnected && typeof opener.focus === \'function\') {',
    replace: '      if (false) {',
    test: 'uikittest',
  },
  {
    name: 'A3：Tab 不在卡片內循環',
    why: '走到最後一顆按鈕再按 Tab，焦點就跑出對話框 —— 而 inert 只擋得住 #app，擋不住 body 與 toast。',
    file: 'js/ui.js',
    find: '      if (e.key !== \'Tab\') return;',
    replace: '      if (e.key !== \'Tab\' || true) return;',
    test: 'uikittest',
  },
  {
    name: 'A4：分頁圖示不 aria-hidden',
    why: 'emoji 對讀屏是「圖形」；實測過沒藏的時候無障礙樹裡分頁連結**沒有名字**。',
    file: 'js/shell.js',
    find: '    }, h(\'span\', { class: \'tab-icon\', \'aria-hidden\': \'true\' }, t.icon), h(\'span\', { class: \'tab-label\' }, t.label));',
    replace: '    }, h(\'span\', { class: \'tab-icon\' }, t.icon), h(\'span\', { class: \'tab-label\' }, t.label));',
    test: 'uikittest',
  },
  {
    name: 'A4：#view 又變回 aria-live',
    why: '整個畫面是 live region 的話，每次換頁讀屏都會把整頁唸一遍。',
    file: 'index.html',
    find: '    <main id="view"></main>',
    replace: '    <main id="view" aria-live="polite"></main>',
    test: 'shelltest',
    expect: "#view 沒有 aria-live（該朗讀的是 #toast）",
  },
  {
    name: 'A5：鍵盤焦點的 outline 改成 none',
    why: '自訂外觀的按鈕在深色底上沒有 outline 等於隱形 —— 用鍵盤或切換控制的人完全不知道自己走到哪。',
    file: 'css/style.css',
    find: '  outline: 2px solid var(--accent-strong);\n  outline-offset: 2px;',
    replace: '  outline: none;',
    test: 'uikittest',
  },
  {
    name: 'A7：新聞外連少了 noopener',
    why: '開新分頁的連結沒有 noopener，新分頁拿得到 window.opener，可以把這一頁導去別的網址。',
    file: 'js/views/news.js',
    find: '    rel: \'noopener noreferrer\',',
    replace: '    rel: \'noreferrer\',',
    test: 'shelltest',
    expect: "每一處 target: '_blank' 都帶 rel: 'noopener'",
  },
  {
    name: 'A16：manifest 沒有 id',
    why: '沒有 id 的話瀏覽器靠 start_url 認 App，start_url 一改就會裝成第二個 App。',
    file: 'manifest.webmanifest',
    find: '  "id": "./",\n',
    replace: '',
    test: 'shelltest',
    expect: "manifest 有 id（瀏覽器靠它認出「同一個 App」，換 start_url 也不會裝成第二個）",
  },
  {
    name: 'A16：拿掉 color-scheme meta',
    why: 'CSS 載進來之前表單控制項會先用白底畫一幀 —— 深色 App 開頁閃一下白。',
    file: 'index.html',
    find: '  <meta name="color-scheme" content="dark" />\n',
    replace: '',
    test: 'shelltest',
    expect: "index.html 有 color-scheme meta（表單控制項第一幀就是深色，不先閃白）",
  },
  {
    name: '看門狗等 10 分鐘才出手',
    why: '開機超過 12 秒還是空的就該補卡。等 10 分鐘等於沒有看門狗 —— 使用者早就把 App 滑掉了。',
    file: 'js/bootguard.js',
    find: '  var BOOT_GUARD_MS = 12000;',
    replace: '  var BOOT_GUARD_MS = 600000;',
    test: 'pathtest',
  },
  {
    name: '看門狗聽到載入失敗也不提早補卡',
    why: 'script／link 的載入失敗不會冒泡到 window.onerror，要用 capture 才接得到；接到之後 1.5 秒就該補卡。拿掉提早補卡的話只能等滿 12 秒 —— pathtest 路徑 11 驗的是「偵測到失敗就提早」。（第一版突變只翻 sawLoadError 旗標，那只影響文案不影響時機 —— 第 34 條那種改在死路上，實測沒紅。）',
    file: 'js/bootguard.js',
    find: '      setTimeout(function () { rescue(\'loadError\'); }, AFTER_ERROR_MS);',
    replace: '      /* 不提早 */',
    test: 'pathtest',
  },
  {
    name: '看門狗在畫面已經有東西時也出手',
    why: '看門狗只能在沒人畫得出來的時候補卡。畫面有東西還硬塞一張，正常開機每 12 秒就會多出一張救援卡。',
    file: 'js/bootguard.js',
    find: '    if (fired || booted() || !viewEmpty()) return;',
    replace: '    if (fired) return;',
    test: 'pathtest',
  },
  {
    name: '更新流程又把 unregister 放回去',
    why: 'unregister 之後這一頁就沒有 SW 了，重載時二十幾個檔只能走網路，任何一個拿不到整張 module 圖就不執行 —— 這正是「按更新之後只剩標題列」的根因（MealMate 同病，v0.27.0 驗證有效）。shelltest 靜態稽核 applyNow 裡不得有 unregister。',
    file: 'js/app.js',
    find: '        reload();\n      }, 1500);',
    replace: '        navigator.serviceWorker.getRegistration().then((r) => r && r.unregister()).finally(reload);\n      }, 1500);',
    test: 'shelltest',
    expect: "applyNow（更新提示列與自動換版）裡沒有 unregister —— 只 skipWaiting＋reload",
  },
  {
    name: 'app.js 不標 data-booted',
    why: '看門狗靠這個旗標分辨「module 圖跑起來了」；不標的話它會在正常開機時等 12 秒後也去看 #view —— 目前靠 viewEmpty 撐著，但旗標是主判準。pathtest 路徑 11 驗重新載入後旗標為 1。',
    file: 'js/app.js',
    find: '  document.documentElement.setAttribute(\'data-booted\', \'1\');',
    replace: '  // 不標',
    test: 'pathtest',
  },
  {
    name: 'A8：CSP 又放回 unsafe-inline',
    why: 'style-src 有 \'unsafe-inline\' 的話，頁面被注入時可以塞 style 屬性把畫面蓋住或藏起來。拿掉之後只剩 6 處 inline style 要改，改完就該釘住。',
    file: 'index.html',
    find: 'style-src \'self\';',
    replace: 'style-src \'self\' \'unsafe-inline\';',
    test: 'shelltest',
    expect: "style-src 沒有 'unsafe-inline'（頁面被注入時也塞不進 style 屬性）",
  },
  {
    name: 'A8：集中度長條又用字串 style',
    why: 'CSP 沒有 unsafe-inline 之後，style 屬性字串會被瀏覽器**靜默**忽略：長條寬度全變 0，畫面看起來很正常。h() 對字串丟錯、靜態掃描也擋 —— 但真正的證據是瀏覽器量出來的寬度。',
    file: 'js/views/holdings.js',
    find: '      h(\'div\', { class: \'bar-fill\', style: { \'--w\': `${Math.max(0, Math.min(100, pct))}%` } })),',
    replace: '      (() => { const d = document.createElement(\'div\'); d.className = \'bar-fill\'; d.setAttribute(\'style\', `width:${Math.max(0, Math.min(100, pct))}%`); return d; })()),',
    test: 'pathtest',
  },
  {
    name: 'A8：h() 又默默接受字串型 style',
    why: '字串型 style 在 CSP 下被靜默忽略。h() 丟錯是第一道防線：讓回頭路在測試裡就炸，而不是上線後長條圖悄悄變 0。',
    file: 'js/ui.js',
    find: '      if (typeof v !== \'object\') throw new TypeError(`h(): style 只接受物件（{ \'--w\': \'40%\' }），不接受字串「${v}」`);',
    replace: '      if (typeof v !== \'object\') { el.setAttribute(\'style\', String(v)); continue; }',
    test: 'shelltest',
    expect: "字串型 style 直接丟錯：「",
  },
  {
    name: 'A11：塞一個沒人用的匯出進去',
    why: '死碼不會讓任何測試變紅，只會慢慢堆。零使用掃描把「沒人用」變成一條會紅的斷言。',
    file: 'js/prices.js',
    find: 'export async function fetchDayAll(client) {',
    replace: 'export function __nobodyUsesThis() { return 1; }\nexport async function fetchDayAll(client) {',
    test: 'shelltest',
    expect: "除了允許清單（",
  },
  {
    name: 'B2：導覽請求沒有逾時',
    why: 'GitHub Pages 慢或行動網路訊號差時，以前要等到 fetch 自己失敗（可能幾十秒）才退回快取 —— 而 index.html 本來就在 SHELL 裡。',
    file: 'sw.js',
    find: 'const NAV_TIMEOUT_MS = 3000;',
    replace: 'const NAV_TIMEOUT_MS = 60000;',
    test: 'pathtest',
  },
  {
    name: 'B2：導覽請求永遠走快取（逾時 0）',
    why: '逾時 0 等於 cache-first：網路正常時也拿不到新的 index.html。換版還是靠 registration.update() 會成功，但「網路正常時導覽拿到網路版」這件事就壞了。pathtest 路徑 12 的對照 A 塞了標記驗這個。',
    file: 'sw.js',
    find: 'const NAV_TIMEOUT_MS = 3000;',
    replace: 'const NAV_TIMEOUT_MS = 0;',
    test: 'pathtest',
  },
  // ──── EXPECT_REQUIRED_BELOW ────
  // 從這一行以下（2026-09-23，SPEC_測試可信度 A）新增的突變**一律要帶 expect**：
  // 失敗輸出裡要有一條 ✗ 含這段字，才算紅在對的那一條斷言。checkmutations 會擋沒帶的。
  // 新突變請一律加在這一段的最後面。
  {
    name: 'A：判定忽略 expect，紅了就算',
    why: '這就是 A 項要修的洞：改壞之後「某處」紅了，就被當成證明了它想守的那一條有效。',
    file: 'scripts/mutjudge.mjs',
    find: "  if (!failed.some((f) => f.includes(expect))) return { verdict: 'wrong-place', failed, extra: [] };\n",
    replace: '',
    test: 'checkmutations',
    expect: '對照：紅了，但 expect 只出現在細節行、不在任何 ✗ 行',
    alsoRed: ["對照：測試直接崩了","對照：expect 寫錯成另一組存在的標籤","條突變都還有效（find 剛好一次"],
    alsoRedWhy: "判定一律回 red，「紅錯地方」的兩組對照都紅；checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: 'A：細節行也被當成失敗的斷言',
    why: '細節行（實際值、例子）常常剛好含 expect 那幾個字；算進去的話，紅在別條也會被判成紅在對的那一條。',
    file: 'scripts/mutjudge.mjs',
    find: '    const m = /^ {2}✗ (.+)$/.exec(line.replace(/\\r$/, \'\'));',
    replace: '    const m = /^\\s+(?:✗ )?(.+)$/.exec(line.replace(/\\r$/, \'\'));',
    test: 'checkmutations',
    expect: '從輸出取出失敗的斷言訊息',
    alsoRed: ["帶 expect、紅在含 expect 的那一條","對照：紅了，但 expect 只出現在細節行","對照：expect 寫錯成另一組存在的標籤","只紅對應：紅在對的那一條、別組也一起紅","只紅對應（必過）：","條突變都還有效（find 剛好一次"],
    alsoRedWhy: "取失敗訊息的程式是每一個判定的基礎，改壞它，靠它的每一組判定對照都紅；checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: 'A2：expect 打錯字也放行',
    why: '打錯字的 expect 永遠不會命中，那條突變每次都會判成「紅錯地方」—— 而且要等整套才看得到。',
    file: 'scripts/mutjudge.mjs',
    find: '  const probs = testSrc.includes(mut.expect) ? [] : [',
    replace: '  const probs = true ? [] : [',
    test: 'checkmutations',
    expect: 'expect 檢查抓得到打錯字',
    alsoRed: ["條突變都還有效（find 剛好一次"],
    alsoRedWhy: "checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: 'A：新突變不帶 expect 也放行',
    why: '「從這一份起，新增的突變一律要帶 expect」如果沒有東西擋，下一條沒帶的突變就會悄悄進來。',
    file: 'scripts/mutjudge.mjs',
    find: "  return (src.slice(src.indexOf('const MUTATIONS = ['), at).match(/^\\s+find:/gm) || []).length;",
    replace: "  return (src.match(/^\\s+find:/gm) || []).length;",
    test: 'checkmutations',
    expect: '對照：標記在第 2 條之後',
    alsoRed: ["條突變都還有效（find 剛好一次","標記以下的 "],
    alsoRedWhy: "「標記以下的都帶 expect」是同一個判斷在真實清單上的結果；checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: '套用突變改回 String.replace(字串, 字串)',
    why: '替換字串裡的 $$、$&、$\' 會被當成特殊序列，突變實際寫進去的程式碼跟條目寫的不一樣（接手者第 40 條）。',
    file: 'scripts/mutjudge.mjs',
    find: 'export const applyMutation = (body, find, replace) => body.split(find).join(replace);',
    replace: 'export const applyMutation = (body, find, replace) => body.replace(find, replace);',
    test: 'checkmutations',
    expect: '原樣寫進去（String.replace(字串, 字串) 會把它們當特殊序列）',
    alsoRed: ["條突變都還有效（find 剛好一次"],
    alsoRedWhy: "checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: 'B：挑舊版基準改回「上一個 commit」',
    why: '連續幾個文件 commit 之後，上一個 commit 跟現在是同一版 —— upgradecheck 前提必紅，連帶擋掉整套突變（2026-09-21 白跑 540 秒）。',
    file: 'scripts/oldrev.mjs',
    find: '    if (c.version && c.version !== current) return { rev: c.rev, version: c.version, skipped: commits.indexOf(c) };',
    replace: '    if (commits[1]) return { rev: commits[1].rev, version: commits[1].version, skipped: 1 };',
    test: 'shelltest',
    expect: '最近三個都是文件 commit（版本一樣）',
    alsoRed: ["工作目錄 bump 了還沒 commit","整段歷史都是同一版","實際挑到 "],
    alsoRedWhy: "挑舊版的函式改成「上一個 commit」，每一種歷史情境（bump 未 commit、整段同版、真實歷史）都挑錯。",
  },
  {
    name: 'B：沒有可比的舊版時亂挑一個',
    why: '全新的 repo 或整段歷史同一版時，要講「沒得比、略過了」；亂挑一個就變成拿同一版跟自己比，或靜默通過。',
    file: 'scripts/oldrev.mjs',
    find: '  return { rev: null, version: null, reason:',
    replace: "  return { rev: commits[0]?.rev ?? 'HEAD', version: null, reason:",
    test: 'shelltest',
    expect: '整段歷史都是同一版',
    alsoRed: ["空的歷史（全新的 repo）"],
    alsoRedWhy: "空的歷史與整段同版走的是同一個「沒得挑」的分支。",
  },
  {
    name: 'B：upgradecheck 又直接用 HEAD~1',
    why: '純函式對了但 upgradecheck 沒用它，等於沒修。這條從真實入口驗：現在 HEAD~1 是文件 commit，舊版＝新版。',
    file: 'scripts/upgradecheck.mjs',
    find: "const PICKED = process.argv[2] ? { rev: process.argv[2], manual: true } : findOldRev(ROOT, NEW_VERSION_EARLY);",
    replace: "const PICKED = process.argv[2] ? { rev: process.argv[2], manual: true } : { rev: 'HEAD~1', version: '?', skipped: 0 };",
    test: 'upgradecheck',
    expect: '確實不同版',
    alsoRed: ["第一次開的確實是舊版（"],
    alsoRedWhy: "舊版挑錯（跟新版同版），「第一次開的是舊版」那條前提同時不成立。",
  },
  {
    name: 'C：過期檢查永遠放行（find 出現幾次都算有效）',
    why: '條狀圖那條從 v0.7.22 過期到 2026-09-21 才被發現，因為只有整套跑到它時才會檢查。秒級檢查失效的話，又回到要等整套。',
    file: 'scripts/mutjudge.mjs',
    find: '    if (n !== 1) probs.push(`find 在 ${mut.file} 出現 ${n} 次（需要剛好 1 次）`);',
    replace: '    if (false) probs.push(`find 在 ${mut.file} 出現 ${n} 次（需要剛好 1 次）`);',
    test: 'checkmutations',
    expect: '過期檢查抓得到 find 不存在、出現兩次',
  },
  {
    name: 'D1：STATUS 用「突變 N 條」的寫法寫錯總數',
    why: '以前 doctest 只認「N 條突變」，上線清單那一行寫成另一種寫法，就漂到 185 條沒人發現。',
    file: 'docs/STATUS.md',
    find: '每次要交給使用者日常使用之前，從頭跑一遍。',
    replace: '每次要交給使用者日常使用之前，從頭跑一遍（突變 1 條）。',
    test: 'doctest',
    expect: '文件裡每一處寫的突變條數都等於實際的',
  },
  {
    name: 'D1：STATUS 用「N 支＋」的寫法寫錯支數',
    why: '「一處 27 支、一處 28 支」就是這樣來的：有些寫法 doctest 認不得，數字錯了也不會紅。',
    file: 'docs/STATUS.md',
    find: '每次要交給使用者日常使用之前，從頭跑一遍。',
    replace: '每次要交給使用者日常使用之前，從頭跑一遍（1 支＋）。',
    test: 'doctest',
    expect: '文件裡每一處寫的測試支數都等於實際的',
  },
  {
    name: 'D1：「當時」不再被當成歷史紀錄跳過',
    why: '歷史紀錄（當時 28 支）會被當成現在的總數而紅；為了讓它不紅，下一個人就只好改寫成認不得的樣子 —— 又回到漂移。',
    file: 'scripts/doctest.mjs',
    find: '  const notHistory = (m) => !/當時\\s*\\**\\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index));',
    replace: '  const notHistory = () => true;',
    test: 'doctest',
    expect: '前面有「當時」的是歷史紀錄，跳過',
    alsoRed: ["文件裡每一處寫的突變條數都等於實際的 ","文件裡每一處寫的測試支數都等於實際的 "],
    alsoRedWhy: "歷史紀錄不再跳過，文件裡「當時 N 條／支」的舊數字被當成現在的總數，兩條總數比對一起紅。",
  },
  {
    name: 'D2：遮罩多露出金鑰中間五個字',
    why: '以前那條只驗兩段手挑的長切片：多露出一小段中間的字，遮罩仍然短於 20 字、兩段長切片也都不是它的子字串，照樣會過。',
    file: 'js/secrets.js',
    find: '  return `${KEY_PREFIX}…${tail}`;',
    replace: '  return `${KEY_PREFIX}…${key.slice(20, 25)}…${tail}`;',
    test: 'secret-leak-test',
    expect: '金鑰中段的任何一截都沒有出現在遮罩裡',
  },
  {
    name: 'D2：跨年那一段讀畫面讀到空字串',
    why: '「畫面上沒有生出假的當日損益數字」的母體是單一字串；讀畫面讀錯地方、拿到空字串時那條恆真。前置要先紅。'
      + '（改 App 讓首頁空白行不通：freshApp 開機就在等 #view .card，會在更前面崩掉、紅錯地方 —— 所以改的是測試讀畫面的那一行。）',
    file: 'scripts/pathtest.mjs',
    find: "        settled: r.settled ?? [],\n        homeText: document.querySelector('#view').textContent.replace(/\\s+/g, ' '),",
    replace: "        settled: r.settled ?? [],\n        homeText: document.querySelector('#view .no-such-card')?.textContent ?? '',",
    test: 'pathtest',
    expect: '（前提）首頁真的畫出來了：有當日損益那張卡',
  },
  // ---- v0.7.23 驗收時統籌者列的測試缺口（2026-09-23 併進 SPEC_測試可信度 這一輪） ----
  {
    name: '缺口 1（A7）：凍結檔整檔加一行過期註解',
    why: '凍結區連過期註解也不改。以前每一版靠人工 git diff 代驗，現在 doctest 每次都比快照。',
    file: 'js/money.js',
    find: '// 金額運算。**全部用 BigInt 微元（1 微元 = 0.000001 元）做整數運算。**',
    replace: '// （過期註解）\n// 金額運算。**全部用 BigInt 微元（1 微元 = 0.000001 元）做整數運算。**',
    test: 'doctest',
    expect: '凍結區裡沒有任何一個檔案或函式被改過',
  },
  {
    name: '缺口 1（A7）：凍結函式裡加一行註解',
    why: '函式層級的凍結（§0 逐函式列的那些）一樣要抓得到，而且只抓那個函式。',
    file: 'js/plans.js',
    find: '  const amt = toMicro(amount);',
    replace: '  const amt = toMicro(amount); // 改一行註解也算動到',
    test: 'doctest',
    expect: '凍結區裡沒有任何一個檔案或函式被改過',
  },
  {
    name: '缺口 1（A5）：未實現損益那格印成成本',
    why: 'v0.7.23 只該改標示與說明，數字一個字都不能動。以前「數字沒變」沒有斷言，只靠人看。',
    file: 'js/views/home.js',
    find: "    h('p', { class: 'mid-number' }, moneyNode(u.unrealizedMicro)),",
    replace: "    h('p', { class: 'mid-number' }, moneyNode(u.costMicro)),",
    test: 'uikittest',
    expect: '未實現損益印的是手算的 1,519,500',
  },
  {
    name: '缺口 2（A1）：成本說明還原成 v0.7.22 的舊文字',
    why: '規格 A1 要的突變。舊文字講了「沒有加手續費」，但沒講「各家算法不一樣」「沒辦法一模一樣」「約略值」—— 語意斷言要分得出來。',
    file: 'js/views/home.js',
    find: "      '這裡的成本是你填的平均成本乘上股數，沒有算進手續費。'\n"
      + "      + '各家券商手續費的算法、折扣和優惠都不一樣，券商 App 的成本通常會比這裡高一點、報酬率低一點，'\n"
      + "      + '這裡沒辦法算得跟券商 App 一模一樣，差一點是正常的。'\n"
      + "      + '損益和報酬率是用這個成本算的，請當成約略值。'),",
    replace: "      '這裡的成本是你填的成交價乘上股數，沒有加手續費。'\n"
      + "      + '券商 App 的成本通常把買進手續費算進去，所以會比這裡高一點點，報酬率也會低一點點。'),",
    test: 'uikittest',
    expect: '講出「各家券商的算法不一樣」',
    alsoRed: ["講出「沒辦法一模一樣，差一點是正常的」","而且點名損益與報酬率是約略值"],
    alsoRedWhy: "舊文字少了這兩句，對應的兩條斷言一起紅。",
  },
  {
    name: '缺口 2（A1）：說明拿掉「沒有算進手續費」',
    why: '舊文字也講了沒加手續費，所以還原舊文字證明不了這一條；要單獨拿掉它。',
    file: 'js/views/home.js',
    find: '沒有算進手續費。',
    replace: '。',
    test: 'uikittest',
    expect: '講出「成本沒有算進手續費」',
  },
  {
    name: '缺口 2（A1）：說明拿掉「沒辦法一模一樣，差一點是正常的」',
    why: '這一句是「為什麼會差」之後的「所以不用擔心」。拿掉它，使用者看到差額還是會以為 App 算錯。',
    file: 'js/views/home.js',
    find: '這裡沒辦法算得跟券商 App 一模一樣，差一點是正常的。',
    replace: '',
    test: 'uikittest',
    expect: '講出「沒辦法一模一樣，差一點是正常的」',
  },
  {
    name: '缺口 3：禁用詞判準壞掉、什麼都不抓',
    why: '以前的對照是「把禁用詞嵌進字串再問含不含」，永遠成立 —— 判準壞掉（例如清單是空的）它也照樣過。',
    file: 'scripts/banned.mjs',
    find: "export const bannedIn = (text) => BANNED.filter((w) => String(text ?? '').includes(w));",
    replace: 'export const bannedIn = () => [];',
    test: 'uikittest',
    expect: '（對照）同一個判準抓得到含禁用詞的句子',
  },
  {
    name: '缺口 3：又有測試另抄一份禁用詞清單',
    why: '三處各抄一份時，只改其中一份，另外兩處就悄悄少擋一個詞。',
    file: 'scripts/calcviewtest.mjs',
    find: "import { BANNED } from './banned.mjs';",
    replace: "const BANNED = ['預期', '保守', '樂觀', '建議', '歷史平均', '常見', '推薦', '目標價', '應該買', '值得'];",
    test: 'doctest',
    expect: '禁用詞清單只有一份',
  },
  // ---- tap.mjs：每一支測試都靠的那道防線（2026-09-24 盤點：拿掉「母體非空」，30 支沒有一支紅；突變清單一條都沒有）----
  {
    name: 'tap：noneOf 不再擋空母體',
    why: '母體是空的 noneOf 永遠會過——它沒有檢查到任何東西。每一支測試都靠這一道，拿掉它時全部照樣綠。',
    file: 'scripts/tap.mjs',
    find: '  if (arr.length === 0) {\n    fail += 1;\n    console.log(`  ✗ ${msg}\\n      母體是空的 —— 這條斷言沒有檢查到任何東西`);\n    return false;\n  }\n  const hits',
    replace: '  const hits',
    test: 'taptest',
    expect: '空母體的 noneOf 必須紅',
  },
  {
    name: 'tap：everyOf 不再擋空母體',
    why: '母體是空的 everyOf 永遠會過（「每一個都符合」對零個東西恆真）。',
    file: 'scripts/tap.mjs',
    find: '  if (arr.length === 0) {\n    fail += 1;\n    console.log(`  ✗ ${msg}\\n      母體是空的 —— 這條斷言沒有檢查到任何東西`);\n    return false;\n  }\n  const bad',
    replace: '  const bad',
    test: 'taptest',
    expect: '空母體的 everyOf 必須紅',
  },
  {
    name: 'tap：detects 不再要求一定要有反例',
    why: '只給正例的話，一個「永遠回 true」的檢查器也會全過——對照組就失去意義。',
    file: 'scripts/tap.mjs',
    find: 'const good = shouldHit.length > 0 && shouldMiss.length > 0 && missed.length === 0',
    replace: 'const good = shouldHit.length > 0 && missed.length === 0',
    test: 'taptest',
    expect: '沒有反例的 detects 必須紅',
  },
  // ---- S3：assertaudit 的判斷邏輯（auditjudge.mjs）——以前篩選條件改壞，報告照樣回 0 ----
  {
    name: 'S3：「母體 ≤ 2」的篩選挑不到任何東西',
    why: 'v9 盤點實測過的那一種：篩選改壞之後，報告只寫「（沒有）」、回傳 0，看起來像沒有可疑的斷言。',
    file: 'scripts/auditjudge.mjs',
    find: "r.kind) && r.n != null && r.n <= 2);",
    replace: "r.kind) && r.n != null && r.n <= -1);",
    test: 'controltest',
    expect: 'assertaudit 對照二：',
  },
  {
    name: 'S3：「母體 ≤ 2」的篩選什麼都挑',
    why: '反方向壞掉：每一條都被列成可疑，真正可疑的淹沒在裡面。只驗「挑得到」會放過這種。',
    file: 'scripts/auditjudge.mjs',
    find: "r.kind) && r.n != null && r.n <= 2);",
    replace: "r.kind) && r.n != null && r.n >= 0);",
    test: 'controltest',
    expect: 'assertaudit 對照四（必過）：',
  },
  {
    name: 'S3：崩掉的測試不再判成「沒收到任何資料」',
    why: '這就是 S1 修掉的那個洞：崩掉那支的斷言憑空從報告消失，卻被當成只是「紅了」。',
    file: 'scripts/auditjudge.mjs',
    find: "  if (rows.length === 0) return 'no-data';\n",
    replace: '',
    test: 'controltest',
    expect: 'assertaudit 對照三：',
  },
  {
    name: 'S3：紅了的測試被判成通過',
    why: '訊息說反了的另一種：一支紅的測試在報告裡顯示成 ✓。',
    file: 'scripts/auditjudge.mjs',
    find: "  return passed ? 'ok' : 'red-with-data';",
    replace: "  return 'ok';",
    test: 'controltest',
    expect: 'assertaudit 對照一：',
  },
  // ---- S5：兩份登記清單的孤兒檢查（assertaudit 的清單、gatescan 的 FILES）----
  {
    name: 'S5：assertaudit 的清單漏了 gatescan',
    why: 'v9 盤點實測過的那一種：新接進 npm test 鏈的檢查沒補進清單，它的斷言從來不會被假斷言健檢掃到。',
    file: 'scripts/auditjudge.mjs',
    find: "  'taptest', 'controltest', 'gatescan',\n",
    replace: "  'taptest', 'controltest',\n",
    test: 'controltest',
    expect: 'assertaudit 孤兒：',
  },
  {
    name: 'S5：孤兒檢查不報鏈上沒登記的',
    why: '孤兒檢查自己壞掉：上面那一種又會默默發生。',
    file: 'scripts/auditjudge.mjs',
    find: '    missing: chain.filter((t) => !tests.includes(t) && !(t in skip)),',
    replace: '    missing: [],',
    test: 'controltest',
    expect: 'assertaudit 對照五：',
  },
  {
    name: 'S5：孤兒檢查不報清單裡過期的',
    why: '測試改名或拿掉之後，清單還寫著舊名字，assertaudit 會對著不存在的檔跑。',
    file: 'scripts/auditjudge.mjs',
    find: '    stale: tests.filter((t) => !chain.includes(t)),',
    replace: '    stale: [],',
    test: 'controltest',
    expect: 'assertaudit 對照六：',
  },
  {
    name: 'S5：孤兒檢查不報過期的不收理由',
    why: '例外不能默默留著：不收的理由指著一支已經不在鏈上的測試。',
    file: 'scripts/auditjudge.mjs',
    find: '    skipStale: Object.keys(skip).filter((t) => !chain.includes(t)),',
    replace: '    skipStale: [],',
    test: 'controltest',
    expect: 'assertaudit 對照七：',
  },
  {
    name: 'S5：取鏈上名稱時漏掉帶連字號的',
    why: 'secret-leak-test 這種名字取不到，孤兒檢查的母體就少了它。',
    file: 'scripts/auditjudge.mjs',
    find: '/node scripts\\/([\\w-]+)\\.mjs/g',
    replace: '/node scripts\\/(\\w+)\\.mjs/g',
    test: 'controltest',
    expect: 'assertaudit 對照八（必過）：',
    alsoRed: ["assertaudit 對照六：","assertaudit 過期："],
    alsoRedWhy: "secret-leak-test 取不到：對照組的合成鏈少一支（對照六），真實的清單也對不上（過期）——同一個錯在三處都看得到。",
  },
  {
    name: 'S5：gatescan 不看腳本內容，只看檔名',
    why: 'v9 盤點實測過的那一種：一支叫 ship.sh、帶 | tail -1 的推送腳本沒登記，gatescan 回 0。',
    file: 'scripts/gatescan.mjs',
    find: "  || text.split('\\n').some((l) => !isComment(l) && (/\\bgit\\b[^\\n|;&]*\\bpush\\b/.test(l) || /precheck|piiscan|gatepush/i.test(l)));",
    replace: '  || false;',
    test: 'gatescan',
    expect: 'gatescan 孤兒對照一：',
    alsoRed: ["gatescan 理由過期："],
    alsoRedWhy: "gatescan.mjs 自己只靠內容被認出；不看內容，它那條「不收的理由」就變成過期。",
  },
  {
    name: 'S5：gatescan 不看檔名',
    why: '檔名一看就是推送腳本、內容是用變數或別的寫法呼叫的，就漏掉。',
    file: 'scripts/gatescan.mjs',
    find: "const looksLikeGate = (rel, text) => /gate|precheck|piiscan|push/i.test(path.basename(rel))",
    replace: 'const looksLikeGate = (rel, text) => false',
    test: 'gatescan',
    expect: 'gatescan 孤兒對照二：',
  },
  {
    name: 'S5：gatescan 走訪時沒跳過 node_modules',
    why: '反方向壞掉：套件裡帶 push 字樣的檔全被當成沒登記的閘門，孤兒檢查天天紅、紅到沒人看。',
    file: 'scripts/gatescan.mjs',
    find: "const WALK_SKIP = new Set(['node_modules', '.git', '.logs', '.private']);",
    replace: "const WALK_SKIP = new Set(['.git', '.logs', '.private']);",
    test: 'gatescan',
    expect: 'gatescan 孤兒對照三（必過）：',
    alsoRed: ["gatescan 孤兒：repo 裡看起來是推送"],
    alsoRedWhy: "本機 repo 的 node_modules 裡真的有檔名帶 push 的檔，真實的孤兒檢查也一起紅（node_modules 是 junction 的複本裡不會被走訪，那裡不紅）。",
  },
  {
    name: 'S5：gatescan 不報過期的不收理由',
    why: '例外不能默默留著：ORPHAN_SKIP 指著一支已經不在、或不再像閘門的腳本。',
    file: 'scripts/gatescan.mjs',
    find: '    skipStale: Object.keys(skip).filter((rel) => !cand.includes(rel)),',
    replace: '    skipStale: [],',
    test: 'gatescan',
    expect: 'gatescan 孤兒對照四：',
  },
  // ---- RS：擋下的理由只在錯誤訊息的位置比對（補充說明（四）第 1 點）——以前在整份輸出裡找一句話 ----
  {
    name: 'RS：tap 的理由擷取看整份輸出',
    why: '修正前的寫法：理由的字眼只要出現在輸出的任何地方（斷言名稱、別的行）就算數。',
    file: 'scripts/taptest.mjs',
    find: "  return got.join('\\n');",
    replace: '  return String(out);',
    test: 'taptest',
    expect: '（對照）取紅的理由',
  },
  {
    name: 'RS：閘門比對命中時不看是哪一類的標頭',
    why: '修正前的效果：token 被別的類別抓到、命中行原樣印出來，照樣判成「是 (a) 類擋的」。',
    file: 'scripts/gatereason.mjs',
    find: '      if (!lines[i].startsWith(`${cat}：`) || !m || Number(m[1]) < 1) continue;',
    replace: '      if (!m || Number(m[1]) < 1) continue;',
    test: 'controltest',
    expect: '閘門理由比對：',
  },
  {
    name: 'RS：閘門比對行首改成行中間也算',
    why: '判決行的字眼出現在說明文字裡也算數——「出現過」不等於「是判決」。',
    file: 'scripts/gatereason.mjs',
    find: "    return lines.some((l) => l.startsWith(p) && !(idTail && /[\\w.-]/.test(l[p.length] ?? '')));",
    replace: "    return lines.some((l) => l.includes(p) && !(idTail && /[\\w.-]/.test(l[p.length] ?? '')));",
    test: 'controltest',
    expect: '閘門理由比對：',
  },
  {
    name: 'RS：閘門比對的檔名不對邊界',
    why: 'scripts/gatepush.sh 被 scripts/gatepush.sh.orig 湊到——擋下的其實是別的檔，驗法卻判成對的那一支。',
    file: 'scripts/gatereason.mjs',
    find: "    return lines.some((l) => l.startsWith(p) && !(idTail && /[\\w.-]/.test(l[p.length] ?? '')));",
    replace: '    return lines.some((l) => l.startsWith(p));',
    test: 'controltest',
    expect: '閘門理由比對：',
  },
  {
    name: 'RS：狀況字眼不對邊界',
    why: '「0 筆」被「10 筆」湊到——理由其實講的是別的數字，也算成點名了這個狀況。',
    file: 'scripts/buildtest.mjs',
    find: "    if (!(/^\\d/.test(k) && /\\d/.test(x[i - 1] ?? ''))) return true;",
    replace: '    return true;',
    test: 'buildtest',
    expect: '（對照）狀況字眼對邊界',
  },
  // ---- 判定：判定要「只紅對應的那一種」（2026-09-24，統籌者驗收指出 mutjudge 只要有一條對上就判 red）----
  {
    name: '判定：多紅了別組也判紅',
    why: '修正前的寫法：只要有一條對上 expect 就算紅對，別組一起紅也看不出來。',
    file: 'scripts/mutjudge.mjs',
    find: "  return { verdict: extra.length ? 'extra-red' : 'red', failed, extra };",
    replace: "  return { verdict: 'red', failed, extra };",
    test: 'checkmutations',
    expect: '只紅對應：紅在對的那一條、別組也一起紅',
    alsoRed: ["只紅對應：alsoRed 列的是別的標籤","條突變都還有效（find 剛好一次"],
    alsoRedWhy: "判定一律回 red，「alsoRed 列錯標籤要判多紅」那組對照也紅；checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: '判定：alsoRed 被忽略',
    why: '明列過的連帶紅也被當成多紅，本來就該整類紅的突變（整道關卡失效）永遠過不了。',
    file: 'scripts/mutjudge.mjs',
    find: '  const extra = failed.filter((f) => !f.includes(expect) && !alsoRed.some((a) => f.includes(a)));',
    replace: '  const extra = failed.filter((f) => !f.includes(expect));',
    test: 'checkmutations',
    expect: '只紅對應（必過）：',
    alsoRed: ["條突變都還有效（find 剛好一次"],
    alsoRedWhy: "checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: '判定：alsoRed 打錯字也放行',
    why: '打錯字的 alsoRed 永遠對不到任何一條，等於沒宣告；要等跑那條突變才看得出來。',
    file: 'scripts/mutjudge.mjs',
    find: '        else if (!testSrc.includes(a)) probs.push(',
    replace: '        else if (false) probs.push(',
    test: 'checkmutations',
    expect: 'alsoRed：有一條在測試原始碼裡找不到',
    alsoRed: ["條突變都還有效（find 剛好一次"],
    alsoRedWhy: "checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。",
  },
  {
    name: '判定：alsoRed 不寫理由也放行',
    why: '沒有理由的 alsoRed 等於把「只紅對應」關掉——看不出那幾組是真的連帶，還是被順手寫進去掩蓋問題。',
    file: 'scripts/mutjudge.mjs',
    find: "    if (typeof mut.alsoRedWhy !== 'string' || mut.alsoRedWhy.trim().length < 6) probs.push(",
    replace: '    if (false) probs.push(',
    test: 'checkmutations',
    expect: 'alsoRed：有連帶紅卻沒寫理由',
    alsoRed: ['條突變都還有效（find 剛好一次'],
    alsoRedWhy: 'checkmutations 會讀到被改壞的那支檔，把這條突變本身判成過期（find 對不到）——凡是指向 checkmutations 的突變都會這樣，是機制上必然的連帶。',
  },
  // ---- GV：推送閘門的驗法本身（gatetest.sh）——統籌者驗收 S7 指出：沒有「驗法沒全過要刪掉登記」的情境 ----
  // 由 scripts/gateselftest.mjs 驗（它用工作區的閘門檔，這裡改壞工作區的 gatetest.sh 它就看得到）。約 7 分鐘一條。
  {
    name: 'GV：驗法一開跑不刪舊登記',
    why: '驗法沒全過時，上一次的登記還留著，閘門第零關照樣放行——改過的閘門不必重跑驗法就推得出去。',
    file: 'scripts/gatetest.sh',
    find: 'rm -f "$REG_ROOT"   # 這一次沒全過，就不能留著上一次的登記',
    replace: ':   # 突變：不刪上一次的登記',
    test: 'gateselftest',
    expect: '驗法沒全過，先放的舊登記要被刪掉',
  },
  {
    name: 'GV：驗法沒全過也寫登記',
    why: '驗法有情境不符，卻照樣登記雜湊：第零關就等於沒有。',
    file: 'scripts/gatetest.sh',
    find: 'if [ "$BAD" -eq 0 ] && [ "$OK" -eq "$#" ]; then',
    replace: 'if true; then',
    test: 'gateselftest',
    expect: '驗法沒全過，先放的舊登記要被刪掉',
    alsoRed: ['gatetest.sh 的回傳值'],
    alsoRedWhy: '寫了登記的那一段最後 exit 0，所以驗法沒全過時回傳值也變成 0。',
  },
  // ---- WF：寫檔那一步出事（補充說明（四）第 5 點）——清理也要能失敗、不能中斷，只清自己寫出的 ----
  {
    name: 'WF：換不上去時不清暫存檔',
    why: '修正前的行為：換不上去就把錯丟出去，自己寫出的暫存檔留在輸出目錄裡。',
    file: 'scripts/buildguard.mjs',
    find: '  if (wrote) {\n    try {\n      fs.rmSync(tmp, { force: true });\n      problems.push(`${unit}：已清掉這次寫出的暫存檔 ${path.basename(tmp)}`);',
    replace: '  if (false) {\n    try {\n      fs.rmSync(tmp, { force: true });\n      problems.push(`${unit}：已清掉這次寫出的暫存檔 ${path.basename(tmp)}`);',
    test: 'buildtest',
    expect: '（清掉了自己寫出的暫存檔，而且講出來）',
    alsoRed: ['寫檔失敗：輸出檔換不上去', '寫檔失敗：清理也失敗'],
    alsoRedWhy: '不清就留下暫存檔（輸出目錄變了），「換不上去」那三格一起紅；「清理也失敗」那三格要的「清理也失敗」訊息也不會出現。',
  },
  {
    name: 'WF：清理失敗時中斷',
    why: 'JLPT 撞到的那一種：清理丟例外就整個中斷，吐出堆疊而不是設計好的訊息。',
    file: 'scripts/buildguard.mjs',
    find: '    } catch (e) {\n      problems.push(`${unit}：清理也失敗',
    replace: '    } catch (e) {\n      throw e;\n      problems.push(`${unit}：清理也失敗',
    test: 'buildtest',
    expect: '寫檔失敗：清理也失敗',
  },
  {
    name: 'WF：暫存檔的位置被佔住時連別人的東西一起刪',
    why: 'JLPT 撞到的那一種：連寫失敗的那個路徑也去刪——那個位置原本的東西不是這支程式寫的。',
    file: 'scripts/buildguard.mjs',
    find: '  if (wrote) {\n    try {\n      fs.rmSync(tmp, { force: true });',
    replace: '  if (true) {\n    try {\n      fs.rmSync(tmp, { force: true, recursive: true });',
    test: 'buildtest',
    expect: '（佔位的資料夾與裡面的檔都還在）',
    alsoRed: ['寫檔失敗：暫存檔的位置被資料夾佔住'],
    alsoRedWhy: '佔位的資料夾被刪掉，輸出目錄變了，那三格一起紅。',
  },
  {
    name: 'WF：設計好的停下也印堆疊',
    why: '停下的理由被淹在堆疊裡；也分不出是設計好的停下還是沒料到的錯。',
    file: 'scripts/buildguard.mjs',
    find: "e instanceof BuildStop ? `✗ ${e.message}\\n` :",
    replace: "false ? `✗ ${e.message}\\n` :",
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × empty',
    alsoRed: ['build-calendar ', 'build-dividends ', 'build-stocks '],
    alsoRedWhy: '三支的每一種停下都走這一行，整張矩陣一起紅。',
  },
  // ---- ES：跳脫掃描（escscan.mjs；補充說明（四）第 4 點）——母體擴到 repo 裡所有腳本 ----
  {
    name: 'ES：多跳脫的 regex 抓不到',
    why: '語法正確、只是 regex 被多跳脫一次——永遠不命中、不報錯，檢查默默空轉；只有這道掃描抓得到。',
    file: 'scripts/escscan.mjs',
    find: "    if (body[i + 1] === '\\\\' && /[sdwbSDWB]/.test(body[i + 2] ?? '')) return true;",
    replace: '    if (false) return true;',
    test: 'escscan',
    expect: '（對照）E1 多跳脫',
  },
  {
    name: 'ES：少跳脫的字串抓不到',
    why: "'\\s' 在 JS 裡就是 's'，拿去組 regex 就少了反斜線。",
    file: 'scripts/escscan.mjs',
    find: "    if (/[sdwSDW]/.test(body[i + 1] ?? '')) return true;",
    replace: '    if (false) return true;',
    test: 'escscan',
    expect: '（對照）E2 少跳脫',
  },
  {
    name: 'ES：regex 擷取漏掉左括號後面的位置',
    why: '.replace(/…/)、.test(/…/) 這些位置的 regex 抽不出來，母體少一大半（MealMate 盤點實測過同一種：只抽 .test( 的，其他用法全漏）。',
    file: 'scripts/escscan.mjs',
    find: "const REGEX_BEFORE = new Set([...'=(,:!&|?{};[>~+-*%<^'].concat(['']));",
    replace: "const REGEX_BEFORE = new Set([...'=,:!&|?{};[>~+-*%<^'].concat(['']));",
    test: 'escscan',
    expect: '（對照）regex 字面：',
    alsoRed: ['跳脫：repo 裡所有腳本都沒有多跳脫或少跳脫的樣式'],
    alsoRedWhy: '擷取一走偏，後面的字串與 regex 邊界跟著錯位，真實檔案上多出假命中——切割錯了，掃描結果就不可信，一起紅是對的。',
  },
  {
    name: 'ES：走訪漏掉 scripts 整個目錄',
    why: '母體漏掉一個目錄，裡面的樣式寫錯也不會被掃到；只有跟 git 追蹤清單核對才看得出來。',
    file: 'scripts/escscan.mjs',
    find: "const WALK_SKIP = new Set(['node_modules', '.git', '.logs', '.private']);",
    replace: "const WALK_SKIP = new Set(['node_modules', '.git', '.logs', '.private', 'scripts']);",
    test: 'escscan',
    expect: '跳脫掃描孤兒：',
    alsoRed: ['（前提）全 repo 抽到', '跳脫例外過期：'],
    alsoRedWhy: 'scripts 整個不掃：抽到的 regex 與字串數量掉到前提以下，gatetest.sh 那兩條例外也對不到命中。',
  },
  // ---- BG：三支 build 的寫檔前關卡（buildguard.mjs；F8）——以前資料變少照樣寫檔、會寫出「0 檔」的 dividends.json ----
  // expect 對到矩陣裡逐字寫出的那一格；本來就會連帶紅的格子用 alsoRed 明列，理由寫在 why。
  {
    name: 'BG：關卡永遠放行',
    why: '整道關卡失效：每一個單位、每一種情境都照樣寫檔——整張矩陣都該紅，所以三支的格子都明列在 alsoRed。',
    file: 'scripts/buildguard.mjs',
    find: '      if (problems.length) {',
    replace: '      if (false) {',
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × empty',
    alsoRed: ['build-calendar ', 'build-dividends ', 'build-stocks '],
    alsoRedWhy: "整道關卡失效，每一個單位、每一種情境都照樣寫檔——整張矩陣都該紅。",
  },
  {
    name: 'BG：「少一半以上」永遠不成立',
    why: 'S8 實測的那一種：27 筆只給 1 筆、40 檔只剩 2 檔，照樣寫檔。三支的「變少」都靠這一段，所以五格一起紅。',
    file: 'scripts/buildguard.mjs',
    find: '  if (now * 2 < before) return',
    replace: '  if (false) return',
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × shrink',
    alsoRed: ['build-calendar 新的一年變少：', 'build-dividends 矩陣：t187ap45_L × shrink', 'build-stocks 矩陣：上市 × shrink', 'build-stocks 矩陣：上櫃 × shrink', 'build-stocks 矩陣：興櫃 × shrink'],
    alsoRedWhy: "三支的「變少」都靠這一段，五格一起紅。",
  },
  {
    name: 'BG：上一次的輸出壞掉被當成第一次產',
    why: '壞掉的輸出檔讀不出筆數，「少一半」就比不了，等於沒有這道檢查。三支都讀它，所以三格一起紅。',
    file: 'scripts/buildguard.mjs',
    find: "  return JSON.parse(fs.readFileSync(file, 'utf8'));",
    replace: "  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }",
    test: 'buildtest',
    expect: 'build-calendar 上一次的輸出壞掉：',
    alsoRed: ['build-dividends 上一次的輸出壞掉：', 'build-stocks 上一次的輸出壞掉：'],
    alsoRedWhy: "三支都用 readPrevious 讀上一次的輸出，三格一起紅。",
  },
  {
    name: 'BG：日曆不檢查 0 筆',
    why: '空的公告只會被「沒有這一年」碰巧擋下，講不出真正的原因（S8 實測）——依 F8 算沒擋。',
    file: 'scripts/build-calendar.mjs',
    find: '  else if (list.length === 0) g.add(`${U}：來源 0 筆`);\n',
    replace: '',
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × empty',
  },
  {
    name: 'BG：日曆取不到時直接拋錯',
    why: '修正前的寫法：讀檔失敗就丟 ENOENT，理由沒有點名單位。',
    file: 'scripts/build-calendar.mjs',
    find: "    try { text = fs.readFileSync(fromArg, 'utf8'); } catch (e) { g.add(`${U}：取不到（${e.code ?? e.message}：${fromArg}）`); }",
    replace: "    text = fs.readFileSync(fromArg, 'utf8');",
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × missing',
  },
  {
    name: 'BG：日曆解析不了時直接拋錯',
    why: '修正前的寫法：JSON 壞掉就丟 SyntaxError，理由沒有點名單位。',
    file: 'scripts/build-calendar.mjs',
    find: '    try { list = JSON.parse(text); } catch (e) { g.add(`${U}：解析不了（${e.message}）`); }',
    replace: '    list = JSON.parse(text);',
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × unparsable',
  },
  {
    name: 'BG：日曆不檢查欄位',
    why: 'Date 改名時只剩「日期解析不出來」與「沒有這一年」，講不出是欄位變了。',
    file: 'scripts/build-calendar.mjs',
    find: '    if (missing.length) {',
    replace: '    if (false) {',
    test: 'buildtest',
    expect: 'build-calendar 矩陣：holidaySchedule × renamed',
  },
  {
    name: 'BG：日曆不檢查這一年有沒有公告',
    why: '還沒公布的年份會產出一份「整年都開市」的假日曆。',
    file: 'scripts/build-calendar.mjs',
    find: '    g.add(`${U}：${yearArg} 年沒有這一年的休市日',
    replace: '    void (`${U}：${yearArg} 年沒有這一年的休市日',
    test: 'buildtest',
    expect: 'build-calendar 沒有這一年：',
  },
  {
    name: 'BG：日曆新的一年不拿最近一年來比',
    why: '新的一年沒有同年的舊資料，就完全不比：2027 只公告 1 天也照樣寫檔。',
    file: 'scripts/build-calendar.mjs',
    find: ': Object.keys(prevYears).sort().pop();',
    replace: ': null;',
    test: 'buildtest',
    expect: 'build-calendar 新的一年變少：',
  },
  {
    name: 'BG：日曆上一次的輸出壞掉時當成第一次產',
    why: '把 readPrevious 的錯誤吞掉：舊日曆壞了，這一年的「變少」就比不了。',
    file: 'scripts/build-calendar.mjs',
    find: '  try { existing = readPrevious(dest) ?? {}; } catch (e) { g.add(',
    replace: '  try { existing = readPrevious(dest) ?? {}; } catch (e) { void (',
    test: 'buildtest',
    expect: 'build-calendar 上一次的輸出壞掉：',
  },
  {
    name: 'BG：股利不看 HTTP 狀態',
    why: '來源回 500 時，錯誤頁的內容照樣被當成資料解析、寫檔。（原本寫的「直接拋錯」是等價突變：外層的 try 接得住、照樣記成取不到，§5.12。）',
    file: 'scripts/build-dividends.mjs',
    find: '    if (!res.ok) g.add(`${U}：取不到（HTTP ${res.status}）`);',
    replace: '    if (false) g.add(`${U}：取不到（HTTP ${res.status}）`);',
    test: 'buildtest',
    expect: 'build-dividends 矩陣：t187ap45_L × missing',
  },
  {
    name: 'BG：股利解析不了時直接拋錯',
    why: '修正前的寫法：回應不是 JSON 就丟 SyntaxError，理由沒有點名單位。',
    file: 'scripts/build-dividends.mjs',
    find: '      try { rows = JSON.parse(text); } catch (e) { g.add(`${U}：解析不了（${e.message}）`); }',
    replace: '      rows = JSON.parse(text);',
    test: 'buildtest',
    expect: 'build-dividends 矩陣：t187ap45_L × unparsable',
  },
  {
    name: 'BG：股利不檢查 0 筆',
    why: '空的來源只會被「少一半」碰巧擋下，講不出是來源 0 筆——依 F8 算沒擋。',
    file: 'scripts/build-dividends.mjs',
    find: '  else if (rows.length === 0) g.add(`${U}：來源 0 筆`);',
    replace: '  else if (false) g.add(`${U}：來源 0 筆`);',
    test: 'buildtest',
    expect: 'build-dividends 矩陣：t187ap45_L × empty',
  },
  {
    name: 'BG：股利只看第一筆的欄位',
    why: '修正前的寫法：後面幾筆欄位變了照樣硬解，年度欄變成空字串。',
    file: 'scripts/build-dividends.mjs',
    find: '    const miss = list.filter((r) => !r || typeof r !== \'object\' || !(k in r)).length;',
    replace: '    const miss = list.slice(0, 1).filter((r) => !r || typeof r !== \'object\' || !(k in r)).length;',
    test: 'buildtest',
    expect: 'build-dividends 欄位對不上：只有後面',
  },
  {
    name: 'BG：股利不檢查收進來 0 檔',
    why: 'S8 實測的那一種：寫出「0 檔、0 筆」的 dividends.json。這裡有「少一半」補位，但講不出是收進來 0 檔。',
    file: 'scripts/build-dividends.mjs',
    find: '  if (list.length > 0 && byCode.size === 0) g.add(',
    replace: '  if (false) g.add(',
    test: 'buildtest',
    expect: 'build-dividends 收進來 0 檔：',
  },
  {
    name: 'BG：股利上一次的輸出壞掉時當成第一次產',
    why: '把 readPrevious 的錯誤吞掉：舊的 dividends.json 壞了，「變少」就比不了。',
    file: 'scripts/build-dividends.mjs',
    find: '  try { prev = readPrevious(OUT); } catch (e) { g.add(',
    replace: '  try { prev = readPrevious(OUT); } catch (e) { void (',
    test: 'buildtest',
    expect: 'build-dividends 上一次的輸出壞掉：',
  },
  {
    name: 'BG：代號表來源 0 筆不擋',
    why: 'S8 實測的那一種：上櫃公司基本資料是空的照樣寫檔。兩份 JSON 來源共用這一行，所以兩格一起紅。',
    file: 'scripts/build-stocks.mjs',
    find: "    if (rows.length === 0) { g.add(`${name}：來源 0 筆`); return []; }\n",
    replace: '',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：twseCompanies × empty',
    alsoRed: ['build-stocks 矩陣：tpexCompanies × empty'],
    alsoRedWhy: "兩份 JSON 來源共用這一行。",
  },
  {
    name: 'BG：代號表 JSON 來源解析不了時直接拋錯',
    why: '修正前的寫法：來源不是 JSON 就丟 SyntaxError，講不出是哪一份。兩份 JSON 來源共用這一行。',
    file: 'scripts/build-stocks.mjs',
    find: '    try { rows = JSON.parse(raw[name]); } catch (e) { g.add(`${name}：解析不了（${e.message}）`); return []; }',
    replace: '    rows = JSON.parse(raw[name]);',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：twseCompanies × unparsable',
    alsoRed: ['build-stocks 矩陣：tpexCompanies × unparsable'],
    alsoRedWhy: "兩份 JSON 來源共用這一行。",
  },
  {
    name: 'BG：代號表取不到時不點名來源',
    why: '取不到就直接崩，講不出是六份裡的哪一份。六份共用這一段，所以六格一起紅。',
    file: 'scripts/build-stocks.mjs',
    find: '      g.add(`${name}：取不到（${e.message}）`);',
    replace: '      throw e;',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：twseCompanies × missing',
    alsoRed: ['build-stocks 矩陣：tpexCompanies × missing', 'build-stocks 矩陣：stockDayAll × missing', 'build-stocks 矩陣：isinListed × missing', 'build-stocks 矩陣：isinOtc × missing', 'build-stocks 矩陣：isinEmerging × missing'],
    alsoRedWhy: "六份來源共用這一段。",
  },
  {
    name: 'BG：ISIN 表 0 列不擋',
    why: 'ISIN 表空了、格式變了、根本不是表格，都只會表現成解析出 0 列；三份 ISIN 表共用這一行，所以九格一起紅。',
    file: 'scripts/build-stocks.mjs',
    find: '    if (rows.length === 0) g.add(`${name}：ISIN 表解析出 0 列',
    replace: '    if (false) g.add(`${name}：ISIN 表解析出 0 列',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：isinListed × empty',
    alsoRed: ['build-stocks 矩陣：isinListed × renamed', 'build-stocks 矩陣：isinListed × unparsable', 'build-stocks 矩陣：isinOtc × ', 'build-stocks 矩陣：isinEmerging × '],
    alsoRedWhy: "三份 ISIN 表的空的、格式變了、不是表格，都只表現成 0 列，共用這一行。",
  },
  {
    name: 'BG：代號表不檢查欄位',
    why: '公司代號欄改名時只會被「產業別太少」碰巧擋下（S8 實測）。兩份 JSON 來源共用這一段。',
    file: 'scripts/build-stocks.mjs',
    find: '      if (miss) g.add(`${name}：欄位對不上',
    replace: '      if (false) g.add(`${name}：欄位對不上',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：twseCompanies × renamed',
    alsoRed: ['build-stocks 矩陣：tpexCompanies × renamed'],
    alsoRedWhy: "兩份 JSON 來源共用這一段。",
  },
  {
    name: 'BG：STOCK_DAY_ALL 解析出 0 檔不擋',
    why: '有標題列、卻一檔都沒有（休市日或證交所改版），照樣往下算。',
    file: 'scripts/build-stocks.mjs',
    find: "    if (sda.rows.length === 0 && g.problems.every((p) => !p.startsWith('stockDayAll：'))) g.add(",
    replace: '    if (false) g.add(',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：stockDayAll × empty',
  },
  {
    name: 'BG：STOCK_DAY_ALL 解析不了時直接拋錯',
    why: '標題改名、根本不是 CSV，解析器都會拋錯；直接丟出去就講不出是哪一份。兩格共用這一行。',
    file: 'scripts/build-stocks.mjs',
    find: '    try { sda = parseStockDayAll(raw.stockDayAll); } catch (e) { g.add(`stockDayAll：解析不了（${e.message}）`); }',
    replace: '    sda = parseStockDayAll(raw.stockDayAll);',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：stockDayAll × renamed',
    alsoRed: ['build-stocks 矩陣：stockDayAll × unparsable'],
    alsoRedWhy: "標題改名與不是 CSV 都是解析器拋錯，共用這一行。",
  },
  {
    name: 'BG：代號表不跟上一次的各市場檔數比',
    why: '上櫃從上千檔掉到一檔，照樣寫檔。三個市場共用這一段，所以三格一起紅。',
    file: 'scripts/build-stocks.mjs',
    find: '  for (const m of Object.keys(prevCounts)) {',
    replace: '  for (const m of []) {',
    test: 'buildtest',
    expect: 'build-stocks 矩陣：上市 × shrink',
    alsoRed: ['build-stocks 矩陣：上櫃 × shrink', 'build-stocks 矩陣：興櫃 × shrink'],
    alsoRedWhy: "三個市場共用這一段。",
  },
  {
    name: 'BG：代號表上一次的輸出壞掉時當成第一次產',
    why: '把 readPrevious 的錯誤吞掉：舊的 stocks.json 壞了，各市場的「變少」就比不了。',
    file: 'scripts/build-stocks.mjs',
    find: '  try { prevCounts = readPrevious(dest)?.counts?.byMarket ?? {}; } catch (e) { g.add(',
    replace: '  try { prevCounts = readPrevious(dest)?.counts?.byMarket ?? {}; } catch (e) { void (',
    test: 'buildtest',
    expect: 'build-stocks 上一次的輸出壞掉：',
  },
  // ---- EP：livecheck 的端點登記（第 2 件）——以前 app 在用的 FMTQIK 從來沒被檢查過 ----
  {
    name: 'EP：app 在用的端點沒登記',
    why: '第 2 件的原樣：FMTQIK 不在登記裡，livecheck 不打它，也沒有東西報。',
    file: 'scripts/livejudge.mjs',
    find: "export const LIVE_ENDPOINTS = ['STOCK_DAY_ALL', 'STOCK_DAY', 'TWT48U', 'TWT49U', 'FMTQIK'];",
    replace: "export const LIVE_ENDPOINTS = ['STOCK_DAY_ALL', 'STOCK_DAY', 'TWT48U', 'TWT49U'];",
    test: 'controltest',
    expect: '端點孤兒：',
  },
  {
    name: 'EP：孤兒檢查不報沒登記的端點',
    why: '孤兒檢查自己壞掉，上面那一種又會默默發生。',
    file: 'scripts/livejudge.mjs',
    find: '    missing: appEndpoints.filter((e) => !registered.includes(e) && !(e in skip)),',
    replace: '    missing: [],',
    test: 'controltest',
    expect: 'livecheck 對照十三：',
  },
  {
    name: 'EP：孤兒檢查不報「登記了卻沒打」',
    why: '登記了、livecheck 卻從來沒打——就是這一輪修之前 FMTQIK 的狀態換個樣子。',
    file: 'scripts/livejudge.mjs',
    find: '    notChecked: registered.filter((e) => !checked.includes(e)),',
    replace: '    notChecked: [],',
    test: 'controltest',
    expect: 'livecheck 對照十三：',
  },
  {
    name: 'EP：取端點的樣式只認 exchangeReport',
    why: 'rwd/zh/afterTrading 底下的（STOCK_DAY_ALL、FMTQIK）全部擷取不到，母體少了一半。',
    file: 'scripts/livejudge.mjs',
    find: '/\\/(?:exchangeReport|rwd\\/zh\\/[\\w/]+?)\\/([A-Z0-9_]+)(?=[?\'"`\\s]|$)/g',
    replace: '/\\/(?:exchangeReport)\\/([A-Z0-9_]+)(?=[?\'"`\\s]|$)/g',
    test: 'controltest',
    expect: 'livecheck 對照十三：',
    alsoRed: ["（前提）app 端 ","端點沒打："],
    alsoRedWhy: "樣式抽不到 rwd 底下的端點：真實檢查的母體從 5 個掉到 3 個（前提），livecheck 打的 FMTQIK、STOCK_DAY_ALL 也抽不到（端點沒打）。",
  },
  {
    name: 'EP：FMTQIK 的格式錯誤被吞掉',
    why: '欄位改名時解析器拋錯，被 catch 成「沒問題」。',
    file: 'scripts/livejudge.mjs',
    find: '  try { parsed = parseFmtqik(json); } catch (e) { return [`格式變了：${e.message}`]; }',
    replace: '  try { parsed = parseFmtqik(json); } catch (e) { return []; }',
    test: 'controltest',
    expect: 'livecheck 對照十二：',
  },
  // ---- RT：逐頁清單的孤兒檢查（routes.mjs；第 3、4 件）——以前新註冊的路由不會被巡、不會被報 ----
  {
    name: 'RT：app.js 真的漏登記一條路由',
    why: '第 4 件的原樣：新註冊一條路由、沒加進逐頁清單，sweep 與 upgradecheck 都不會開它。',
    file: 'scripts/routes.mjs',
    find: "  ['/settings', '設定'],\n",
    replace: '',
    test: 'controltest',
    expect: '路由孤兒：',
  },
  {
    name: 'RT：孤兒檢查不報沒登記的路由',
    why: '孤兒檢查自己壞掉，上面那一種又會默默發生。',
    file: 'scripts/routes.mjs',
    find: '    missing: registered.filter((r) => !listed.includes(r) && !(r in skip)),',
    replace: '    missing: [],',
    test: 'controltest',
    expect: '路由對照二：',
  },
  {
    name: 'RT：孤兒檢查不報過期的路由',
    why: '路由拿掉了、清單還寫著，sweep 會對著不存在的頁等到逾時。',
    file: 'scripts/routes.mjs',
    find: '    stale: listed.filter((r) => !registered.includes(r)),',
    replace: '    stale: [],',
    test: 'controltest',
    expect: '路由對照三：',
  },
  {
    name: 'RT：孤兒檢查不報過期的不巡理由',
    why: '例外不能默默留著：不巡的理由指著一條已經不在的路由。',
    file: 'scripts/routes.mjs',
    find: '    skipStale: Object.keys(skip).filter((r) => !registered.includes(r)),',
    replace: '    skipStale: [],',
    test: 'controltest',
    expect: '路由對照四：',
  },
  {
    name: 'RT：註解裡的 route 也被當成註冊的',
    why: '取路由的樣式不認行首，註解掉的路由也被算進母體。',
    file: 'scripts/routes.mjs',
    find: "/^\\s*route\\('([^']+)'/gm",
    replace: "/route\\('([^']+)'/gm",
    test: 'controltest',
    expect: '路由對照一（必過）：',
    alsoRed: ["路由對照二："],
    alsoRedWhy: "對照組的合成 app.js 裡那條註解掉的 /commented 被當成註冊的，「多註冊一條沒登記的」那組就多報一條、對不上。",
  },
  // ---- LC：livecheck 崩在日曆段（第 1 件）——以前一崩，後面兩段從來沒跑到 ----
  {
    name: 'LC：段落崩了卻不記失敗',
    why: '崩掉的那一段被吞掉，整支看起來是綠的——比以前「崩了但回 1」更糟。',
    file: 'scripts/livejudge.mjs',
    find: '      fail(`livecheck 段落崩潰：${name}`,',
    replace: '      void (`livecheck 段落崩潰：${name}`,',
    test: 'controltest',
    expect: 'livecheck 對照十一：',
  },
  {
    name: 'LC：段落崩了就整支停',
    why: '修正前的行為：崩在日曆段，後面的代號表核對、節流檢查從來沒跑到。',
    file: 'scripts/livejudge.mjs',
    find: '    try { await fn(); } catch (e) {\n      crashed.push(name);',
    replace: '    try { await fn(); } catch (e) {\n      throw e;',
    test: 'controltest',
    expect: 'livecheck 對照十一：',
  },
  {
    name: 'LC：日曆休市日讀不懂格式時回空的',
    why: '空的休市清單會讓「挑休市最多的月份」默默挑錯月份，而不是停下來。',
    file: 'scripts/livejudge.mjs',
    find: "  throw new Error('data/calendar.json 的格式認不得：沒有 years，也沒有頂層的 closed');",
    replace: '  return [];',
    test: 'controltest',
    expect: 'livecheck 對照十：',
  },
  {
    name: 'LC：日曆休市日只讀頂層的 closed（修正前的寫法）',
    why: '多年格式沒有頂層的 closed：修正前 livecheck 每次都崩在這裡。',
    file: 'scripts/livejudge.mjs',
    find: "  if (cal && cal.years && typeof cal.years === 'object') {",
    replace: '  if (false) {',
    test: 'controltest',
    expect: 'livecheck 對照十：',
  },
  // ---- S6：livecheck 的判斷邏輯（livejudge.mjs）——以前全部比對真實回應，沒有合成對照 ----
  {
    name: 'S6：CORS 比對永遠成立',
    why: '證交所拿掉 CORS 標頭，純前端就拿不到收盤價；巡檢卻照樣說標頭還在。',
    file: 'scripts/livejudge.mjs',
    find: "export const corsProblem = (value) => (value === '*' ? null :",
    replace: "export const corsProblem = (value) => (true ? null :",
    test: 'controltest',
    expect: 'livecheck 對照一：',
  },
  {
    name: 'S6：STOCK_DAY_ALL 不再檢查 2330 在不在',
    why: '表的內容換了（例如只剩 ETF），巡檢照樣說格式沒變。',
    file: 'scripts/livejudge.mjs',
    find: "  if (!tsmc || tsmc.name !== '台積電') out.push(",
    replace: "  if (false) out.push(",
    test: 'controltest',
    expect: 'livecheck 對照二：',
  },
  {
    name: 'S6：STOCK_DAY 不再檢查除權息標記',
    why: '證交所改了 X 標記的寫法，除權息那天的漲跌會被當成真的漲跌、參考價不會去拿。',
    file: 'scripts/livejudge.mjs',
    find: "  if (!(ex.length === 1 && ex[0] === '2026-06-11')) out.push(",
    replace: "  if (false) out.push(",
    test: 'controltest',
    expect: 'livecheck 對照三：',
  },
  {
    name: 'S6：上櫃前提不再檢查「查不查得到」',
    why: '證交所開始回上櫃代號的資料了，「不支援上櫃」的設計前提已經變了，巡檢卻不報。',
    file: 'scripts/livejudge.mjs',
    find: "  if (otc.ok !== false) out.push('上櫃代號查得到資料了');",
    replace: '',
    test: 'controltest',
    expect: 'livecheck 對照四：',
  },
  {
    name: 'S6：TWT48U 的格式錯誤被吞掉',
    why: '欄位改名時解析器拋錯，被 catch 成「沒問題」——空的 catch 那一種。',
    file: 'scripts/livejudge.mjs',
    find: "  try { parsed = parseTwt48u(json); } catch (e) { return { rows: [], problems: [`格式變了：${e.message}`] }; }",
    replace: '  try { parsed = parseTwt48u(json); } catch (e) { return { rows: [], problems: [] }; }',
    test: 'controltest',
    expect: 'livecheck 對照五：',
  },
  {
    name: 'S6：參考價比對永遠一致',
    why: '證交所改了參考價的算法，自算的參考價開始錯，巡檢卻說公式一致。',
    file: 'scripts/livejudge.mjs',
    find: 'export const refPriceMismatches = (rows) => rows.filter((r) => refPriceFromExValue({ prevClose: r.prevClose, exValue: r.exValue }) !== r.refPrice);',
    replace: 'export const refPriceMismatches = (rows) => [];',
    test: 'controltest',
    expect: 'livecheck 對照六：',
  },
  {
    name: 'S6：日曆比對不報日曆多出來的日子',
    why: '臨時休市（颱風假）那天日曆還寫著交易日，巡檢卻說完全一致。',
    file: 'scripts/livejudge.mjs',
    find: '  return { missing: actual.filter((d) => !mine.includes(d)), extra: mine.filter((d) => !actual.includes(d)) };',
    replace: '  return { missing: actual.filter((d) => !mine.includes(d)), extra: [] };',
    test: 'controltest',
    expect: 'livecheck 對照七：',
  },
  {
    name: 'S6：代號表比對不報沒收錄的代號',
    why: '新上市的股票不在代號表裡，使用者輸入時會被當成不支援；巡檢卻說都有。',
    file: 'scripts/livejudge.mjs',
    find: '    unknown: liveRows.filter((r) => !stocks.stocks[r.code]),',
    replace: '    unknown: [],',
    test: 'controltest',
    expect: 'livecheck 對照八：',
  },
  {
    name: 'S6：節流檢查不報太短的間隔',
    why: '連打證交所會被封 IP（FEASIBILITY §1.2）；間隔變短了巡檢卻說都 >= 2 秒。',
    file: 'scripts/livejudge.mjs',
    find: '  const short = gaps.filter((g) => g < 2000);',
    replace: '  const short = [];',
    test: 'controltest',
    expect: 'livecheck 對照九：',
  },
  // ---- S4：sweep 的判斷邏輯（sweepjudge.mjs）——以前版本比對改成永遠成立，20 項照樣全過 ----
  {
    name: 'S4：sw.js 的版本比對永遠成立',
    why: 'v9 盤點實測過的那一種：線上 sw.js 是舊版也不報，部署沒換上去卻顯示「版本一致」。',
    file: 'scripts/sweepjudge.mjs',
    find: "  if (sw !== local) out.push({ where: 'sw.js', got: sw });",
    replace: "  if (false) out.push({ where: 'sw.js', got: sw });",
    test: 'controltest',
    expect: 'sweep 對照一：',
    alsoRed: ["sweep 對照三："],
    alsoRedWhy: "「sw.js 讀不到版本」那組也靠同一行比對。",
  },
  {
    name: 'S4：index.html 的版本比對永遠成立',
    why: 'sw.js 換了、index.html 還載入舊的 app.js（快取或部署只換一半）時不報。',
    file: 'scripts/sweepjudge.mjs',
    find: "  if (html !== local) out.push({ where: 'index.html', got: html });",
    replace: "  if (false) out.push({ where: 'index.html', got: html });",
    test: 'controltest',
    expect: 'sweep 對照二：',
  },
  {
    name: 'S4：舊版快取不再被挑出來',
    why: '別版的快取留著不報：使用者可能一直跑在舊版上。',
    file: 'scripts/sweepjudge.mjs',
    find: "stale: caches.filter((c) => !c.includes(local)) };",
    replace: "stale: [] };",
    test: 'controltest',
    expect: 'sweep 對照四：',
  },
  {
    name: 'S4：所有主控台錯誤都被當成新聞上游的雜訊',
    why: '真的例外被歸進「新聞上游有 N 筆失敗」那一行 note，不算失敗。',
    file: 'scripts/sweepjudge.mjs',
    find: "    realErrors: errors.filter((e) => !isNoise(e) && !(isNewsUpstream(e) || /502/.test(e))),",
    replace: "    realErrors: [],",
    test: 'controltest',
    expect: 'sweep 對照五：',
  },
  {
    name: 'S4：不帶網址的 502 被當成真的錯誤',
    why: '反方向壞掉：新聞上游限速時主控台只印「Failed to load resource: 502」、不帶網址，被算成部署錯誤，巡檢天天紅、紅到沒人看。',
    file: 'scripts/sweepjudge.mjs',
    find: "    realErrors: errors.filter((e) => !isNoise(e) && !(isNewsUpstream(e) || /502/.test(e))),",
    replace: "    realErrors: errors.filter((e) => !isNoise(e) && !isNewsUpstream(e)),",
    test: 'controltest',
    expect: 'sweep 對照六（必過）：',
  },
  {
    name: 'S4：sw.js 讀不到版本時被當成一致',
    why: '線上 sw.js 變成 404 頁（取不到版本號），只在「取得到才比」時會被放過。',
    file: 'scripts/sweepjudge.mjs',
    find: "  if (sw !== local) out.push({ where: 'sw.js', got: sw });",
    replace: "  if (sw !== undefined && sw !== local) out.push({ where: 'sw.js', got: sw });",
    test: 'controltest',
    expect: 'sweep 對照三：',
  },
  {
    name: 'divrecordtest：「下一次除息」的 fixture 落在今天之前',
    why: '這就是 2026-09-22 起必紅的原因（fixture 寫死 09-21，日子一過就變成過去）。情境沒了要紅在前置，而不是讓「看不到下一次除息」看起來像功能壞了。',
    file: 'scripts/divrecordtest.mjs',
    find: '  const UPCOMING_IN_DAYS = 14;',
    replace: '  const UPCOMING_IN_DAYS = -14;',
    test: 'divrecordtest',
    expect: '（前提）fixture 的除息日',
    alsoRed: ["ETF 看得到下一次除權息","而且有已公告的每股金額","標明那是公告值","明講不年化"],
    alsoRedWhy: "情境（未來的除息日）不在，前置紅了之後，依賴那個情境的四條斷言一起紅——前置就是為了讓人分得出是情境不在。",
  },

  // ---- F10：三支入口的「對照組沒過就停」（scripts/entrygatetest.mjs 從真實入口驗，讓真的依賴失敗）----
  {
    name: 'F10：assertaudit 對照組沒過也照樣往下跑',
    why: '判斷邏輯壞了，照樣跑測試、產出一份不可信的報告（以前篩選條件改壞，報告只寫「（沒有）」、回傳 0）。',
    file: 'scripts/assertaudit.mjs',
    find: 'if (ctrl.some((c) => !c.ok)) {',
    replace: 'if (false) {',
    test: 'entrygatetest',
    expect: 'F10 assertaudit・依賴壞了：',
  },
  {
    name: 'F10：sweep 對照組沒過也照樣巡檢',
    why: '判斷邏輯壞了，照樣對線上巡檢，印出不可信的「全過」（以前版本比對改成恆真，20 項照樣全過）。',
    file: 'scripts/sweep.mjs',
    find: 'if (ctrl.some((c) => !c.ok)) {',
    replace: 'if (false) {',
    test: 'entrygatetest',
    expect: 'F10 sweep・依賴壞了：',
  },
  {
    name: 'F10：livecheck 對照組沒過也照樣打證交所',
    why: '判斷邏輯或錄音壞了，照樣去打證交所，對著真實回應印出不可信的結果。',
    file: 'scripts/livecheck.mjs',
    find: 'if (ctrl.some((c) => !c.ok)) {',
    replace: 'if (false) {',
    test: 'entrygatetest',
    expect: 'F10 livecheck・依賴壞了：',
  },

  // ---- PC：公開前自查取 commit 訊息與作者欄（precheck.mjs 的 commitMeta；2026-09-24，MealMate 與統籌者各中一次的位置）----
  {
    name: 'PC：有 commit 卻取不到作者欄也放行',
    why: '取訊息與作者欄的 git 回了空的（或少了），自查當成 0 行、0 命中通過——姓名與信箱那道防線無聲失效。',
    file: 'scripts/precheck.mjs',
    find: '  if (authors !== count || committers !== count) {',
    replace: '  if (false) {',
    test: 'controltest',
    expect: '自查訊息與作者：有 commit 卻取到空的',
    alsoRed: ['自查訊息與作者：只取到一部分'],
    alsoRedWhy: '「全部取不到」與「只取到一部分」靠的是同一道核對（作者欄數＝commit 數），拿掉它兩種一起放行。',
  },
  {
    name: 'PC：git 失敗被吞掉、當成空的',
    why: '隱式的擋（例外往外丟、整支崩掉）改成明寫之後，「把例外吞掉」就是對應的突變（Dispatch 2026-09-24）：吞掉之後當成 0 個 commit、放行。',
    file: 'scripts/precheck.mjs',
    find: "    return { lines: [], problem: `取不到 commit 數或訊息與作者欄（git 失敗：${String(e?.message ?? e).split('\\n')[0]}）` };",
    replace: '    return { lines: [], problem: null };',
    test: 'controltest',
    expect: '自查訊息與作者：取訊息的 git 失敗',
    alsoRed: ['自查訊息與作者：數 commit 的 git 失敗', '自查訊息與作者：真的 git 失敗'],
    alsoRedWhy: '三種失敗（取訊息的 git、數 commit 的 git、真的 git 因 GIT_DIR 失敗）都落在同一個 catch。',
  },
  {
    name: 'PC：commit 數算不出來也往下比',
    why: '算不出 commit 數時沒有先講明，後面的核對拿 NaN 去比，照樣會擋，但理由變成「取到幾個作者欄」，看不出真正壞的是哪裡。',
    file: 'scripts/precheck.mjs',
    find: "  if (!Number.isInteger(count)) return { lines: [], problem: '算不出這次有幾個 commit' };",
    replace: '  // 突變：不檢查 commit 數算不算得出來',
    test: 'controltest',
    expect: '自查訊息與作者：commit 數算不出來',
  },
  {
    name: 'PC：單一 commit 沒有限定 -1',
    why: '自查單一 commit 時，數 commit 與取訊息都沒限定 -1，會把整段歷史的訊息與作者都掃進來（數量兩邊剛好一致，核對看不出來）。',
    file: 'scripts/precheck.mjs',
    find: "  const range = rev.includes('..') ? [rev] : ['-1', rev];",
    replace: "  const range = rev.includes('..') ? [rev] : [rev];",
    test: 'controltest',
    expect: '自查訊息與作者：單一 commit 兩個子指令都只看那一個',
  },

  // ---- GS：壞寫法掃描新增的「閘門讀環境變數換東西」（2026-09-25）----
  {
    name: 'GS：env-switch 規則什麼都不抓',
    why: '閘門或自查又加回 X="${X:-…}" 這種可以從外面換掉檢查器的開關，掃描不會報。',
    file: 'scripts/gatescan.mjs',
    find: '    line: (l) => !isComment(l) && readsEnvSwitch(l),',
    replace: '    line: () => false,',
    test: 'gatescan',
    expect: 'env-switch',
  },

  // ---- EV：一次性量測腳本的登記（scripts/evidencereg.mjs；2026-09-24 Dispatch：收進 repo、列進孤兒檢查的登記）----
  {
    name: 'EV：沒登記的量測腳本不報',
    why: 'scripts/evidence/ 多一支沒寫用途、比哪兩版、數字在哪的腳本，不會有人發現。',
    file: 'scripts/evidencereg.mjs',
    find: "  for (const f of files) if (!(f in registry)) out.push(`沒登記：scripts/evidence/${f}`);",
    replace: '  // 突變：不報沒登記的',
    test: 'doctest',
    expect: '（對照）沒登記、登記了卻不在、檔頭不一樣、證據檔沒有那一段',
  },
  {
    name: 'EV：登記了卻不在的不報',
    why: '腳本被刪了，登記還說它在，證據檔指向一支不存在的腳本。',
    file: 'scripts/evidencereg.mjs',
    find: "  for (const f of Object.keys(registry)) if (!files.includes(f)) out.push(`登記了卻不在：scripts/evidence/${f}`);",
    replace: '  // 突變：不報登記了卻不在的',
    test: 'doctest',
    expect: '（對照）沒登記、登記了卻不在、檔頭不一樣、證據檔沒有那一段',
  },
  {
    name: 'EV：檔頭跟登記不一樣也不報',
    why: '檔頭寫的用途、版本跟登記對不上，看檔頭的人被誤導。',
    file: 'scripts/evidencereg.mjs',
    find: '    if (headerLineOf(f, texts[f]) !== want) out.push(',
    replace: '    if (false) out.push(',
    test: 'doctest',
    expect: '（對照）沒登記、登記了卻不在、檔頭不一樣、證據檔沒有那一段',
  },
  {
    name: 'EV：證據檔裡沒有那一段也不報',
    why: '「數字在證據檔哪一段」寫的段落不存在（改名或搬走了），指標就斷了。',
    file: 'scripts/evidencereg.mjs',
    find: '    if (!doc.includes(registry[f].section)) out.push(',
    replace: '    if (false) out.push(',
    test: 'doctest',
    expect: '（對照）沒登記、登記了卻不在、檔頭不一樣、證據檔沒有那一段',
  },

  // ---- F9：build 驗法登記（scripts/buildverify.mjs；2026-09-24 統籌者新訂）----
  // 閘門那一側（gatepush.sh 不理 buildverify 的回傳值）由 gateselftest 的變體 G4 驗。
  {
    name: 'F9：登記前不比對工作區與 HEAD',
    why: '工作區有改動還照樣登記：登記寫的是 HEAD 的雜湊、驗法跑的卻是工作區，等於把沒驗過的 HEAD 登記成驗過（JLPT 缺的就是這一條）。',
    file: 'scripts/buildverify.mjs',
    find: '  if (before.bad.length) stop(',
    replace: '  if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 登記・工作區有改動：',
  },
  {
    name: 'F9：一開跑不刪舊登記',
    why: '驗法沒過、或中途停下時，上一次的登記還留著，閘門照樣放行。',
    file: 'scripts/buildverify.mjs',
    find: '  fs.rmSync(REG, { force: true });   // 一開跑就刪',
    replace: '  // 突變：不刪舊登記',
    test: 'buildverifytest',
    expect: 'F9 登記・驗法沒過：',
    alsoRed: ['F9 登記・工作區有改動：', 'F9 登記・沒有全擋：', 'F9 登記・沒有總計：', 'F9 登記・總計不在該在的位置：', 'F9 登記・跑的期間改了檔：', 'F9 登記・相依不在清單上：', 'F9 登記・清單上的檔不見了：'],
    alsoRedWhy: '每一種「不登記」的情境都先放了一份舊登記、再驗它被刪掉；不刪舊登記，這八種一起紅。',
  },
  {
    name: 'F9：矩陣總計不看是不是在行首',
    why: '總計那一行只要出現過就算（「出現過」不等於「是總計」）：別處印的同一句也能讓它登記。',
    file: 'scripts/buildverify.mjs',
    find: '/^ {2}· 矩陣共',
    replace: '/ {2}· 矩陣共',
    test: 'buildverifytest',
    expect: 'F9 登記・總計不在該在的位置：',
  },
  {
    name: 'F9：沒有全部擋下也登記',
    why: '矩陣有格子只是碰巧擋下或沒擋，也照樣登記成驗過。',
    file: 'scripts/buildverify.mjs',
    find: 'if (!(total > 0 && blocked === total)) stop(',
    replace: 'if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 登記・沒有全擋：',
  },
  {
    name: 'F9：相依不在清單上也登記',
    why: 'build 多用了一支檔、登記清單沒跟上，那支檔以後改了不會觸發重跑驗法。',
    file: 'scripts/buildverify.mjs',
    find: '  if (orphan.length) stop(',
    replace: '  if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 登記・相依不在清單上：',
  },
  {
    name: 'F9：驗法跑的期間改了檔也登記',
    why: '跑的是改之前的版本，登記的卻可能是改之後的——兩者對不上。',
    file: 'scripts/buildverify.mjs',
    find: '  if (after.bad.length) stop(',
    replace: '  if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 登記・跑的期間改了檔：',
  },
  {
    name: 'F9：推送前只看最後一個 commit 有沒有動到',
    why: '前一個 commit 動到 build、最後一個乾淨，就不看登記直接放行（MealMate 補的那一種）。',
    file: 'scripts/buildverify.mjs',
    find: '  const touched = [...new Set(lines.filter((l) => GUARDED.includes(l)))];',
    replace: "  const touched = [...new Set(lines.slice(0, lines.findIndex((l, i) => i > 0 && l.startsWith('commit ')) + 1 || lines.length).filter((l) => GUARDED.includes(l)))];",
    test: 'buildverifytest',
    expect: 'F9 比對・前一個 commit 動到：',
  },
  {
    name: 'F9：沒動到也要登記',
    why: '每一次推送都得先跑 buildtest（不是這條規則要的）；沒動到 build 的推送被擋下。',
    file: 'scripts/buildverify.mjs',
    find: '  if (!touched.length) { say(',
    replace: '  if (false) { say(',
    test: 'buildverifytest',
    expect: 'F9 比對・沒動到：',
  },
  {
    name: 'F9：有登記就放行（不比雜湊）',
    why: '登記的是舊版也照樣放行：改過 build 不重跑驗法也推得出去。',
    file: 'scripts/buildverify.mjs',
    find: '    return have.status !== 0 || reg[f] !== have.stdout.trim();',
    replace: '    return false;',
    test: 'buildverifytest',
    expect: 'F9 比對・前一個 commit 動到：',
  },
  {
    name: 'F9：沒有登記檔也往下比',
    why: '沒有登記時不是用設計好的訊息擋下，而是讀檔崩掉、吐堆疊——看不出是哪一關、為什麼。',
    file: 'scripts/buildverify.mjs',
    find: '  if (!fs.existsSync(REG)) stop(',
    replace: '  if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 比對・動到而沒有登記：',
  },
  {
    name: 'F9：範圍算不出當成沒動到',
    why: '取不到要推的 commit 時，列出來的檔是空的，就當成沒動到而放行（§5.13：故障時要停下）。',
    file: 'scripts/buildverify.mjs',
    find: '  if (log.status !== 0 || count.status !== 0) stop(',
    replace: '  if (false) stop(',
    test: 'buildverifytest',
    expect: 'F9 比對・範圍算不出：',
  },
];

const TESTS = [...new Set(MUTATIONS.map((m) => m.test))];

// 每支測試的逾時。gateselftest（推送閘門驗法的自我測試）要跑約 7 分鐘，180 秒會讓基準直接被判成不綠（2026-09-24 踩到）。
const TEST_TIMEOUT = { gateselftest: 15 * 60 * 1000 };
function runTest(name) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', `${name}.mjs`)], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: TEST_TIMEOUT[name] ?? 180000,
    });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// 被改壞的檔案一定要還原，就算中途被 Ctrl-C 或丟例外。
const backups = new Map();

/**
 * 還原記錄**寫在磁碟上**，不是只留在記憶體裡。
 *
 * `process.on('exit')` 遇到硬殺（工作管理員、CI 逾時、Ctrl-Break）不會跑。
 * 實際發生過：中途 kill 掉之後，`js/update.js` 留著一條突變在工作目錄裡 ——
 * 程式看起來很正常，只是某幾條測試紅；沒注意就 commit 的話，
 * 等於把一條**故意寫壞的程式碼**推上線。
 *
 * 有這個檔的話，下一次啟動會先把它還原回去，並且大聲講出來。
 */
const PENDING = path.join(ROOT, 'scripts/.mutation-pending.json');

function writePending(rel, content) {
  try { fs.writeFileSync(PENDING, JSON.stringify({ file: rel, content, at: new Date().toISOString() }), 'utf8'); } catch { /* 盡力 */ }
}
function clearPending() {
  try { fs.rmSync(PENDING, { force: true }); } catch { /* 盡力 */ }
}

/** 上一次跑到一半被殺掉的話，把那個檔案還原回去。 */
function recoverPending() {
  if (!fs.existsSync(PENDING)) return null;
  let rec;
  try { rec = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { clearPending(); return null; }
  const abs = path.join(ROOT, rec.file);
  const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  clearPending();
  if (now === rec.content) return { file: rec.file, changed: false };
  fs.writeFileSync(abs, rec.content, 'utf8');
  return { file: rec.file, changed: true, at: rec.at };
}

function restoreAll() {
  for (const [rel, content] of backups) {
    try { fs.writeFileSync(path.join(ROOT, rel), content, 'utf8'); } catch { /* 盡力 */ }
  }
  backups.clear();
  clearPending();
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

// 先確認每條突變指到的測試檔真的存在。
// 少了這一步，檔名打錯會以「基準不是綠的、而且沒有任何 ✗ 明細」的形式出現 ——
// 看起來像測試壞了，其實是 scripts/<代號>.mjs 根本不存在。（踩過一次。）
section('開跑前：檢查上一次有沒有留下沒還原的突變');
const recovered = recoverPending();
if (recovered?.changed) {
  ok(false, `上一次跑到一半被殺掉，${recovered.file} 留著一條突變（已經還原回去了）`,
    `那次是 ${recovered.at} 開始的。**請重跑一次**，而且先確認剛才那段時間沒有把它 commit 出去。`);
} else {
  note(recovered ? `上一次的記錄還在，但 ${recovered.file} 內容是對的，不用還原` : '沒有殘留，工作目錄是乾淨的');
}

section('突變指到的測試檔都存在');
const missingTests = TESTS.filter((t) => !fs.existsSync(path.join(ROOT, 'scripts', `${t}.mjs`)));
eq(missingTests, [], `每條突變的 test 代號都對得到 scripts/<代號>.mjs（${TESTS.length} 個代號）`);
if (missingTests.length) {
  console.log('\n檔名對不起來，後面不用跑了。');
  done('mutationtest');
}

// 只跑其中幾條：node scripts/mutationtest.mjs --only scenariotest
//
// **這是除錯用的，不是驗收用的。** 跑完只證明挑出來的那幾條沒問題，
// 所以下面會把「這次只跑了幾條」寫進輸出，免得有人拿部分結果當成全綠。
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();
// 只跑「這次改動影響到的」：node scripts/mutationtest.mjs --changed [base]
//
// base 預設 HEAD（工作目錄相對上一個 commit 的改動）；也可以給 main、HEAD~3 之類。
// 挑選規則見 scripts/affected.mjs：突變要改的檔、突變對應的測試檔、
// 那支測試碰得到的任何模組 —— 三者有一個被改到就挑。
//
// **這一樣是日常用的，不是驗收用的。** 全綠的定義仍然是不帶參數跑完全部。
const CHANGED = (() => {
  const i = process.argv.indexOf('--changed');
  if (i < 0) return null;
  const nextArg = process.argv[i + 1];
  const base = nextArg && !nextArg.startsWith('--') ? nextArg : 'HEAD';
  const run = (args) => {
    try {
      // core.quotepath=false：不然中文檔名會被跳脫成 å¨，比對不到
      return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      console.error(`✗ git ${args.join(' ')} 失敗：${String(e.stderr || e.message).trim()}`);
      process.exit(1);
    }
  };
  // 已追蹤檔案的改動 ＋ 還沒 git add 的新檔（新增一支測試也算改動）
  const diff = run(['diff', '--name-only', base]);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  const files = [...diff.split('\n'), ...untracked.split('\n')].map((x) => x.trim()).filter(Boolean);
  return { base, files: [...new Set(files)] };
})();

const readRel = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 只跑帶 expect 的：node scripts/mutationtest.mjs --expect-only（除錯用；判定「只紅對應的那一種」時用它盤點）
const EXPECT_ONLY = process.argv.includes('--expect-only');
const SELECTED = (() => {
  if (EXPECT_ONLY) return MUTATIONS.filter((m) => m.expect);
  if (ONLY) {
    return MUTATIONS.filter((m) => m.name.includes(ONLY) || m.test.includes(ONLY) || m.file.includes(ONLY));
  }
  if (CHANGED) {
    return selectAffected(MUTATIONS, CHANGED.files, (t) => moduleClosure(`scripts/${t}.mjs`, readRel));
  }
  return MUTATIONS;
})();

if (EXPECT_ONLY) {
  section('只跑帶 expect 的突變');
  ok(SELECTED.length > 0, `挑出 ${SELECTED.length} 條（全部 ${MUTATIONS.length} 條）`);
  note(`**這不是全綠**：這次只驗了 ${SELECTED.length}/${MUTATIONS.length} 條，其餘沒有跑。`);
}

if (ONLY) {
  section(`只跑符合「${ONLY}」的突變`);
  ok(SELECTED.length > 0, `挑出 ${SELECTED.length} 條（全部 ${MUTATIONS.length} 條）`);
  note(`**這不是全綠**：這次只驗了 ${SELECTED.length}/${MUTATIONS.length} 條，其餘沒有跑。`);
}

if (CHANGED) {
  section(`只跑這次改動（相對 ${CHANGED.base}）影響到的突變`);
  ok(CHANGED.files.length > 0,
    `git 說改到了 ${CHANGED.files.length} 個檔：${CHANGED.files.slice(0, 6).join('、')}${CHANGED.files.length > 6 ? '…' : ''}`,
    '沒有任何改動 —— --changed 沒東西可挑，要驗收請不帶參數跑全部');
  ok(SELECTED.length > 0,
    `挑出 ${SELECTED.length} 條（全部 ${MUTATIONS.length} 條），涵蓋 ${new Set(SELECTED.map((m) => m.test)).size} 支測試`,
    '一條都沒挑到 —— 改到的檔案跟任何突變都沾不上邊，確認一下是不是漏了什麼');
  note(`**這不是全綠**：這次只驗了 ${SELECTED.length}/${MUTATIONS.length} 條，其餘沒有跑。`);
}

section('基準：沒有任何突變時，測試必須全綠');
let baselineOk = true;
// 基準只跑「這次挑出來的突變會用到的」那幾支 —— 不然 --only 還是要先等 27 支跑完。
// 沒有 --only 的時候 SELECTED 就是全部，跟以前一樣。
const BASELINE_TESTS = [...new Set(SELECTED.map((m) => m.test))];
for (const t of BASELINE_TESTS) {
  const r = runTest(t);
  if (!ok(r.code === 0, `${t} 在乾淨的程式碼上通過`, r.out.split('\n').filter((l) => l.includes('✗')).join('\n      '))) {
    baselineOk = false;
  }
}
if (!baselineOk) {
  console.log('\n基準就不是綠的 —— 突變測試的結果沒有意義，先把測試修好。');
  done('mutationtest');
}

section(`${SELECTED.length} 條突變：每一條都必須讓對應的測試變紅`);
for (const mut of SELECTED) {
  const abs = path.join(ROOT, mut.file);
  const original = fs.readFileSync(abs, 'utf8');

  const occurrences = countOf(original, mut.find);
  if (occurrences !== 1) {
    ok(false, `${mut.name}`,
      `要改的程式碼在 ${mut.file} 裡出現 ${occurrences} 次（需要剛好 1 次）—— 這條突變過期了，` +
      '表示對應的斷言已經很久沒有被驗證過。請更新突變或確認該邏輯還在。');
    continue;
  }

  backups.set(mut.file, original);
  writePending(mut.file, original);          // 被硬殺掉也還原得回來
  fs.writeFileSync(abs, applyMutation(original, mut.find, mut.replace), 'utf8');
  const r = runTest(mut.test);
  fs.writeFileSync(abs, original, 'utf8');
  backups.delete(mut.file);
  clearPending();

  const restored = fs.readFileSync(abs, 'utf8');
  if (restored !== original) {
    ok(false, `${mut.name}：還原失敗`, `${mut.file} 的內容跟原檔不一樣了`);
    continue;
  }

  // 判定：沒帶 expect 只看 exit code；帶了的，還要紅在含 expect 的那一條（mutjudge.mjs）
  const { verdict, failed, extra } = judge(r, mut.expect, mut.alsoRed);
  const label = mut.expect ? `${mut.name} → ${mut.test} 紅在「${mut.expect}」` : `${mut.name} → ${mut.test} 變紅`;
  ok(verdict === 'red', label,
    verdict === 'not-red'
      ? `【沒紅】改壞了 ${mut.file} 但 ${mut.test} 還是綠的。原因：${mut.why}\n      ` +
        '→ 這代表對應的斷言沒有真的在檢查這件事。'
      : verdict === 'wrong-place'
        ? `【紅錯地方】${mut.test} 紅了，但沒有任何一條失敗的斷言含「${mut.expect}」。` +
          `實際紅的是：${failed.length ? failed.slice(0, 3).join('／') : '（沒有 ✗ 行 —— 測試直接崩了）'}\n      ` +
          '→ 這只證明改壞之後「某處」會紅，不能證明它想守的那一條有效。'
        : verdict === 'extra-red'
          ? `【多紅了別組】紅在「${mut.expect}」，但別組也一起紅：${extra.slice(0, 4).join('／')}${extra.length > 4 ? ` 等 ${extra.length} 條` : ''}\n      ` +
            '→ 保證不了「只紅對應的那一種」。本來就該連帶紅的，在突變上用 alsoRed 明列、並在 why 講理由。'
          : '');
}

section('突變清單本身');
eq([...new Set(MUTATIONS.map((m) => m.name))].length, MUTATIONS.length, '沒有重複的突變');
ok(MUTATIONS.every((m) => m.why && m.why.length > 10), '每條突變都寫了「改壞了會怎樣」');
eq(backups.size, 0, '所有被改過的檔案都已還原');

done('mutationtest');
