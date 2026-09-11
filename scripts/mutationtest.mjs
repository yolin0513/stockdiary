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
import { ok, eq, section, done } from './tap.mjs';

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
  },
  {
    name: '把空字串的數字當成 0',
    why: '沒公布、沒成交、查不到，全部會變成 0 —— 這是「今日收盤尚未公布時顯示 0」的源頭。',
    file: 'js/twse.js',
    find: "if (t === '' || t === '--' || t === '---') return null;",
    replace: "if (t === '' || t === '--' || t === '---') return 0;",
    test: 'parsetest',
  },
  {
    name: '不認得除權息的 "X0.00" 標記',
    why: '除權息日 TWSE 回 "X0.00"。當成持平的話，除息日會生出一筆等於息值的假虧損（或假持平）。',
    file: 'js/twse.js',
    find: 'const exMark = /X/i.test(rawChange);',
    replace: 'const exMark = false;',
    test: 'parsetest',
  },
  {
    name: '欄位順序變了還硬解',
    why: '欄位錯位解出來的數字看起來都很正常，但每一個都是別欄的值。',
    file: 'js/twse.js',
    find: 'throw new Error(`STOCK_DAY_ALL 欄位與預期不同：第 ${i + 1} 欄是「${r[i].trim()}」，預期「${SDA_HEADER[i]}」`);',
    replace: 'continue;',
    test: 'parsetest',
  },
  {
    name: '民國年換算差一年',
    why: '日期差一年，回補與除權息對照全部會對到錯的資料。',
    file: 'js/roc.js',
    find: 'const ROC_OFFSET = 1911;',
    replace: 'const ROC_OFFSET = 1912;',
    test: 'roctest',
  },
  {
    name: '忽略「今日資料公布門檻」，盤中就去抓今天',
    why: '門檻前抓今天只會拿到昨天的資料，接著被當成今天 —— 使用者會看到一筆假的當日損益。',
    file: 'js/market.js',
    find: 'if (isTd && mins >= threshold) return today;',
    replace: 'if (isTd) return today;',
    test: 'roctest',
  },
  {
    name: '把每一天都當成交易日',
    why: '休市日會被算成「缺漏日」，程式就會去打 TWSE 回補一堆不存在的日子。',
    file: 'js/market.js',
    find: 'return cal.set.has(iso);',
    replace: 'return true;',
    test: 'roctest',
  },
  {
    name: '用 toISOString 取今天（時區差一天）',
    why: '台北時間早上八點以前，toISOString() 會給出前一天 —— App 整天都在算昨天。',
    file: 'js/roc.js',
    find: "return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;",
    replace: 'return d.toISOString().slice(0, 10);',
    test: 'roctest',
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
  },
  {
    name: '網址屬性不過白名單',
    why: 'javascript: 連結會變成可執行的程式碼。',
    file: 'js/ui.js',
    find: '      if (SAFE_URL.test(String(v).trim())) el.setAttribute(k, v);',
    replace: '      el.setAttribute(k, v);',
    test: 'shelltest',
  },
  {
    name: 'SHELL 清單漏掉一個 view',
    why: '換版當下舊程式動態 import 到不在快取裡的新檔案，畫面會被踢回首頁；離線時則是白畫面。',
    file: 'sw.js',
    find: "  './js/views/settings.js',\n",
    replace: '',
    test: 'shelltest',
  },
  {
    name: 'Service Worker 連跨網域回應也快取',
    why: 'TWSE 的收盤價被快取之後，隔天開 App 會拿到昨天的價格，而且看起來完全正常。',
    file: 'sw.js',
    find: '  if (url.origin !== self.location.origin) return;',
    replace: '  if (url.origin !== self.location.origin) { /* 照樣往下走 */ }',
    test: 'shelltest',
  },
  {
    name: '拿不到的金額顯示 0',
    why: '「今日收盤尚未公布」時顯示 0，使用者會以為今天真的沒賺沒賠。',
    file: 'js/ui.js',
    find: "  if (n == null || !Number.isFinite(n)) return NO_VALUE;\n  const rounded = Math.round(n);",
    replace: '  if (n == null || !Number.isFinite(n)) return \'0\';\n  const rounded = Math.round(n);',
    test: 'fmttest',
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
  },
  {
    name: '回推某一天的股數時忽略日期',
    why: '回補三個月前的損益時會用今天的股數去乘，每一天都算錯。',
    file: 'js/holdings.js',
    find: '    if (c.date > date) continue;',
    replace: '',
    test: 'changestest',
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
  },
  {
    name: '版本號三個地方不一致（sw.js 忘了跟上）',
    why: '漏改一個，快取鍵與快取名稱就對不起來，新舊檔案又會混在一起。',
    file: 'sw.js',
    find: `const VERSION = '${APP_VERSION}';`,
    replace: "const VERSION = 'stockdiary-v0.0.0-mutant';",
    test: 'shelltest',
  },
  {
    name: '動態 import 不帶版本參數',
    why: '新版的 app.js 會配上瀏覽器快取裡的舊 view —— 同一個 bug 的反方向。',
    file: 'js/app.js',
    find: "route('/plans', async () => (await import(`./views/plans.js${V}`)).default());",
    replace: "route('/plans', async () => (await import('./views/plans.js')).default());",
    test: 'shelltest',
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
  },
  {
    name: '股數法把湊不滿一股的餘額丟掉',
    why: 'PLAN §6 明訂餘額結轉。丟掉的話，每一期都憑空少掉最多一股的錢。',
    file: 'js/calc.js',
    find: '        cash -= bought * priceMicro;\n      } else {\n        value += usableEach;',
    replace: '        cash = 0n;\n      } else {\n        value += usableEach;',
    test: 'calctest',
  },
  {
    name: '股利扣費開關關閉時照樣扣',
    why: '開關預設是關的。關著還扣，使用者算出來的數字比他的假設少一截。',
    file: 'js/calc.js',
    find: '  if (!applyFees || grossMicro <= 0n) return grossMicro;',
    replace: '  if (grossMicro <= 0n) return grossMicro;',
    test: 'calctest',
  },
  {
    name: '年化成長率用「除以 12」而不是複利換算',
    why: '12% 年化用單利拆成每月 1% 的話，一年後會變成 12.68%，跟使用者填的假設不一樣。',
    file: 'js/calc.js',
    find: '  return BigInt(Math.round(Math.pow(annual, 1 / 12) * 1e12));',
    replace: '  return BigInt(Math.round((1 + (annual - 1) / 12) * 1e12));',
    test: 'calctest',
  },
  {
    name: '股數法的期末市值不含未投入的現金',
    why: '那筆錢還是使用者的。不算進去會讓股數法看起來比實際差，兩種算法的比較就失真。',
    file: 'js/calc.js',
    find: '    ? BigInt(shares) * priceMicro + cash',
    replace: '    ? BigInt(shares) * priceMicro',
    test: 'calctest',
  },
  {
    name: '試算器不扣扣款手續費',
    why: '使用者填了手續費率卻沒被用到，算出來的期末會偏高。',
    file: 'js/calc.js',
    find: '  const usableEach = contribEach - mulRate(contribEach, BigInt(Math.round(v.feeRate * 1e12)));',
    replace: '  const usableEach = contribEach;',
    test: 'calctest',
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
    find: String.raw`      h('div', { class: 'bar-fill', style: ` + '`width: ${Math.max(0, Math.min(100, pct))}%`' + String.raw` })),`,
    replace: String.raw`      h('div', { class: 'bar-fill', style: ` + '`width: ${pct * 3}%`' + String.raw` })),`,
    test: 'layouttest',
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
    find: `    concentrationCard(withIndustry, quotes),
    held.length === 0`,
    // 把「新增持股」那張卡插到持股清單前面 —— 這就是使用者回報的原本順序。
    replace: `    concentrationCard(withIndustry, quotes),
    h('section', { class: 'card', dataset: { card: 'addHolding' } }),
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
];

const TESTS = [...new Set(MUTATIONS.map((m) => m.test))];

function runTest(name) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', `${name}.mjs`)], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 180000,
    });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// 被改壞的檔案一定要還原，就算中途被 Ctrl-C 或丟例外。
const backups = new Map();
function restoreAll() {
  for (const [rel, content] of backups) {
    try { fs.writeFileSync(path.join(ROOT, rel), content, 'utf8'); } catch { /* 盡力 */ }
  }
  backups.clear();
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

// 先確認每條突變指到的測試檔真的存在。
// 少了這一步，檔名打錯會以「基準不是綠的、而且沒有任何 ✗ 明細」的形式出現 ——
// 看起來像測試壞了，其實是 scripts/<代號>.mjs 根本不存在。（踩過一次。）
section('突變指到的測試檔都存在');
const missingTests = TESTS.filter((t) => !fs.existsSync(path.join(ROOT, 'scripts', `${t}.mjs`)));
eq(missingTests, [], `每條突變的 test 代號都對得到 scripts/<代號>.mjs（${TESTS.length} 個代號）`);
if (missingTests.length) {
  console.log('\n檔名對不起來，後面不用跑了。');
  done('mutationtest');
}

section('基準：沒有任何突變時，測試必須全綠');
let baselineOk = true;
for (const t of TESTS) {
  const r = runTest(t);
  if (!ok(r.code === 0, `${t} 在乾淨的程式碼上通過`, r.out.split('\n').filter((l) => l.includes('✗')).join('\n      '))) {
    baselineOk = false;
  }
}
if (!baselineOk) {
  console.log('\n基準就不是綠的 —— 突變測試的結果沒有意義，先把測試修好。');
  done('mutationtest');
}

section(`${MUTATIONS.length} 條突變：每一條都必須讓對應的測試變紅`);
for (const mut of MUTATIONS) {
  const abs = path.join(ROOT, mut.file);
  const original = fs.readFileSync(abs, 'utf8');

  const occurrences = original.split(mut.find).length - 1;
  if (occurrences !== 1) {
    ok(false, `${mut.name}`,
      `要改的程式碼在 ${mut.file} 裡出現 ${occurrences} 次（需要剛好 1 次）—— 這條突變過期了，` +
      '表示對應的斷言已經很久沒有被驗證過。請更新突變或確認該邏輯還在。');
    continue;
  }

  backups.set(mut.file, original);
  fs.writeFileSync(abs, original.replace(mut.find, mut.replace), 'utf8');
  const r = runTest(mut.test);
  fs.writeFileSync(abs, original, 'utf8');
  backups.delete(mut.file);

  const restored = fs.readFileSync(abs, 'utf8');
  if (restored !== original) {
    ok(false, `${mut.name}：還原失敗`, `${mut.file} 的內容跟原檔不一樣了`);
    continue;
  }

  ok(r.code !== 0, `${mut.name} → ${mut.test} 變紅`,
    r.code === 0
      ? `改壞了 ${mut.file} 但 ${mut.test} 還是綠的。原因：${mut.why}\n      ` +
        '→ 這代表對應的斷言沒有真的在檢查這件事。'
      : '');
}

section('突變清單本身');
eq([...new Set(MUTATIONS.map((m) => m.name))].length, MUTATIONS.length, '沒有重複的突變');
ok(MUTATIONS.every((m) => m.why && m.why.length > 10), '每條突變都寫了「改壞了會怎樣」');
eq(backups.size, 0, '所有被改過的檔案都已還原');

done('mutationtest');
