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
    why: 'STATUS 列的第 1 條，也是自製記帳最常見的錯：除息日會生出一筆等於息值的假虧損。',
    file: 'js/settle.js',
    find: "    return refPrice == null ? { basis: null, source: 'none' } : { basis: refPrice, source: 'refPrice' };",
    replace: "    return refPrice == null ? { basis: prevClose, source: 'prevClose' } : { basis: refPrice, source: 'refPrice' };",
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
    find: "    if (s === '') return null;",
    replace: "    if (s === '') return 0n;",
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
