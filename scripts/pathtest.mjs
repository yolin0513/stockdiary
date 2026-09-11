// 真實使用路徑端對端（npm run pathtest）。
//
// scenariotest 測的是「資料長得很奇怪的那幾天」。這一支測的是**一般人真的會走到的那幾條路**，
// 而且每一條都是整個 App 一起跑（真的 IndexedDB、真的 Service Worker、真的路由）：
//
//   1. 第一次開啟：全新裝置、一筆資料都沒有
//   2. 只有一檔持股（很多人就是這樣開始的）
//   3. 跨月：上次結算在上個月，今天在這個月
//   4. 長假後回補：缺一整排交易日
//   5. 網路很慢：更新還在跑的時候，畫面不可以看起來像當掉
//   6. 離線：**真的把伺服器關掉**（`page.setOfflineMode` 管不到 Service Worker 自己的 fetch）
//   7. 上游掛掉：TWSE 回 500 或回一頁 HTML
//
// 共同的驗收條件只有兩條，但每一條路都要成立：
//   · **不可以出現編出來的數字**（沒有就是「—」，不是 0）
//   · **畫面要講得出現在發生什麼事**（不是一片空白，也不是永遠轉圈）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf, note } from './tap.mjs';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay, DEFAULT_TODAY_THRESHOLD } from '../js/market.js';
import { isoToRocCompact, isoToRocSlash } from '../js/roc.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const cal = makeCalendar(calJson);

const TODAY = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
section('測試前提');
ok(TODAY != null, `應公布的最新交易日：${TODAY}`, 'data/calendar.json 可能過期了 → npm run build-calendar');
if (!TODAY) done('pathtest');
const DAYS = calJson.tradingDays.filter((d) => d <= TODAY);
const PREV = DAYS.at(-2);
ok(PREV != null, `前一個交易日：${PREV}`);

// 上個月的最後一個交易日（跨月情境用）
const THIS_MONTH = TODAY.slice(0, 7);
const PREV_MONTH_DAYS = DAYS.filter((d) => d.slice(0, 7) < THIS_MONTH);
// **上個月中間**的某一天，不是最後一天：缺漏是「這一天之後」的日子，
// 停在上個月最後一天的話缺的全部落在這個月，那就不叫跨月了。
const PREV_MONTH_MID = PREV_MONTH_DAYS.at(-4) ?? PREV_MONTH_DAYS.at(0);
ok(PREV_MONTH_MID != null && PREV_MONTH_MID.slice(0, 7) < THIS_MONTH,
  `上次結算停在上個月的 ${PREV_MONTH_MID}`);

// ---------------------------------------------------------------------------
// 假回應

const CSV_HEADER = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
const dayAllCsv = (date, rows) => `${[CSV_HEADER, ...rows.map(([c, n, close, chg]) =>
  `"${isoToRocCompact(date)}","${c}","${n}","1000","1000","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${chg}","10"`)].join('\n')}\n`;

const SD_FIELDS = ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'];
/** 某一檔某一個月的 STOCK_DAY 回應。價格用 base + 交易日序號，每天都不一樣才看得出拿錯天。 */
function stockDayJson(code, name, month, base) {
  const days = calJson.tradingDays.filter((d) => d.startsWith(month) && d <= TODAY);
  return {
    stat: 'OK',
    title: `${month.slice(0, 4) - 1911}年${month.slice(5, 7)}月 ${code} ${name}  各日成交資訊`,
    fields: SD_FIELDS,
    data: days.map((d, i) => {
      const close = base + i;
      return [isoToRocSlash(d), '1,000', '1,000', close.toFixed(2), close.toFixed(2),
        close.toFixed(2), close.toFixed(2), '1.0000', '10', ''];
    }),
    total: days.length,
  };
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
let { srv, port } = await listen(0);
const pageErrors = [];

/**
 * 開一個乾淨的頁面。
 *
 * `plan` 決定 TWSE 的每一個端點怎麼回應：
 *   dayAll: csv 字串 ｜ { status } ｜ { body } ｜ null（回「沒有資料」）
 *   stockDay: (code, month) => json ｜ { status }
 *   delayMs: 每個 TWSE 請求延遲幾毫秒（模擬慢網路）
 *
 * ⚠ 清資料要清 `db.STORE_NAMES` 全部（`settle`／`closes` 不在 EXPORTABLE_STORES 裡），
 * 而且**清完一定要 reload** —— 開機那一次 update() 會把「已結算到今天」記在記憶體裡。
 */
async function freshApp(plan = {}, { seed = null } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) pageErrors.push(m.text()); });

  await page.evaluateOnNewDocument((p) => {
    const real = window.fetch.bind(window);
    window.__calls = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes('twse.com.tw')) return real(input, init);
      window.__calls.push({ url, at: Date.now() });
      // 真的離線：改去打本機那個已經關掉的埠，讓瀏覽器丟出真正的網路錯誤。
      // （自己 throw 一個假的 Error 等於在測自己寫的字串。）
      if (window.__offline) return real(`${location.origin}/__offline_probe__?u=${encodeURIComponent(url)}`, { cache: 'no-store' });
      if (p.delayMs) await sleep(p.delayMs);
      if (p.hardFail) return new Response('<html><body>503 Service Unavailable</body></html>', { status: 503 });
      if (url.includes('STOCK_DAY_ALL')) {
        if (p.dayAllStatus) return new Response('', { status: p.dayAllStatus });
        if (p.dayAllHtml) return new Response('<html><h1>Error</h1></html>', { status: 200 });
        return p.dayAll ? new Response(p.dayAll, { status: 200 }) : json({ stat: '很抱歉，沒有符合條件的資料!' });
      }
      if (url.includes('TWT48U') || url.includes('TWT49U')) return json({ stat: 'OK', fields: [], data: [] });
      if (url.includes('STOCK_DAY')) {
        const code = /stockNo=([^&]+)/.exec(url)?.[1];
        const date = /date=(\d{8})/.exec(url)?.[1];
        const month = `${date?.slice(0, 4)}-${date?.slice(4, 6)}`;
        const hit = (p.stockDay ?? []).find((x) => x.code === code && x.month === month);
        return hit ? json(hit.json) : json({ stat: '很抱歉，沒有符合條件的資料!', total: 0 });
      }
      return json({});
    };
  }, plan);

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    for (const s of db.STORE_NAMES) await db.clear(s);
  });
  if (seed) await page.evaluate(seed, { TODAY, PREV, PREV_MONTH_MID });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');
  return page;
}

/** 畫面上「像金額或價格的數字」。用來斷言「沒有編出來的數字」。 */
const NUMBERS_IN = (t) => (String(t).match(/[+-]?\d[\d,]*(?:\.\d+)?/g) ?? []);

try {
  // =========================================================================
  section('路徑 1：第一次開啟（全新裝置，一筆資料都沒有）');
  {
    const page = await freshApp({ dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]) });
    const r = await page.evaluate(async () => {
      const store = await import('./js/store.js');
      const upd = await store.update({ force: true });
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((x) => setTimeout(x, 300));
      const view = document.querySelector('#view');
      return {
        status: upd?.status,
        message: upd?.message,
        calls: window.__calls.map((c) => c.url),
        text: view.textContent.replace(/\s+/g, ' ').trim(),
        cards: view.querySelectorAll('.card').length,
        // 「怎麼開始」的入口：任何一個按鈕或連結帶得到持股頁
        entries: [...view.querySelectorAll('a[href], button')].map((el) => ({
          label: el.textContent.trim().slice(0, 20),
          href: el.getAttribute('href') ?? null,
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        })),
        numberNodes: [...view.querySelectorAll('.num, .big-number, .mid-number')]
          .map((el) => el.textContent.trim()).filter((t) => /\d/.test(t)),
        tabs: [...document.querySelectorAll('#tabbar .tab')].map((t) => t.textContent.trim()),
      };
    });

    eq(r.status, 'noHoldings', '沒有持股也沒有計畫 → 狀態就是「還沒有持股」');
    ok(r.cards >= 2, `畫面上有 ${r.cards} 張卡片 —— 不是一片空白`);
    // **一個 TWSE 請求都不該打。** 沒有持股就沒有要算的東西，打了是白打，
    // 而且第一次開 App 的人最可能在網路差的地方（剛裝好、還在外面）。
    eq(r.calls.filter((u) => u.includes('twse.com.tw')).length, 0,
      '**一個 TWSE 請求都沒有打** —— 沒有持股就沒有東西要算');
    ok(r.text.includes('還沒有持股') || r.text.includes('尚未結算'),
      `畫面講得出現在是什麼狀態：「${r.text.slice(0, 60)}」`);
    // 不可以有任何看起來像金額的東西
    // 只看「數字節點」（.num／.big-number／.mid-number）—— 資料狀態卡裡的
    // 「2026 年、243 個交易日」是說明不是金額，拿整頁文字去掃會誤判。
    eq(r.numberNodes, [], `全新裝置的畫面上一個數字節點都沒有（實際 ${JSON.stringify(r.numberNodes)}）`);
    // 找得到「怎麼開始」
    const start = r.entries.filter((e) => /holdings|持股/.test(`${e.href} ${e.label}`));
    ok(start.length > 0, `找得到開始的入口：${JSON.stringify(start.map((e) => e.label))}`);
    everyOf(start, (e) => e.h >= 44, `入口的觸控區都 ≥44px（${start.map((e) => `${e.label} ${e.h}px`).join('、')}）`);
    ok(r.tabs.length >= 4, `底部分頁有 ${r.tabs.length} 格：${r.tabs.join('、')}`);
    await page.close();
  }

  // =========================================================================
  section('路徑 2：只有一檔持股');
  {
    const page = await freshApp({ dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]) });
    const r = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const store = await import('./js/store.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
      await db.put('closes', { code: '2330', date: args.PREV, close: 2450 });
      const upd = await store.update({ force: true });
      const settle = await db.get('settle', args.TODAY);
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((x) => setTimeout(x, 300));
      const homeText = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
      const hv = await import('./js/views/holdings.js');
      await hv.default();
      await new Promise((x) => setTimeout(x, 300));
      const view = document.querySelector('#view');
      return {
        status: upd?.status,
        dayPL: settle?.dayPL ?? null,
        counted: settle?.counted ?? null,
        homeText,
        holdingsText: view.textContent.replace(/\s+/g, ' '),
        bars: [...view.querySelectorAll('.bar-row')].map((b) => ({
          industry: b.dataset.industry,
          pct: b.querySelector('.bar-pct')?.textContent,
          fill: b.querySelector('.bar-fill')?.style.width,
        })),
      };
    }, { TODAY, PREV });

    eq(r.status, 'settled', '一檔也照樣結算得出來');
    eq(r.counted, 1, '算進去的就是那一檔');
    // 手算：(2410 − 2450) × 1000 ＝ −40,000 元
    eq(r.dayPL, '-40000000000', '手算 (2410 − 2450) × 1000 ＝ −40,000 元');
    ok(r.homeText.includes('-40,000'), `首頁顯示 −40,000：「${/當日損益[^市]*/.exec(r.homeText)?.[0]?.slice(0, 40)}」`);
    // 集中度只有一個產業 → 100%，不可以是 NaN 或 0
    eq(r.bars.length, 1, '產業分布只有一條');
    eq(r.bars[0].pct, '100.0%', '只有一檔就是 100.0%（不是 NaN、不是 0）');
    eq(r.bars[0].fill, '100%', '條狀圖也畫滿');
    noneOf([r.holdingsText], (t) => /NaN|Infinity|undefined|null/.test(t),
      '畫面上沒有 NaN／Infinity／undefined');
    await page.close();
  }

  // =========================================================================
  section('路徑 3：跨月（上次結算在上個月）');
  {
    const prevMonth = PREV_MONTH_MID.slice(0, 7);
    const page = await freshApp({
      dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]),
      stockDay: [
        { code: '2330', month: prevMonth, json: stockDayJson('2330', '台積電', prevMonth, 2300) },
        { code: '2330', month: THIS_MONTH, json: stockDayJson('2330', '台積電', THIS_MONTH, 2400) },
      ],
    }, {
      seed: async (args) => {
        const db = await import('./js/db.js');
        const holdings = await import('./js/holdings.js');
        await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
        // 上次結算停在上個月最後一個交易日
        await db.put('settle', {
          date: args.PREV_MONTH_MID, dayPL: '0', marketValue: null, dividend: null,
          counted: 1, excludedUnsupported: 0, excludedMissing: 0,
          byCode: [{ code: '2330', shares: 1000, close: 2300, basis: 2300, basisSource: 'prevClose', status: 'ok', pl: '0' }],
          settledAt: new Date().toISOString(),
        });
      },
    });

    const r = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const store = await import('./js/store.js');
      // **要測的就是開機那一次**（種好資料之後 reload，App 自己會跑）。
      // 不帶 force 會拿到同一個 promise，等它跑完就好；再 force 一次的話，
      // 量到的是「已經補完之後再跑一次」，那一次當然什麼都不用抓。
      const upd = await store.update();
      const before = 0;
      const settles = (await db.getAll('settle')).map((x) => x.date).sort();
      return {
        status: upd?.status,
        message: upd?.message,
        problems: upd?.problems ?? [],
        settles,
        monthUrls: window.__calls.slice(before).map((c) => c.url).filter((u) => /STOCK_DAY\?/.test(u))
          .map((u) => `${/stockNo=([^&]+)/.exec(u)?.[1]}@${/date=(\d{6})/.exec(u)?.[1]}`),
      };
    });

    note(`回補請求：${r.monthUrls.join('、') || '（無）'}`);
    ok(['settled', 'partial'].includes(r.status), `狀態是 ${r.status}：${r.message}`);
    // 兩個月份各抓一次，同一個月不會抓兩次
    eq([...new Set(r.monthUrls)].length, r.monthUrls.length,
      `同一檔同一個月只抓一次（${r.monthUrls.length} 個請求）`);
    ok(r.monthUrls.length >= 2, `**跨月要抓兩個月份**（實際 ${r.monthUrls.length} 個）`);
    const months = new Set(r.monthUrls.map((x) => x.split('@')[1]));
    eq(months.size, 2, `抓到的月份有兩個：${[...months].join('、')}`);
    ok(r.settles.includes(TODAY), `補到今天（${TODAY}）：結算日有 ${r.settles.length} 天`);
    ok(r.settles.at(-1) === TODAY, '最後一天就是今天');
    await page.close();
  }

  // =========================================================================
  section('路徑 3b：開 App 的頭幾秒就新增持股 —— 不可以送出雙倍請求');
  // 新增持股、儲存計畫、按重新整理都會 store.update({ force: true })，
  // 而開機那一次通常還在飛。兩次並行跑的話，同一檔同一個月會被抓兩次。
  // TWSE 連打是會被封 IP 的（STATUS「最容易做錯的事」第 7 條）。
  {
    const prevMonth = PREV_MONTH_MID.slice(0, 7);
    const page = await freshApp({
      delayMs: 800,                      // 讓開機那一次還在跑
      dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]),
      stockDay: [
        { code: '2330', month: prevMonth, json: stockDayJson('2330', '台積電', prevMonth, 2300) },
        { code: '2330', month: THIS_MONTH, json: stockDayJson('2330', '台積電', THIS_MONTH, 2400) },
      ],
    }, {
      seed: async (args) => {
        const db = await import('./js/db.js');
        const holdings = await import('./js/holdings.js');
        await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
        await db.put('settle', {
          date: args.PREV_MONTH_MID, dayPL: '0', marketValue: null, dividend: null,
          counted: 1, excludedUnsupported: 0, excludedMissing: 0,
          byCode: [{ code: '2330', shares: 1000, close: 2300, basis: 2300, basisSource: 'prevClose', status: 'ok', pl: '0' }],
          settledAt: new Date().toISOString(),
        });
      },
    });

    const r = await page.evaluate(async () => {
      const store = await import('./js/store.js');
      // 不等開機那一次跑完就 force —— 這就是「剛打開就按新增持股」的時序
      const forced = store.update({ force: true });
      await Promise.all([store.update(), forced]);
      const urls = window.__calls.map((c) => c.url);
      const monthly = urls.filter((u) => /STOCK_DAY\?/.test(u))
        .map((u) => `${/stockNo=([^&]+)/.exec(u)?.[1]}@${/date=(\d{6})/.exec(u)?.[1]}`);
      return { monthly, dayAll: urls.filter((u) => u.includes('STOCK_DAY_ALL')).length, total: urls.length };
    });

    note(`並行期間打出去的月份請求：${r.monthly.join('、') || '（無）'}`);
    ok(r.monthly.length > 0, `（對照）這個情境真的有回補（${r.monthly.length} 個月份請求）`);
    eq([...new Set(r.monthly)].length, r.monthly.length,
      `**同一檔同一個月只抓一次**，沒有因為兩次更新並行而變成雙倍（${r.monthly.join('、')}）`);
    ok(r.total <= 30, `總請求數仍在一次開頁 30 個的上限內（${r.total} 個）`);
    await page.close();
  }

  // =========================================================================
  section('路徑 4：長假後連續多天回補');
  {
    // 回到 10 個交易日前
    const back = DAYS.at(-11) ?? DAYS[0];
    const missingCount = DAYS.filter((d) => d > back).length;
    const months = [...new Set(DAYS.filter((d) => d > back).map((d) => d.slice(0, 7)))];
    const page = await freshApp({
      dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]),
      stockDay: months.map((m) => ({ code: '2330', month: m, json: stockDayJson('2330', '台積電', m, 2400) })),
    });
    // 起點：10 個交易日前已經結算過，之後全部是缺的
    await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
      await db.put('settle', {
        date: args.back, dayPL: '0', marketValue: null, dividend: null,
        counted: 1, excludedUnsupported: 0, excludedMissing: 0,
        byCode: [{ code: '2330', shares: 1000, close: 2400, basis: 2400, basisSource: 'prevClose', status: 'ok', pl: '0' }],
        settledAt: new Date().toISOString(),
      });
    }, { back });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#view .card');

    const r = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const store = await import('./js/store.js');
      const progress = [];
      // 同路徑 3：測的是開機那一次。它已經在跑了，onProgress 要在它開始前掛上 ——
      // 所以改成等它結束後再看「這次總共打了幾個請求」，進度另外用一次強制更新量。
      const upd = await store.update();
      const settles = (await db.getAll('settle')).map((x) => x.date).sort();
      return {
        status: upd?.status,
        message: upd?.message,
        problems: upd?.problems ?? [],
        settles: settles.filter((d) => d > args.back),
        totalCalls: window.__calls.length,
      };
    }, { back });

    // 進度回報：開機那一次已經補完了，所以把結算倒回起點再跑一次強制更新 ——
    // 這一次才掛得上 onProgress。倒回去跑得出一樣的結果，本身也是一條驗證。
    const prog = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const store = await import('./js/store.js');
      await db.clear('settle');
      await db.put('settle', {
        date: args.back, dayPL: '0', marketValue: null, dividend: null,
        counted: 1, excludedUnsupported: 0, excludedMissing: 0,
        byCode: [{ code: '2330', shares: 1000, close: 2400, basis: 2400, basisSource: 'prevClose', status: 'ok', pl: '0' }],
        settledAt: new Date().toISOString(),
      });
      const seen = [];
      const upd = await store.update({ force: true, onProgress: (x) => seen.push(x) });
      const settles = (await db.getAll('settle')).map((d) => d.date).sort();
      return { labels: seen.map((x) => x.label), status: upd?.status, refilled: settles.filter((d) => d > args.back).length };
    }, { back });

    note(`回補進度回報了 ${prog.labels.length} 次：${prog.labels.slice(0, 3).join('、')}…`);
    ok(['settled', 'partial'].includes(r.status), `狀態 ${r.status}：${r.message}`);
    eq(r.settles.length, missingCount, `缺的 ${missingCount} 天全部補上（實際 ${r.settles.length} 天）`);
    everyOf(r.settles, (d) => DAYS.includes(d), '補出來的每一天都是交易日（沒有補到週末）');
    ok(r.totalCalls <= 30, `**請求數在一次開頁 30 個的上限內**（實際 ${r.totalCalls} 個）`);
    ok(prog.labels.length >= 2,
      `回補過程有回報進度，畫面才不會看起來像當掉（${prog.labels.length} 次）`);
    everyOf(prog.labels, (l) => l.length > 0, '每一次進度都帶得出在做什麼，不是空字串');
    ok(prog.labels.some((l) => l.includes('回補')), `進度講得出正在回補哪一檔哪個月：「${prog.labels[0]}」`);
    eq(prog.refilled, missingCount, '（對照）倒回起點再跑一次，補出來的天數一樣');
    await page.close();
  }

  // =========================================================================
  section('路徑 5：網路很慢');
  {
    const page = await freshApp({
      delayMs: 2500,
      dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]),
    });
    const r = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const store = await import('./js/store.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
      await db.put('closes', { code: '2330', date: args.PREV, close: 2450 });

      const home = await import('./js/views/home.js');
      const t0 = Date.now();
      const p = store.update({ force: true });
      // 更新還在飛的時候看一眼畫面
      await new Promise((x) => setTimeout(x, 600));
      await home.default();
      await new Promise((x) => setTimeout(x, 200));
      const duringText = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
      const duringNums = (duringText.match(/[+-]?\d[\d,]*(?:\.\d+)?/g) ?? []);
      const upd = await p;
      const ms = Date.now() - t0;
      await home.default();
      await new Promise((x) => setTimeout(x, 200));
      return {
        ms,
        status: upd?.status,
        duringText,
        duringNums,
        afterText: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    }, { PREV });

    ok(r.ms >= 2000, `更新真的被拖慢了（${r.ms}ms）—— 這個情境才成立`);
    eq(r.status, 'settled', '慢歸慢，最後還是算得出來');
    // 更新中的畫面**不可以顯示一個假的當日損益**（例如 0）
    ok(/當日損益[^0-9+-]*—/.test(r.duringText) || !/當日損益[^市]*[+-]?[\d,]{2,}/.test(r.duringText),
      `更新還沒完成時，當日損益是「—」不是數字：「${/當日損益[^市]{0,24}/.exec(r.duringText)?.[0]}」`);
    ok(r.duringText.includes('尚未結算') || r.duringText.includes('尚未更新') || r.duringText.includes('更新'),
      `而且講得出「還在跑／還沒結算」：「${r.duringText.slice(0, 70)}」`);
    ok(r.afterText.includes('-40,000'), '跑完之後數字才出現');
    await page.close();
  }

  // =========================================================================
  section('路徑 6：離線（真的把伺服器關掉）');
  {
    // 先正常開一次，讓 Service Worker 接手並把殼存進快取
    const page = await freshApp({ dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]) });
    await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
      await db.put('closes', { code: '2330', date: args.PREV, close: 2450 });
    }, { PREV });
    const swReady = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
      return !!navigator.serviceWorker.controller;
    });
    ok(swReady, 'Service Worker 已經接手（離線的前提）');

    // 前一天已經算好了，今天**還沒有**結算 —— 這樣離線時的 update() 才真的需要網路。
    // （原本這裡先把今天也算好，於是 update() 直接回「已是最新」，等於沒測到離線。）
    await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      await db.clear('settle');
      await db.put('settle', {
        date: args.PREV, dayPL: '-23456000000', marketValue: '2450000000000', dividend: null,
        counted: 1, excludedUnsupported: 0, excludedMissing: 0,
        byCode: [{ code: '2330', shares: 1000, close: 2450, basis: 2473.456, basisSource: 'prevClose', status: 'ok', pl: '-23456000000' }],
        settledAt: new Date().toISOString(),
      });
    }, { PREV });

    // **真的關掉伺服器。** page.setOfflineMode 管不到 Service Worker 自己發的 fetch。
    // 同時把假 fetch 切到「離線」：不然 TWSE 那幾個請求照樣會被假資料餵飽，
    // 離線就只測到殼，測不到「拿不到資料時畫面怎麼講」。
    await page.evaluate(() => { window.__offline = true; });
    await page.evaluateOnNewDocument(() => { window.__offline = true; });
    // 離線期間**本來就會**有一堆 net::ERR_FAILED（那正是「真的斷線」的證據）。
    // 從這裡開始另外收，結束時單獨檢查：只能有網路錯誤，不可以有程式的例外。
    const errorsBeforeOffline = pageErrors.length;
    await new Promise((r) => srv.close(r));
    // 對照組要從 **Node 這一端**打 —— 在頁面裡打會被 Service Worker 從快取回答，
    // 看起來像「還連得到」，那條對照就失去意義了（踩過）。
    let reachable = true;
    try {
      await fetch(`http://localhost:${port}/index.html?x=${Date.now()}`, { cache: 'no-store' });
    } catch { reachable = false; }
    eq(reachable, false, '（對照）伺服器真的關掉了 —— 從瀏覽器外面連不到');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const off = await page.evaluate(async () => {
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector('#view .card')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const store = await import('./js/store.js');
      const upd = await store.update({ force: true }).catch((e) => ({ status: 'threw', message: String(e.message || e) }));
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((r) => setTimeout(r, 300));
      const text = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
      // 離線也要進得去別的頁（那些 view 是動態 import 的）
      location.hash = '#/holdings';
      for (let i = 0; i < 80; i += 1) {
        if (document.getElementById('topTitle')?.textContent === '持股') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const holdingsTitle = document.getElementById('topTitle')?.textContent;
      const db = await import('./js/db.js');
      return {
        cards: document.querySelectorAll('#view .card').length,
        status: upd?.status,
        message: upd?.message ?? '',
        text,
        holdingsTitle,
        settleDates: (await db.getAll('settle')).map((x) => x.date).sort(),
      };
    });

    ok(off.cards > 0, `離線重載之後畫面還在（${off.cards} 張卡片）`);
    eq(off.holdingsTitle, '持股', '離線時動態載入的持股頁也打得開');
    ok(['failed', 'partial'].includes(off.status) || /失敗|連|網路/.test(off.message),
      `更新失敗，而且講得出原因：「${off.message}」（狀態 ${off.status}）`);
    // 最重要的兩條：不可以編出今天的數字，也不可以把昨天的洗掉
    eq(off.settleDates.includes(TODAY), false,
      `**離線時沒有硬生出今天的結算**（資料庫裡只有 ${off.settleDates.join('、')}）`);
    ok(off.text.includes('-23,456'), '**上次算好的數字還在**（−23,456），沒有變成 0 或空白');
    ok(off.text.includes(`結算日：${Number(PREV.slice(5, 7))}/${Number(PREV.slice(8, 10))}`),
      `而且畫面明講那是 ${PREV} 的數字，不是今天的：「${/結算日：[^持]{0,10}/.exec(off.text)?.[0]}」`);
    const offlineErrors = pageErrors.splice(errorsBeforeOffline);
    ok(offlineErrors.length > 0,
      `（對照）離線期間真的產生了 ${offlineErrors.length} 筆網路錯誤 —— 不是「剛好都沒事」`);
    everyOf(offlineErrors, (e) => /ERR_FAILED|ERR_CONNECTION|Failed to fetch|NetworkError/.test(e),
      '離線期間的錯誤**全部是網路錯誤**，沒有任何程式例外');
    await page.close();

    // 伺服器再開起來（後面的情境還要用）
    const again = await listen(0);
    srv = again.srv;
    port = again.port;
  }

  // =========================================================================
  section('路徑 7：上游掛掉（TWSE 回 503 / 回一頁 HTML）');
  {
    for (const [label, plan] of [
      ['503', { hardFail: true }],
      ['回一頁 HTML', { dayAllHtml: true }],
    ]) {
      const page = await freshApp(plan);
      const r = await page.evaluate(async (args) => {
        const db = await import('./js/db.js');
        const holdings = await import('./js/holdings.js');
        const store = await import('./js/store.js');
        await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 2000, date: '2026-01-05' });
        await db.put('closes', { code: '2330', date: args.PREV, close: 2450 });
        // 昨天已經算好了 —— 上游掛掉不可以把它洗掉
        await db.put('settle', {
          date: args.PREV, dayPL: '-12345000000', marketValue: '2450000000000', dividend: null,
          counted: 1, excludedUnsupported: 0, excludedMissing: 0,
          byCode: [{ code: '2330', shares: 1000, close: 2450, basis: 2462.345, basisSource: 'prevClose', status: 'ok', pl: '-12345000000' }],
          settledAt: new Date().toISOString(),
        });
        const upd = await store.update({ force: true }).catch((e) => ({ status: 'threw', message: String(e.message || e) }));
        const home = await import('./js/views/home.js');
        await home.default();
        await new Promise((x) => setTimeout(x, 300));
        return {
          status: upd?.status,
          message: upd?.message ?? '',
          todaySettle: await db.get('settle', args.TODAY),
          prevStillThere: !!(await db.get('settle', args.PREV)),
          text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
        };
      }, { TODAY, PREV });

      ok(['failed', 'todayPending', 'partial'].includes(r.status),
        `【${label}】狀態是 ${r.status}，不是假裝成功`);
      ok(r.message.length > 4, `【${label}】訊息講得出發生什麼事：「${r.message}」`);
      eq(r.todaySettle, undefined, `【${label}】**今天沒有被寫進一筆假的結算**`);
      eq(r.prevStillThere, true, `【${label}】昨天算好的結算還在，沒有被洗掉`);
      ok(r.text.includes('-12,345'), `【${label}】畫面顯示的是昨天那個真的數字`);
      noneOf([r.text], (t) => /當日損益\s*0\b/.test(t), `【${label}】當日損益沒有變成 0`);
      await page.close();
    }
  }

  // 路徑 7 的 503 是刻意回的，瀏覽器不會記成 console error；這裡剩下的應該一個都沒有。
  eq(pageErrors.filter((e) => !/favicon/.test(e)), [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  try { srv.close(); } catch { /* 已經關掉了 */ }
}

done('pathtest');
