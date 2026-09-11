// 產生 data/stocks.json（代號 → 名稱、市場、產業、證券類別）。
//
// 為什麼要有這個檔：TWSE 的 STOCK_DAY 對「上櫃代號」與「根本不存在的代號」
// 回的是**一模一樣**的 `{"stat":"很抱歉，沒有符合條件的資料!"}`（已實測 6488 與 9999）。
// 光靠端點分不出「這是上櫃、我們不支援」和「打錯字」，所以代號表必須隨 App 一起出貨。
//
// 資料來源（前四項是 PLAN §2.1 指定的；第五項 ISIN 表是補上「產業別名稱」用的，
// 因為 t187ap03_L / mopsfin_t187ap03_O 只給產業別**代碼**「24」，沒有「半導體業」）：
//   1. openapi.twse.com.tw/v1/opendata/t187ap03_L        上市公司基本資料（產業別代碼）
//   2. www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O     上櫃公司基本資料（產業別代碼）
//   3. www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL 上市當日全市場（含 ETF；決定「誰真的在上市交易」）
//   4. isin.twse.com.tw/isin/C_public.jsp?strMode=2|4|5  上市／上櫃／興櫃 ISIN 表（產業別名稱、證券類別）
//
// 產業別代碼→名稱是「join 出來的，不是背出來的」：把 (1)(2) 的代碼與 (4) 的名稱
// 依代號對起來，同一個代碼若對到兩個不同名稱就整份失敗，不猜。
//
// 這些來源都沒有 CORS（ISIN 還是 Big5），所以由開發者在本機跑、把結果 commit 進 repo。
//
// 用法：node scripts/build-stocks.mjs [--cache <目錄>]
//       --cache 會把抓到的原始回應存起來／讀回來，重跑時不必再下載 ~12MB。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStockDayAll } from '../js/twse.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GAP_MS = 2500; // 對同一個主機的連續請求間隔

const SOURCES = {
  twseCompanies: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  tpexCompanies: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
  stockDayAll: 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json',
  isinListed: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=2',
  isinOtc: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
  isinEmerging: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=5',
};

// 使用者不會「持有」權證，而且權證有三萬多筆，放進來只會把檔案撐大。
const SKIP_CATEGORIES = /認購\(售\)權證/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * ISIN 一覽表（Big5 的 HTML 表格）。
 * 只有一格的列是分類標題（「股票」「ETF」「上市認購(售)權證」…），
 * 之後的資料列都屬於那個分類，直到下一個標題為止。
 */
export function parseIsinTable(html) {
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim())
  );
  const out = [];
  let category = '';
  for (const r of rows) {
    if (r.length === 1) { category = r[0]; continue; }
    if (r.length < 6) continue;
    if (r[0] === '有價證券代號及名稱') continue;           // 標題列
    // 「2330　台積電」——分隔是全形空白，公司名稱本身可能還有空白
    const m = /^(\S+)[\s　]+(.*)$/.exec(r[0].replace(/　/g, ' ').trim());
    if (!m) continue;
    out.push({
      code: m[1].trim(),
      name: m[2].trim(),
      listedOn: r[2].trim(),
      market: r[3].trim(),
      industryName: r[4].trim() || null,
      cfi: r[5].trim(),
      category: category || null,
    });
  }
  return out;
}

/**
 * 把「代號→產業別代碼」與「代號→產業別名稱」對起來，導出代碼→名稱。
 * 同一個代碼對到兩個名稱 → 丟錯，不要猜一個出來。
 */
export function deriveIndustryNames(codeToIndustryCode, codeToIndustryName) {
  const map = new Map();      // 代碼 → Map(名稱 → 次數)
  for (const [code, ic] of codeToIndustryCode) {
    const name = codeToIndustryName.get(code);
    if (!ic || !name) continue;
    if (!map.has(ic)) map.set(ic, new Map());
    const m = map.get(ic);
    m.set(name, (m.get(name) || 0) + 1);
  }
  const result = {};
  const conflicts = [];
  for (const [ic, names] of map) {
    const entries = [...names];
    if (entries.length > 1) {
      conflicts.push(`${ic} → ${entries.map(([n, c]) => `${n}(${c})`).join('、')}`);
      continue;
    }
    result[ic] = entries[0][0];
  }
  if (conflicts.length) {
    throw new Error(`產業別代碼對到多個名稱，來源不一致：\n  ${conflicts.join('\n  ')}`);
  }
  return result;
}

async function load(name, { cacheDir, decode }) {
  const url = SOURCES[name];
  const cacheFile = cacheDir ? path.join(cacheDir, `${name}.bin`) : null;
  let buf;
  if (cacheFile && fs.existsSync(cacheFile)) {
    buf = fs.readFileSync(cacheFile);
    console.log(`  ${name}：用快取（${(buf.length / 1024).toFixed(0)} KB）`);
  } else {
    console.log(`  ${name}：抓 ${url}`);
    buf = await fetchBuf(url);
    console.log(`    ← ${(buf.length / 1024).toFixed(0)} KB`);
    if (cacheFile) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, buf); }
    await sleep(GAP_MS);
  }
  return decode === 'big5' ? new TextDecoder('big5').decode(buf) : buf.toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : null;

  console.log('抓資料來源：');
  const twseCompanies = JSON.parse(await load('twseCompanies', { cacheDir }));
  const tpexCompanies = JSON.parse(await load('tpexCompanies', { cacheDir }));
  const stockDayAllCsv = await load('stockDayAll', { cacheDir });
  const isinListed = parseIsinTable(await load('isinListed', { cacheDir, decode: 'big5' }));
  const isinOtc = parseIsinTable(await load('isinOtc', { cacheDir, decode: 'big5' }));
  const isinEmerging = parseIsinTable(await load('isinEmerging', { cacheDir, decode: 'big5' }));

  // ---- 產業別代碼 → 名稱 ----
  const codeToIndustryCode = new Map();
  for (const c of twseCompanies) codeToIndustryCode.set(String(c['公司代號']).trim(), String(c['產業別'] ?? '').trim());
  for (const c of tpexCompanies) codeToIndustryCode.set(String(c.SecuritiesCompanyCode).trim(), String(c.SecuritiesIndustryCode ?? '').trim());

  const codeToIndustryName = new Map();
  for (const r of [...isinListed, ...isinOtc, ...isinEmerging]) {
    if (r.industryName) codeToIndustryName.set(r.code, r.industryName);
  }
  const industries = deriveIndustryNames(codeToIndustryCode, codeToIndustryName);
  console.log(`\n產業別：由 ${codeToIndustryCode.size} 家公司 join 出 ${Object.keys(industries).length} 個代碼，零衝突`);

  // ---- 證券清單 ----
  const stocks = {};
  const addIsin = (rows, market) => {
    for (const r of rows) {
      if (r.category && SKIP_CATEGORIES.test(r.category)) continue;
      if (!/^[0-9A-Z]{4,6}$/.test(r.code)) continue;
      // 只放執行期真的會用到的欄位。產業別代碼不放 —— 名稱已經在這裡，
      // 多帶一個代碼會讓這個檔多 50 KB，而它每次開 App 都要從快取讀出來。
      stocks[r.code] = {
        name: r.name,
        market: r.market || market,
        industry: r.industryName || null,
        type: r.category || (market === '興櫃' ? '股票' : null),
      };
    }
  };
  addIsin(isinEmerging, '興櫃');
  addIsin(isinOtc, '上櫃');
  addIsin(isinListed, '上市');   // 上市最後寫，轉上市的公司以上市為準

  // STOCK_DAY_ALL 是「今天真的在集中市場成交的證券」，對「是不是上市」最有權威。
  const sda = parseStockDayAll(stockDayAllCsv);
  let addedFromSda = 0;
  for (const row of sda.rows) {
    const prev = stocks[row.code];
    if (!prev) {
      stocks[row.code] = { name: row.name, market: '上市', industry: null, type: null };
      addedFromSda += 1;
    } else if (prev.market !== '上市') {
      // ISIN 表說它在別的板，但它今天在集中市場成交 —— 以實際成交為準
      console.log(`  ${row.code} ${row.name}：ISIN 標「${prev.market}」，但今天在集中市場成交 → 改記上市`);
      prev.market = '上市';
    }
  }
  console.log(`STOCK_DAY_ALL（${sda.date}）：${sda.rows.length} 檔，其中 ${addedFromSda} 檔 ISIN 表沒有，補進來`);

  // ---- 出貨前的檢查：不合格就不要寫檔 ----
  const bad = [];
  const must = [
    ['2330', '上市'],
    ['6488', '上櫃'],
  ];
  for (const [code, market] of must) {
    if (!stocks[code]) bad.push(`缺少 ${code}`);
    else if (stocks[code].market !== market) bad.push(`${code} 的市場是「${stocks[code].market}」，預期「${market}」`);
  }
  const etfCount = Object.values(stocks).filter((s) => s.type === 'ETF').length;
  if (etfCount === 0) bad.push('一檔 ETF 都沒有');
  if (Object.keys(industries).length < 20) bad.push(`產業別只有 ${Object.keys(industries).length} 個，太少`);
  const noName = Object.entries(stocks).filter(([, s]) => !s.name);
  if (noName.length) bad.push(`${noName.length} 檔沒有名稱`);
  if (bad.length) throw new Error(`產出的代號表不合格，不寫檔：\n  ${bad.join('\n  ')}`);

  const byMarket = {};
  for (const s of Object.values(stocks)) byMarket[s.market] = (byMarket[s.market] || 0) + 1;

  const out = {
    generatedAt: new Date().toISOString(),
    stockDayAllDate: sda.date,
    sources: SOURCES,
    industries,
    counts: { total: Object.keys(stocks).length, byMarket, etf: etfCount },
    stocks: Object.fromEntries(Object.keys(stocks).sort().map((k) => [k, stocks[k]])),
  };

  const dest = path.join(ROOT, 'data', 'stocks.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 0), 'utf8');
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`\n寫出 ${dest}（${kb} KB）`);
  console.log(`共 ${out.counts.total} 檔：${Object.entries(byMarket).map(([m, n]) => `${m} ${n}`).join('、')}；ETF ${etfCount} 檔`);
}

if (process.argv[1] && process.argv[1].endsWith('build-stocks.mjs')) {
  main().catch((e) => { console.error('✗ ' + (e.stack || e.message)); process.exit(1); });
}
