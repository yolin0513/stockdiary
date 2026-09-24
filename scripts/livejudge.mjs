// livecheck（打證交所的巡檢）的判斷邏輯與對照組（SPEC_檢查器修補 S6，F1）。
//
// 為什麼抽出來：livecheck 的比對全部對著真實回應——外面的世界剛好沒變，判斷邏輯壞掉也看不出來
// （v9 盤點：沒有合成對照組）。抽成模組之後：livecheck 開頭先用**錄好的回應**（scripts/fixtures/，
// 以前實際打證交所存下來的）跑對照組，**不打證交所**，沒過就停；scripts/controltest.mjs 每版跑同一組。
//
// 每一組對照都是一對：好的錄音不能報，另外**故意改壞一份錄音**（證交所改了格式、CORS 標頭不見、
// 日曆少一天……）必須報，而且報的是那一項。改壞的方式寫在每一組旁邊。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { parseStockDayAll, parseStockDay } = await load('js/twse.js');
const { parseTwt48u, parseTwt49u, refPriceFromExValue } = await load('js/dividend.js');

/** CORS：瀏覽器直打要靠 access-control-allow-origin: *。回傳問題字串或 null。 */
export const corsProblem = (value) => (value === '*' ? null : `access-control-allow-origin 是 ${JSON.stringify(value)}，不是 "*"`);

/** STOCK_DAY_ALL 解出來的樣子還對不對。minRows：正式回應 > 1000 檔；錄音只留了 20 檔。 */
export function stockDayAllProblems(parsed, { minRows = 1000 } = {}) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date))) out.push(`資料日期格式不對：${parsed.date}`);
  if (!(parsed.rows.length > minRows)) out.push(`只有 ${parsed.rows.length} 檔（要 > ${minRows}）`);
  const tsmc = parsed.rows.find((r) => r.code === '2330');
  if (!tsmc || tsmc.name !== '台積電') out.push(`2330 不見了或名稱不是台積電（${tsmc?.name}）`);
  else if (!(typeof tsmc.close === 'number' && tsmc.close > 0)) out.push(`2330 收盤價不對：${tsmc.close}`);
  if (!parsed.rows.some((r) => r.code === '0050')) out.push('0050 不在表裡');
  const zero = parsed.rows.filter((r) => !r.traded && r.close === 0);
  if (zero.length) out.push(`沒成交的證券被解成 0：${zero.map((r) => r.code).join('、')}`);
  return out;
}

/** STOCK_DAY（2330、115 年 6 月）：交易日數與除權息標記。 */
export function stockDayJuneProblems(parsed) {
  const out = [];
  if (!parsed.ok) out.push(`解析失敗：${parsed.message}`);
  if (!(parsed.rows.length > 15)) out.push(`只有 ${parsed.rows.length} 個交易日`);
  const ex = parsed.rows.filter((r) => r.exMark).map((r) => r.date);
  if (!(ex.length === 1 && ex[0] === '2026-06-11')) out.push(`除權息標記對不上：${ex.join('、') || '找不到'}（要 2026-06-11）`);
  return out;
}

/** 「上櫃代號在 TWSE 查不到」的設計前提：上櫃與不存在的代號回一樣的訊息、一筆都沒有。 */
export function otcPremiseProblems(otc, nosuch) {
  const out = [];
  if (otc.ok !== false) out.push('上櫃代號查得到資料了');
  if (otc.rows.length !== 0) out.push(`上櫃代號回了 ${otc.rows.length} 筆`);
  if (otc.message !== nosuch.message) out.push(`上櫃與不存在的代號訊息不同：「${otc.message}」／「${nosuch.message}」`);
  return out;
}

/** TWT48U（除權息預告表）：格式變了（解析器拋錯）、沒資料、沒有任何一筆公告金額。 */
export function twt48uProblems(json) {
  let parsed;
  try { parsed = parseTwt48u(json); } catch (e) { return { rows: [], problems: [`格式變了：${e.message}`] }; }
  const out = [];
  if (!parsed.ok) out.push(`解析失敗：${parsed.message}`);
  if (parsed.rows.length === 0) out.push('一筆都沒有');
  else if (!parsed.rows.some((r) => r.cashPerShare != null)) out.push('沒有任何一筆公告了金額');
  return { rows: parsed.rows, problems: out };
}

/** TWT49U：參考價公式（前收 − 權值息值，捨去兩位）跟證交所公布值對不上的那幾筆。 */
export const refPriceMismatches = (rows) => rows.filter((r) => refPriceFromExValue({ prevClose: r.prevClose, exValue: r.exValue }) !== r.refPrice);

/** 日曆與 TWSE 實際成交日：少了哪幾天、多了哪幾天。 */
export function calendarDiff(mine, actual) {
  return { missing: actual.filter((d) => !mine.includes(d)), extra: mine.filter((d) => !actual.includes(d)) };
}

/** data/calendar.json 攤平成交易日（多年格式與舊格式都讀得到）。 */
export const calendarDays = (cal) => (cal.years
  ? Object.keys(cal.years).sort().flatMap((y) => cal.years[y].tradingDays ?? [])
  : (cal.tradingDays ?? []));

/** data/stocks.json 跟得上市場嗎：成交的代號表裡沒有的、標錯市場的。 */
export function stocksProblems(stocks, liveRows) {
  return {
    unknown: liveRows.filter((r) => !stocks.stocks[r.code]),
    wrongMarket: liveRows.filter((r) => stocks.stocks[r.code] && stocks.stocks[r.code].market !== '上市'),
  };
}

/** 請求節流：一個間隔都沒量到、或有間隔 < 2 秒。 */
export function gapProblems(gaps) {
  const out = [];
  if (gaps.length === 0) out.push('一個請求間隔都沒量到');
  const short = gaps.filter((g) => g < 2000);
  if (short.length) out.push(`有 ${short.length} 個間隔 < 2 秒（最短 ${Math.min(...short)} ms）`);
  return out;
}

/**
 * 一段一段跑，某一段崩了就記成那一段失敗、講出段名與例外，**後面照跑**。
 * 以前沒有這一層：日曆那段自從日曆改成多年格式就一直崩（`cal.closed is not iterable`），
 * 它後面的代號表核對、節流檢查從來沒跑到，卻沒有任何一條斷言講「這幾段沒跑」（2026-09-24 實跑發現）。
 */
export function makeStage({ section, fail }) {
  const crashed = [];
  const stage = async (name, fn) => {
    section(name);
    try { await fn(); } catch (e) {
      crashed.push(name);
      fail(`livecheck 段落崩潰：${name}`, String(e?.stack ?? e).split('\n').slice(0, 2).join(' ｜ '));
    }
  };
  return { stage, crashed };
}

/**
 * data/calendar.json 的休市日（多年格式攤平，舊的單年格式也讀得到）。
 * **兩種格式都不是就拋錯**：不能回空陣列——空的休市清單會讓「挑休市最多的月份」默默挑錯月份。
 */
export function calendarClosed(cal) {
  if (cal && cal.years && typeof cal.years === 'object') {
    return Object.keys(cal.years).sort().flatMap((y) => cal.years[y].closed ?? []);
  }
  if (cal && Array.isArray(cal.closed)) return cal.closed;
  throw new Error('data/calendar.json 的格式認不得：沒有 years，也沒有頂層的 closed');
}

/** 對照組。回傳 [{ key, name, ok, detail }]。全部用 scripts/fixtures/ 裡錄好的回應，不打網路。 */
export function controls() {
  const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const has = (list, word) => list.some((p) => p.includes(word));
  // 錄音先讀好（讀不到就讓它拋錯：那是對照組的樣本不見了，整支停下）
  const sdaText = fx('stock-day-all.csv');
  const june = JSON.parse(fx('stock-day-2330-202606.json'));
  const res = [];
  // 每一組各自包起來：判斷在改壞的錄音上崩掉，也要記成「那一組」沒過、講明例外，不讓整支崩掉、看不出是哪一組
  const run = (key, name, fn) => {
    try {
      const [good, bad, detail] = fn();
      res.push({ key, name, ok: good && bad, detail: `好的錄音${good ? '沒報' : '被誤報'}；改壞的${bad ? '報了' : '沒報'}。${detail}` });
    } catch (e) {
      res.push({ key, name, ok: false, detail: `判斷本身拋錯：${e.message}` });
    }
  };

  // 1. CORS：改壞＝標頭不見
  run('cors', 'CORS 標頭不見 → 要報', () => [corsProblem('*') === null, corsProblem(null) !== null, '']);

  // 2. STOCK_DAY_ALL：錄音只留 20 檔，所以門檻用 10；改壞＝證交所那天的表裡沒有 2330
  run('sda', 'STOCK_DAY_ALL 的表裡少了 2330 → 要報', () => {
    const good = stockDayAllProblems(parseStockDayAll(sdaText), { minRows: 10 });
    const bad = stockDayAllProblems(parseStockDayAll(sdaText.split('\n').filter((l) => !l.includes('"2330"')).join('\n')), { minRows: 10 });
    return [good.length === 0, has(bad, '2330'), `改壞的報：${bad.join('；')}`];
  });

  // 3. STOCK_DAY：改壞＝除權息那天漲跌價差欄的「X」不見（錄音裡是 "X0.00"；證交所改了標記寫法就會這樣）
  run('sd', 'STOCK_DAY 的除權息標記不見 → 要報', () => {
    const juneBad = clone(june);
    for (const row of juneBad.data) row[7] = String(row[7]).split('X').join('');
    const good = stockDayJuneProblems(parseStockDay(june));
    const bad = stockDayJuneProblems(parseStockDay(juneBad));
    return [good.length === 0, has(bad, '除權息標記'), `改壞的報：${bad.join('；')}`];
  });

  // 4. 上櫃前提：不存在的代號沒有錄音，照上櫃那份的訊息造；改壞＝上櫃代號查得到資料（拿 2330 那份當它的回應）
  run('otc', '上櫃代號查得到資料了 → 要報（設計前提變了）', () => {
    const otc = parseStockDay(JSON.parse(fx('stock-day-otc-6488.json')));
    const nosuch = { ok: false, rows: [], message: otc.message };
    const good = otcPremiseProblems(otc, nosuch);
    const bad = otcPremiseProblems(parseStockDay(june), nosuch);
    return [good.length === 0, has(bad, '查得到'), `改壞的報：${bad.join('；')}`];
  });

  // 5. TWT48U：改壞＝欄位改名（「現金股利」→「現金股息」）
  run('t48u', 'TWT48U 的欄位改名 → 要報格式變了', () => {
    const f48 = JSON.parse(fx('twt48u-forecast.json'));
    const f48Bad = clone(f48);
    f48Bad.fields = f48Bad.fields.map((f) => (f === '現金股利' ? '現金股息' : f));
    const good = twt48uProblems(f48).problems;
    const bad = twt48uProblems(f48Bad).problems;
    return [good.length === 0, has(bad, '格式變了'), `改壞的報：${bad.join('；')}`];
  });

  // 6. TWT49U 參考價：改壞＝其中一筆的公布參考價多 0.01
  run('refprice', '參考價跟公式差 0.01 → 要挑出那一筆', () => {
    const r49 = parseTwt49u(JSON.parse(fx('twt49u-result.json'))).rows;
    const r49Bad = clone(r49);
    r49Bad[0].refPrice = Math.round((r49Bad[0].refPrice + 0.01) * 100) / 100;
    const good = refPriceMismatches(r49);
    const bad = refPriceMismatches(r49Bad);
    return [r49.length > 0 && good.length === 0, bad.length === 1 && bad[0].code === r49Bad[0].code, `錄音 ${r49.length} 筆，改壞的挑出 ${bad.length} 筆`];
  });

  // 7. 日曆：好的＝data/calendar.json 的 2026-06 對錄好的 2330 當月逐日；改壞＝錄音少了 06-11 那天
  run('calendar', '證交所那個月少一個交易日 → 要報出是哪一天', () => {
    const mine = calendarDays(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/calendar.json'), 'utf8'))).filter((d) => d.startsWith('2026-06'));
    const actual = parseStockDay(june).rows.map((r) => r.date);
    const good = calendarDiff(mine, actual);
    const bad = calendarDiff(mine, actual.filter((d) => d !== '2026-06-11'));
    return [mine.length > 15 && good.missing.length + good.extra.length === 0, bad.extra.join() === '2026-06-11' && bad.missing.length === 0, `日曆 ${mine.length} 天；改壞的報：多了 ${bad.extra.join('、') || '（沒有）'}`];
  });

  // 8. 代號表：改壞＝市場上多了一檔代號表沒有的（在錄音裡加一列）
  run('stocks', '市場上多了一檔代號表沒有的 → 要報出那一檔', () => {
    const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stocks.json'), 'utf8'));
    const liveGood = parseStockDayAll(sdaText).rows;
    const extraRow = '"1150911","9999Z","合成新上市","1000","10000","10.00","10.00","10.00","10.00","0.0000","1"';
    const liveBad = parseStockDayAll(`${sdaText.trimEnd()}\n${extraRow}\n`).rows;
    const good = stocksProblems(stocks, liveGood);
    const bad = stocksProblems(stocks, liveBad);
    return [liveGood.length > 10 && good.unknown.length + good.wrongMarket.length === 0, bad.unknown.map((r) => r.code).join() === '9999Z', `改壞的報：${bad.unknown.map((r) => r.code).join('、') || '（沒有）'}`];
  });

  // 9. 節流：改壞＝有一個間隔只有 1.5 秒；一個都沒量到也要報
  run('gaps', '請求間隔 < 2 秒、或一個都沒量到 → 要報', () => {
    const good = gapProblems([2200, 2300]);
    const bad = gapProblems([2200, 1500]);
    const empty = gapProblems([]);
    return [good.length === 0, has(bad, '< 2 秒') && has(empty, '沒量到'), `改壞的報：${[...bad, ...empty].join('；')}`];
  });

  // 10. 日曆的休市日：好的＝真的 data/calendar.json（多年格式）與合成的單年格式；改壞＝兩種格式都不是
  run('calendar-closed', '日曆休市日：多年格式要讀得到，認不得的格式要拋錯', () => {
    const real = calendarClosed(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/calendar.json'), 'utf8')));
    const single = calendarClosed({ year: 2026, closed: [{ date: '2026-01-01' }] });
    let threw = false;
    try { calendarClosed({ tradingDays: [] }); } catch { threw = true; }
    return [real.length > 5 && single.length === 1, threw, `真的日曆讀到 ${real.length} 天休市；認不得的格式${threw ? '拋錯了' : '沒拋錯'}`];
  });
  return res;
}

/** 段落的對照（非同步，所以跟上面分開）：中間那段崩了，要記成那一段失敗、講出段名，後面那段照跑。 */
export async function stageControls() {
  const log = [];
  const fails = [];
  const { stage, crashed } = makeStage({ section: (n) => log.push(`段 ${n}`), fail: (msg) => fails.push(msg) });
  // stage 自己若把例外往外丟（整支停），也要記成這一組沒過，不能讓呼叫端跟著崩、看不出是哪一組
  let escaped = null;
  try {
    await stage('甲', async () => { log.push('甲跑了'); });
    await stage('乙', async () => { throw new Error('合成的崩潰'); });
    await stage('丙', async () => { log.push('丙跑了'); });
  } catch (e) { escaped = e.message; }
  const good = !escaped && crashed.join() === '乙' && fails.length === 1 && fails[0] === 'livecheck 段落崩潰：乙' && log.includes('丙跑了');
  return [{ key: 'stages', name: '中間一段崩了 → 記成那一段失敗、講出段名，後面照跑', ok: good, detail: `${escaped ? `例外被往外丟（整支停）：${escaped}；` : ''}崩了的：${crashed.join('、') || '（沒有）'}；失敗訊息：${fails.join('；')}；${log.join('、')}` }];
}
