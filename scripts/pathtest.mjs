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
// calendar.json 是多年格式（{ years: { "2026": {...} } }），沒有頂層的 tradingDays。
// makeCalendar 同時讀得懂新舊兩種格式，所以一律從它的 days 拿。
const ALL_TRADING_DAYS = cal.days;

const TODAY = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
section('測試前提');
ok(TODAY != null, `應公布的最新交易日：${TODAY}`, 'data/calendar.json 可能過期了 → npm run build-calendar');
if (!TODAY) done('pathtest');
const DAYS = ALL_TRADING_DAYS.filter((d) => d <= TODAY);
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
  const days = ALL_TRADING_DAYS.filter((d) => d.startsWith(month) && d <= TODAY);
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
      // 換掉交易日曆 —— 驗「日曆快用完」與「已經跨年」用的。
      // 與其偽造 Date（會連動整個 App 的時間判斷），不如給一份真的快用完的日曆：
      // 驗到的是同一件事，而且更接近真實的失敗樣子。
      // 開機時的靜態資料請求**永遠不回來**，而且不理 AbortSignal ——
      // 模擬 iOS 在 SW 剛換手時吊死的 fetch。真的吊死的請求正是這個樣子。
      if (p.hangData && /data\/(calendar|stocks|dividends)\.json/.test(url)) return new Promise(() => {});
      if (p.calendarJson && url.includes('data/calendar.json')) return json(p.calendarJson);
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
    // v0.7.12 起總覽不再有「資料狀態」那張卡（搬去設定頁），所以「還沒有持股」
    // 這句話已經不在總覽上了。要驗的其實是**他知不知道現在該做什麼** ——
    // 改成驗語意，不要比對某一句隨時會被搬走的字串。
    ok(/開始使用|還沒有持股|尚未結算/.test(r.text),
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
    // 母體是**一個字串**，所以它是空字串的時候這條也會通過 ——
    // 持股頁沒渲染出來的話，「沒有 NaN」就變成一句空話。先證明那一頁有東西。
    ok(r.holdingsText.length > 20 && r.holdingsText.includes('2330'),
      `（前提）持股頁真的畫出來了，共 ${r.holdingsText.length} 字`,
      r.holdingsText.slice(0, 200));
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
    // 回到 30 個交易日前 —— **要跨月**。
    // 只回到 10 個交易日前的話多半還在同一個月，只有一個月份要補，
    // 進度的 total 就是 1，而「total > 1 才顯示」是刻意的
    //（單一請求一閃而過，畫出來只會讓畫面抖一下）。
    // 真正的「長假之後回來」本來就會跨月，這樣才驗得到進度真的畫在畫面上。
    const back = DAYS.at(-31) ?? DAYS[0];
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

    // ---- 進度要真的出現在**畫面上**（A9）----
    //
    // 上面那幾條驗的是 onProgress 這個函式有被呼叫 —— 但那份進度以前**沒有人接**：
    // app.js 開機那次與設定頁的重新整理都沒傳 onProgress，所以算好的進度沒有任何
    // 畫面看得到。這正是慣例 20 的形狀：契約的兩端只測了一端。
    //
    // 所以這裡在回補進行中**取樣畫面**（慣例 20：要在空窗中間取樣，不是事後看結果）。
    const painted = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const store = await import('./js/store.js');
      const home = await import('./js/views/home.js');

      await db.clear('settle');
      await db.put('settle', {
        date: args.back, dayPL: '0', marketValue: null, dividend: null,
        counted: 1, excludedUnsupported: 0, excludedMissing: 0,
        byCode: [{ code: '2330', shares: 1000, close: 2400, basis: 2400, basisSource: 'prevClose', status: 'ok', pl: '0' }],
        settledAt: new Date().toISOString(),
      });

      // 先把總覽畫出來，那一行才在畫面上（progressLine 靠訂閱自己更新文字）
      location.hash = '#/';
      await home.default();
      await new Promise((r) => setTimeout(r, 100));
      const el = () => document.querySelector('#view [data-note="updateProgress"]');
      const beforeText = el()?.textContent ?? null;
      const beforeHidden = el()?.hidden ?? null;

      const seen = [];
      const timer = setInterval(() => {
        const n = el();
        if (n && !n.hidden && n.textContent) seen.push(n.textContent);
      }, 15);
      await store.update({ force: true });
      clearInterval(timer);
      await new Promise((r) => setTimeout(r, 50));

      return {
        nodeExists: !!el(),
        beforeText, beforeHidden,
        seen: [...new Set(seen)],
        afterText: el()?.textContent ?? null,
        afterHidden: el()?.hidden ?? null,
        progressAfter: store.progress(),
      };
    }, { back });

    ok(painted.nodeExists, '總覽上有一個放回補進度的位置');
    eq(painted.beforeText, '', '（前提）開始之前那一行是空的');
    eq(painted.beforeHidden, true, '（前提）而且是藏起來的 —— 沒在回補時不佔版面');
    ok(painted.seen.length > 0,
      `回補進行中，畫面上真的出現過進度（取樣到 ${painted.seen.length} 種文字）`,
      '一次都沒取樣到 —— onProgress 可能又沒有接上畫面');
    ok(painted.seen.some((t) => /回補中 \d+\/\d+/.test(t)),
      `而且是「回補中 N/M」的樣子：「${painted.seen[0]}」`);
    ok(painted.seen.some((t) => /2330/.test(t)),
      `講得出正在補哪一檔：「${painted.seen.find((t) => /2330/.test(t))}」`);
    // 分母要對得上實際要補的月份數。
    //
    // 不驗「看到幾種文字」：最後一步 done === total，而顯示條件是 done < total，
    // 所以「2/2」本來就不會出現；而中間狀態取樣抓不抓得到取決於機器快慢 ——
    // 那種斷言在忙碌的機器上會偶發失敗，是假斷言的另一種形狀。
    everyOf(painted.seen, (t) => new RegExp(`回補中 \\d+/${months.length}`).test(t),
      `分母是實際要補的月份數 ${months.length}（看到：${painted.seen.join('、')}）`);
    everyOf(painted.seen, (t) => {
      const m = /回補中 (\d+)\/(\d+)/.exec(t);
      return m && Number(m[1]) < Number(m[2]);
    }, '顯示出來的每一筆進度都還沒做完（done < total）—— 做完就該收起來');
    // 結束之後要收乾淨，不然畫面會一直掛著「回補中 12/12」，看起來像卡住
    eq(painted.afterText, '', '跑完之後那一行清空了');
    eq(painted.afterHidden, true, '也藏回去了 —— 不會一直掛著「回補中 12/12」');
    // **這一條要單獨驗 store 的狀態。**
    // 上面兩條看的是畫面，而畫面在「跑完」時本來就是空的：最後一筆進度是
    // done === total，而顯示條件是 done < total。所以「進度沒被清掉」這件事
    // 在畫面上看不出來 —— 兩種原因長得一模一樣。
    // 不補這一條的話，「跑完不收起來」那條突變不會紅（實際驗過）。
    eq(painted.progressAfter, null,
      '跑完之後 store 裡的進度也清掉了（不是只有畫面看起來是空的）');
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
  // =========================================================================
  section('路徑 8：賣出（部分賣、全部賣光）');
  //
  // 這條路一直沒有任何端對端測試 —— 而它踩到的東西很具體：
  //   · 平均成本法：賣出**不改均價**（賣掉一部分不影響每股成本）
  //   · 已實現損益**不做**（PLAN 第 23 行，使用者自己決定的）——
  //     所以賣掉的賺賠不會出現在任何地方，而畫面上必須講明這件事
  //   · 賣光之後那一列不該再佔版面，但也不能憑空消失（實測過的殭屍列：
  //     「2330 台積電 0 股 均價 500.00」）
  {
    const page = await freshApp({ dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]) });
    const r = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 500, date: '2026-01-05' });
      await holdings.addOpening({ code: '0050', shares: 3000, avgCost: 132.4, date: '2026-01-05' });

      // 先賣一半
      await holdings.addChange({ code: '2330', date: '2026-06-01', deltaShares: -500, price: 800, kind: 'manual' });
      const half = (await holdings.list()).find((x) => x.code === '2330');

      // 再賣光
      await holdings.addChange({ code: '2330', date: '2026-06-02', deltaShares: -500, price: 900, kind: 'manual' });
      const none = (await holdings.list()).find((x) => x.code === '2330');

      // 賣超過庫存要被擋下來
      let overErr = null;
      try {
        await holdings.addChange({ code: '0050', date: '2026-06-03', deltaShares: -5000, price: 100, kind: 'manual' });
      } catch (e) { overErr = String(e.message || e); }

      await db.put('settle', {
        date: args.TODAY, dayPL: '0', marketValue: null, dividend: null, counted: 1,
        excludedUnsupported: 0, excludedMissing: 0,
        byCode: [{ code: '0050', shares: 3000, close: 107.7, basis: 107.7, basisSource: 'prevClose', status: 'ok', pl: '0' }],
        settledAt: new Date().toISOString(),
      });

      const hv = await import('./js/views/holdings.js');
      await hv.default();
      await new Promise((x) => setTimeout(x, 500));
      const card = document.querySelector('#view [data-card="holdingsList"]');
      const visible = [...card.querySelectorAll('.row')].map((x) => x.dataset.code);
      const closedNote = card.querySelector('[data-note="closedCount"]')?.textContent.trim() ?? '';
      const cardText = card.textContent.replace(/\s+/g, ' ');
      const concText = document.querySelector('#view [data-card="concentration"]')?.textContent.replace(/\s+/g, ' ') ?? '';

      // 展開已出清
      card.querySelector('[data-toggle="closedHoldings"]').click();
      await new Promise((x) => setTimeout(x, 500));
      const closedRows = [...document.querySelectorAll('#view [data-block="closedRows"] .row')]
        .map((x) => x.textContent.replace(/\s+/g, ' ').trim());

      // 單檔詳情：紀錄要完整留著
      const detail = await (async () => {
        const dv = await import('./js/views/holding.js');
        await dv.default('2330');
        await new Promise((x) => setTimeout(x, 500));
        return document.querySelector('#view').textContent.replace(/\s+/g, ' ');
      })();

      return {
        halfShares: half.shares, halfAvg: half.avgCost,
        noneShares: none.shares, noneAvg: none.avgCost,
        overErr, visible, closedNote, cardText, concText, closedRows, detail,
        changes: (await holdings.changesOf('2330')).length,
      };
    }, { TODAY });

    // ---- 平均成本法：賣出不改均價 ----
    eq(r.halfShares, 500, '賣掉一半之後剩 500 股');
    eq(r.halfAvg, 500, '**均價還是 500** —— 平均成本法，賣出不改每股成本');
    eq(r.noneShares, 0, '再賣 500 股之後剩 0 股');
    eq(r.noneAvg, 500, '均價仍然是 500（沒有被清成 null，也沒有被那兩筆賣價汙染）');
    noneOf([r.halfAvg, r.noneAvg], (v) => v === 800 || v === 900 || v === 850,
      '均價沒有變成任何一個賣出價');

    // ---- 賣超過庫存要擋 ----
    ok(r.overErr != null && /負的|庫存/.test(r.overErr),
      `賣超過庫存被擋下來：「${r.overErr}」`);

    // ---- 賣光的那一檔不佔版面，但看得到 ----
    eq(r.visible, ['0050'], '主清單只剩還持有的 0050，賣光的 2330 不在裡面');
    ok(r.closedNote.includes('1 檔已出清'), `但講得出「另有 1 檔已出清」：「${r.closedNote}」`);
    ok(/紀錄還在/.test(r.closedNote), '而且講明紀錄還在，不是資料掉了');
    ok(r.closedRows.length === 1 && r.closedRows[0].includes('2330'),
      `展開之後看得到那一檔：「${r.closedRows[0]}」`);
    ok(r.closedRows[0].includes('已出清'), '標成「已出清」');
    // **0 股旁邊不可以再有均價** —— 那是個沒有意義的數字（實測過的殭屍列）
    noneOf(r.closedRows, (t) => /均價/.test(t), '已出清那一列沒有均價');

    // ---- 產業分布不受影響 ----
    noneOf([r.concText], (t) => /2330/.test(t),
      '產業分布裡沒有 2330（不計入，也不列成「沒有股數」的雜訊）');
    ok(/0050/.test(r.concText), '（對照）還持有的 0050 在產業分布裡');

    // ---- 紀錄完整留著 ----
    eq(r.changes, 3, '三筆變動都在（開帳 ＋ 兩次賣出）');
    ok(/-500 股/.test(r.detail), `單檔詳情看得到賣出那兩筆：「${/持股變動[^新]{0,40}/.exec(r.detail)?.[0]}」`);

    await page.close();
  }

  section('路徑 9：交易日曆快用完了／已經跨年');
  //
  // 這是 A1 在守的東西。舊版的日曆只涵蓋一年，2027-01-01 當天：
  //   covers() 對每一天都回 false → latestPublishedTradingDay 回 null
  //   → runUpdate 直接回 NO_CALENDAR → **除權息同步與定期定額待確認也一起停**
  // 而且在那之前的 12 月裡，畫面上完全沒有任何提示。
  //
  // 用注入日曆而不是偽造 Date：驗的是同一件事，但不會連動整個 App 的時間判斷。
  {
    const seed2330 = async () => {
      const holdings = await import('./js/holdings.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 500, date: '2026-01-05' });
    };
    const iso = (d) => d.toISOString().slice(0, 10);
    const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
    const minus = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
    // 今天一定要在日曆裡，否則會走到 NO_CALENDAR 而不是「快用完」那條路
    const soonDays = [minus(9), minus(7), minus(3), iso(new Date()), plus(3), plus(10)];

    // ---- 9a：日曆只剩 10 天 → 總覽要先講 ----
    const soonYears = {};
    for (const d of soonDays) (soonYears[d.slice(0, 4)] ??= { tradingDays: [], closed: [] }).tradingDays.push(d);
    const pageSoon = await freshApp({
      dayAll: dayAllCsv(iso(new Date()), [['2330', '台積電', 2410, '-40.0000']]),
      calendarJson: { generatedAt: new Date().toISOString(), years: soonYears },
    }, { seed: seed2330 });

    const soon = await pageSoon.evaluate(async () => {
      const store = await import('./js/store.js');
      const home = await import('./js/views/home.js');
      location.hash = '#/';
      await home.default();
      await new Promise((r) => setTimeout(r, 300));
      const el = document.querySelector('#view [data-note="calendarWarn"]');
      return {
        runway: store.calendarRunway(),
        warnText: el?.textContent ?? null,
        homeText: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    });

    ok(soon.homeText.length > 50, `（前提）總覽真的畫出來了，共 ${soon.homeText.length} 字`);
    eq(soon.runway.daysLeft, 10, '日曆只剩 10 天（注入的那份）');
    eq(soon.runway.warn, true, '所以 runway 說該提醒了');
    ok(soon.warnText != null, '總覽上出現了提醒', `實際 homeText：${soon.homeText.slice(0, 200)}`);
    ok(/請更新 App/.test(soon.warnText ?? ''),
      `而且講得出該做什麼：「${soon.warnText}」`);
    ok((soon.warnText ?? '').includes('無法結算'), '也講了不更新會怎樣');
    await pageSoon.close();

    // ---- 9b：對照組 —— 日曆還很久才用完，不可以出現提醒 ----
    // 少了這一條，一個「永遠顯示提醒」的版本也會讓 9a 通過。
    const farDays = [...soonDays, plus(200), plus(300)];
    const farYears = {};
    for (const d of farDays) (farYears[d.slice(0, 4)] ??= { tradingDays: [], closed: [] }).tradingDays.push(d);
    const pageFar = await freshApp({
      dayAll: dayAllCsv(iso(new Date()), [['2330', '台積電', 2410, '-40.0000']]),
      calendarJson: { generatedAt: new Date().toISOString(), years: farYears },
    }, { seed: seed2330 });

    const far = await pageFar.evaluate(async () => {
      const store = await import('./js/store.js');
      const home = await import('./js/views/home.js');
      location.hash = '#/';
      await home.default();
      await new Promise((r) => setTimeout(r, 300));
      return {
        runway: store.calendarRunway(),
        warnEl: !!document.querySelector('#view [data-note="calendarWarn"]'),
        homeText: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    });
    ok(far.homeText.length > 50, `（前提）對照組的總覽也畫出來了，共 ${far.homeText.length} 字`);
    eq(far.runway.warn, false, `（對照）日曆還剩 ${far.runway.daysLeft} 天，不該提醒`);
    eq(far.warnEl, false, '（對照）所以總覽上沒有那行提醒 —— 提醒不是一直都在');
    await pageFar.close();

    // ---- 9c：已經跨年（日曆完全不涵蓋今天）----
    // 這是「沒有人在 12 月更新 App」的下場。訊息要講得出**怎麼恢復**，
    // 只說「今天不在範圍內」的話，使用者會以為是自己的資料壞了。
    const pageOver = await freshApp({
      dayAll: dayAllCsv(iso(new Date()), [['2330', '台積電', 2410, '-40.0000']]),
      calendarJson: {
        generatedAt: new Date().toISOString(),
        years: { 2020: { tradingDays: ['2020-01-02', '2020-01-03'], closed: [] } },
      },
    }, { seed: seed2330 });

    const over = await pageOver.evaluate(async () => {
      const store = await import('./js/store.js');
      const home = await import('./js/views/home.js');
      const r = await store.update({ force: true });
      location.hash = '#/';
      await home.default();
      await new Promise((x) => setTimeout(x, 300));
      return {
        status: r.status, message: r.message,
        settled: r.settled ?? [],
        homeText: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    });

    eq(over.status, 'noCalendar', `跨年之後狀態是 noCalendar（訊息：${over.message}）`);
    eq(over.settled, [], '什麼都沒結算 —— 不會拿別年的日曆硬算');
    ok(/更新 App 之後就會恢復/.test(over.message),
      `訊息講得出怎麼恢復：「${over.message}」`);
    ok(/2020/.test(over.message), '也講得出目前涵蓋到哪些年份');
    noneOf([over.homeText], (t) => /當日損益\s*[+-]?[\d,]+\s*元/.test(t),
      '畫面上沒有生出一個假的當日損益數字');
    await pageOver.close();
  }

  section('路徑 10：開機時資料請求永遠不回來 —— 畫面不能停在空白');
  //
  // 使用者回報（v0.7.18）：按下「更新」之後只剩標題列、下面整片空白，只能把 App 滑掉重開。
  // 連底部分頁都沒有 → boot() 卡在 await store.init()，路由與分頁根本沒啟動。
  // iOS Safari 在 SW 剛換手時 fetch 有機會永遠不回來，AbortSignal.timeout 救不了吊死的請求。
  //
  // 這裡讓 data/*.json 的 fetch 永遠 pending（連 signal 都不理），
  // 然後量「分頁與畫面多久出現」。開機有硬期限的話，幾秒內就要看得到。
  {
    const page = await freshApp({
      dayAll: dayAllCsv(TODAY, [['2330', '台積電', 2410, '-40.0000']]),
      hangData: true,
    });
    // freshApp() 回來時已經等到第一張卡了，所以時間要問頁面自己：
    // performance.now() 是從這次導覽開始算的毫秒數 —— 那才是「使用者盯著空白等了多久」。
    const st = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#tabbar .tab').length,
      cards: document.querySelectorAll('#view .card').length,
      firstCardAt: Math.round(performance.now()),
      // 資料真的沒回來（前提）：不然這一節等於在測正常開機
      catalogLoaded: !!document.querySelector('#view [data-card="start"]'),
    }));
    ok(st.tabs >= 4, `資料請求吊死，底部分頁仍然出現了（${st.tabs} 格）`, 'boot() 卡在 store.init()，分頁沒畫');
    ok(st.cards >= 1, `畫面也畫出來了，不是一片空白（${st.cards} 張卡）`);
    // 硬期限是 6 秒。沒有期限的話：fetch 有 15 秒 timeout 的會等到 15 秒，
    // 吊死不理 signal 的（這一節就是）會**永遠**等不到 —— freshApp 自己就先逾時了。
    ok(st.firstCardAt < 9000,
      `從導覽開始到第一張卡只花 ${st.firstCardAt}ms（硬期限 6000ms ＋ 餘裕）—— 不是等到 15 秒 timeout`);
    ok(st.firstCardAt > 3000,
      `（前提）它真的等過 store.init（${st.firstCardAt}ms > 3000ms）—— 資料請求確實被吊住了，不是正常開機`);

    const after = await page.evaluate(async () => {
      const text = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
      // 分頁點得動
      document.querySelector('#tabbar .tab[href="#/settings"]').click();
      await new Promise((r) => setTimeout(r, 800));
      return {
        text,
        title: document.getElementById('topTitle').textContent,
        settingsText: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    });
    ok(/尚未取得|還沒有持股|開始使用|尚未結算/.test(after.text),
      `畫面講得出現在的狀態：「${after.text.slice(0, 60)}」`);
    eq(after.title, '設定', '點底部分頁真的能換頁（不是畫出來了但點不動）');
    ok(/尚未取得/.test(after.settingsText), '設定頁對拿不到的資料講「尚未取得」，不假裝有');
    noneOf([after.settingsText], (t) => /NaN|undefined|null/.test(t), '沒有 NaN／undefined 漏出來');
    await page.close();
  }

  section('路徑 11：一個入口模組沒載到（沒有 SW 可退）—— 看門狗要補一張卡');
  //
  // 使用者回報：按下「更新」之後只剩最上面的標題列、下面整片空白、連轉圈圈都沒有。
  // 頂列停在 index.html 寫死的「StockDiary」→ **JS 整張沒跑**：首頁的 ES module 圖二十幾個檔，
  // 任何一個拿不到整張就不執行；畫錯誤畫面的程式碼也在那張圖裡，所以沒有任何東西會出來。
  // 根因是更新流程 unregister 之後 reload，那一頁就沒有 SW 可退了（v0.7.21 已拿掉）。
  //
  // 這裡用**全新的瀏覽器 context**（沒有 SW）＋ 把 js/store.js 打成 404，真的重現那片空白，
  // 再驗看門狗（普通 script，不在 module 圖裡）補卡；把檔案還回來按「重新載入」要回到可用。
  {
    const failing = new Set(['/js/store.js']);
    const { srv: srv11, port: port11 } = await listen(0, { shouldFail: (pn) => failing.has(pn) });
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(90000);
    await page.setViewport({ width: 390, height: 844 });
    const errs11 = [];
    page.on('pageerror', (e) => errs11.push(String(e.message)));

    await page.goto(`http://localhost:${port11}/`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    const blank = await page.evaluate(() => ({
      title: document.getElementById('topTitle').textContent,
      docTitle: document.title,
      tabs: document.querySelectorAll('#tabbar .tab').length,
      viewChildren: document.getElementById('view').children.length,
      spinner: !!document.querySelector('#view .wait-box'),
      booted: document.documentElement.getAttribute('data-booted'),
      swControlled: !!navigator.serviceWorker?.controller,
    }));
    eq(blank.swControlled, false, '（前提）這一頁沒有 Service Worker 在管 —— 檔案只能走網路');
    eq(blank.title, 'StockDiary', '（真的空白）頂列停在 HTML 寫死的預設標題');
    eq(blank.tabs, 0, '（真的空白）沒有底部分頁');
    eq(blank.spinner, false, '（真的空白）連轉圈圈都沒有 —— 畫轉圈圈的程式碼在那張 module 圖裡');
    eq(blank.booted, null, '（真的空白）app.js 沒有標上 data-booted：module 圖整張沒跑');

    // 看門狗：偵測到 script 載入失敗之後 1.5 秒內補卡（沒偵測到也會在 12 秒時補）
    await page.waitForSelector('#view [data-card="bootGuard"]', { timeout: 15000 });
    const guard = await page.evaluate(() => {
      const card = document.querySelector('#view [data-card="bootGuard"]');
      const text = card.textContent.replace(/\s+/g, ' ');
      const btns = [...card.querySelectorAll('button')].map((b) => ({
        t: b.textContent, h: b.getBoundingClientRect().height, action: b.dataset.action,
      }));
      return { text, btns, elapsed: Math.round(performance.now()) };
    });
    ok(/資料不會不見/.test(guard.text), `先講「你的資料不會不見」：「${guard.text.slice(0, 40)}」`);
    ok(/沒有下載完成|沒有啟動/.test(guard.text), '講得出發生什麼事');
    eq(guard.btns.map((b) => b.action), ['bootReload', 'bootClear'], '兩顆按鈕：重新載入、清快取再載入');
    everyOf(guard.btns, (b) => b.h >= 44, `按鈕 ≥44px（${guard.btns.map((b) => `${b.t} ${Math.round(b.h)}px`).join('、')}）`);
    ok(guard.elapsed < 12000, `偵測到載入失敗就提早補卡（${guard.elapsed}ms），不必等滿 12 秒`);
    ok(/不會動到你的資料/.test(guard.text), '「清快取」那顆先講清楚不會動到資料');

    // 檔案回來了 → 按「重新載入」→ 回到可用畫面
    failing.clear();
    await page.click('#view [data-action="bootReload"]');
    await page.waitForSelector('#tabbar .tab', { timeout: 30000 });
    await page.waitForSelector('#view .card', { timeout: 30000 });
    const back = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#tabbar .tab').length,
      cards: document.querySelectorAll('#view .card').length,
      booted: document.documentElement.getAttribute('data-booted'),
      guardStill: !!document.querySelector('#view [data-card="bootGuard"]'),
      title: document.getElementById('topTitle').textContent,
    }));
    ok(back.tabs >= 4, `檔案回來按「重新載入」之後，分頁回來了（${back.tabs} 格）`);
    ok(back.cards >= 1, `畫面也回來了（${back.cards} 張卡）`);
    eq(back.booted, '1', 'app.js 標上了 data-booted');
    eq(back.guardStill, false, '救援卡不會留在正常畫面上（畫面有東西時看門狗不出手）');
    ok(back.title !== 'StockDiary' || back.cards >= 1, `頂列不再是空白狀態的樣子（${back.title}）`);

    // 對照：正常開機時看門狗**不會**出手（等過 12 秒也不會）
    await new Promise((r) => setTimeout(r, 12500));
    const calm = await page.evaluate(() => !!document.querySelector('#view [data-card="bootGuard"]'));
    eq(calm, false, '（對照）正常開機等滿 12 秒，看門狗一張卡都沒補 —— 它只在畫面空著時出手');

    await page.close();
    await ctx.close();
    srv11.close();

    // ---- 11b：模組**吊死**（連 header 都不回）—— 沒有 404、沒有 error 事件，只有 12 秒計時器救得了 ----
    // 404 那條路走的是「聽到載入失敗提早補卡」；這條路什麼事件都不會有，
    // 看門狗只能靠時間。少了這一節，計時器被改成 10 分鐘也沒有斷言會紅。
    const hanging = new Set(['/js/store.js']);
    const { srv: srv11b, port: port11b } = await listen(0, { shouldHang: (pn) => hanging.has(pn) });
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.setDefaultTimeout(90000);
    // **不能 await 這個 goto。** module script 是 deferred，DOMContentLoaded 要等整張 module 圖
    // 執行完，而圖裡有一個檔永遠不回來 → DCL 永遠不觸發 → goto 永遠不 resolve（實測逾時 90 秒）。
    // 這本身就是那片空白的真實樣子。HTML 早就 commit、解析完、看門狗（普通 script）也早就跑了，
    // 所以直接對已經 commit 的文件做檢查；goto 的逾時最後吞掉。
    const tB0 = Date.now();
    const navB = pageB.goto(`http://localhost:${port11b}/`, { waitUntil: 'load', timeout: 40000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 800));
    // 先確認 5 秒時還是空的（看門狗沒有提早出手）
    await new Promise((r) => setTimeout(r, Math.max(0, 5000 - (Date.now() - tB0))));
    const at5s = await pageB.evaluate(() => ({
      guard: !!document.querySelector('#view [data-card="bootGuard"]'),
      tabs: document.querySelectorAll('#tabbar .tab').length,
      booted: document.documentElement.getAttribute('data-booted'),
    }));
    eq(at5s.guard, false, '（吊死）5 秒時看門狗還沒出手 —— 沒有 error 事件，它不該提早');
    eq(at5s.tabs, 0, '（吊死）5 秒時仍然是空的：module 圖在等那個永遠不回來的檔');
    eq(at5s.booted, null, '（吊死）app.js 沒跑');
    await pageB.waitForSelector('#view [data-card="bootGuard"]', { timeout: 20000 });
    const hangMs = Date.now() - tB0;
    ok(hangMs >= 11000 && hangMs <= 16000,
      `（吊死）看門狗在 12 秒計時器到了才補卡（${hangMs}ms）—— 不是提早、也不是永遠不來`);
    const hangText = await pageB.evaluate(() => document.querySelector('#view [data-card="bootGuard"]').textContent.replace(/\s+/g, ' '));
    ok(/還沒啟動/.test(hangText), `（吊死）講的是「等了 12 秒還沒啟動」而不是「檔沒下載完成」：「${hangText.slice(40, 90)}」`);
    await pageB.close();
    await ctxB.close();
    srv11b.closeAllConnections?.();   // 斬掉那條永遠不回應的連線，close() 才不會等它
    srv11b.close();
    void navB;   // 逾時已經被 .catch 吞掉，這裡只是講明它不必等
  }

  eq(pageErrors.filter((e) => !/favicon/.test(e)), [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  try { srv.close(); } catch { /* 已經關掉了 */ }
}

done('pathtest');
