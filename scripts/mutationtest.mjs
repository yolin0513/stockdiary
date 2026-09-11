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
    name: '首頁把不支援報價的持股當成一般持股畫',
    why: '那一列會出現收盤價與當日損益 —— 但那些數字沒有來源。',
    file: 'js/views/home.js',
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
ok(TESTS.every((t) => fs.existsSync(path.join(ROOT, 'scripts', `${t}.mjs`))), `對應到的測試都存在：${TESTS.join('、')}`);
eq(backups.size, 0, '所有被改過的檔案都已還原');

done('mutationtest');
