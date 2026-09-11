// 除權息的端對端行為（npm run eventtest）。真的開瀏覽器跑，TWSE 回應用假的 fetch 攔下來。
//
// 這裡守的是 STATUS「接手者最容易做錯的事」第 1 條：
//   **除息日不改用參考價 → 生出等於息值的假虧損。**
// 所以最核心的案例是：前收 2255、當日收 2250、每股配息 5 元。
//   正確：基準價＝參考價 2250 → 價格部分 0，加上應收股利 5,000 → 當日損益 +5,000
//   錯誤：基準價＝前收 2255 → 價格部分 −5,000（那就是假虧損）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay, DEFAULT_TODAY_THRESHOLD, prevTradingDay } from '../js/market.js';
import { isoToRocCompact } from '../js/roc.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const cal = makeCalendar(calJson);

const EXDATE = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
const PREV = EXDATE ? prevTradingDay(cal, EXDATE) : null;

section('測試前提');
ok(EXDATE != null && PREV != null,
  `除權息日用「應公布的最新交易日」${EXDATE}，前一交易日 ${PREV}`,
  'data/calendar.json 可能過期了 → 跑 npm run build-calendar');
if (!EXDATE || !PREV) done('eventtest');

// ---- 假的 TWSE 回應 ----
const CSV_HEADER = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
const dayAllCsv = (date, rows) => [CSV_HEADER, ...rows.map(([c, n2, close, chg]) =>
  `"${isoToRocCompact(date)}","${c}","${n2}","1000","1000","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${chg.toFixed(4)}","10"`,
)].join('\n') + '\n';

// 2330 除息當天：收 2250，相對前收 2255 是 −5（STOCK_DAY_ALL 不會標除權息）
const CSV = dayAllCsv(EXDATE, [['2330', '台積電', 2250, -5], ['2317', '鴻海', 251, 0.5]]);

const twt48u = (rows) => ({
  stat: 'OK',
  fields: ['除權除息日期', '股票代號', '名稱', '除權息', '無償配股率', '現金增資配股率', '現金增資認購價', '現金股利',
    '詳細資料', '參考價<br>試算', '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
  data: rows,
});
const rocChars = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1911}年${m}月${d}日`;
};

const twt49u = (rows) => ({
  stat: 'OK',
  fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息',
    '漲停價格', '跌停價格', '開盤競價基準', '減除股利參考價', '詳細資料',
    '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
  data: rows,
});

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.evaluateOnNewDocument(() => {
    const real = window.fetch.bind(window);
    window.__twseCalls = [];
    window.__mock = null;
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes('twse.com.tw')) return real(input, init);
      window.__twseCalls.push(url);
      const m = window.__mock || {};
      if (url.includes('STOCK_DAY_ALL')) return new Response(m.dayAllCsv ?? '', { status: m.dayAllCsv ? 200 : 503 });
      if (url.includes('TWT48U')) return new Response(JSON.stringify(m.twt48u ?? { stat: '很抱歉，沒有符合條件的資料!' }), { status: 200 });
      if (url.includes('TWT49U')) return new Response(JSON.stringify(m.twt49u ?? { stat: '很抱歉，沒有符合條件的資料!' }), { status: 200 });
      if (url.includes('STOCK_DAY')) return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }), { status: 200 });
      return new Response('', { status: 404 });
    };
  });

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');

  const setup = async ({ mock, holdings: hs, closes = [], prefsSet = {} }) => {
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      for (const s of db.STORE_NAMES) await db.clear(s);
    });
    await page.evaluate((m) => { window.__mock = m; window.__twseCalls = []; }, mock);
    await page.evaluate(async ({ list, cl, pf }) => {
      const hd = await import('./js/holdings.js');
      for (const x of list) await hd.addOpening(x);
      const db = await import('./js/db.js');
      for (const c of cl) await db.put('closes', c);
      const prefs = await import('./js/prefs.js');
      await prefs.load();
      for (const [k, v] of Object.entries(pf)) await prefs.set(k, v);
    }, { list: hs, cl: closes, pf: prefsSet });
    return page.evaluate(async () => {
      const store = await import('./js/store.js');
      try {
        const r = await store.update({ force: true });
        return { status: r.status, message: r.message, settled: r.settled ?? [], problems: r.problems ?? [], pendingEvents: r.pendingEvents ?? 0 };
      } catch (e) { return { status: 'threw', message: String(e && e.stack || e), settled: [], problems: [] }; }
    });
  };

  /** 切到某個畫面並**等它畫完**（直接改 hash 不會等 view 的 async 跑完）。 */
  const showView = async (module, selector) => {
    await page.evaluate(async (m) => {
      location.hash = m === 'home' ? '#/' : `#/${m}`;
      const mod = await import(`./js/views/${m}.js`);
      await mod.default();
    }, module);
    await page.waitForSelector(selector);
    return page.$eval('#view', (el) => el.textContent.replace(/\s+/g, ' '));
  };

  const settleOf = (date) => page.evaluate(async (d) => {
    const db = await import('./js/db.js');
    const row = await db.get('settle', d);
    return row ? { ...row, dayPL: row.dayPL, marketValue: row.marketValue, dividend: row.dividend } : null;
  }, date);

  const eventsOf = () => page.evaluate(async () => {
    const db = await import('./js/db.js');
    return (await db.getAll('events')).map((e) => ({
      id: e.id, code: e.code, exDate: e.exDate, kind: e.kind, status: e.status,
      cashPerShare: e.cashPerShare, stockRate: e.stockRate, sharesHeld: e.sharesHeld,
      refPrice: e.refPrice, amountEst: e.amountEst, amountActual: e.amountActual,
    }));
  });

  // =================================================================
  section('情境 1：除息日有參考價 —— 不能生出假虧損');
  const upd1 = await setup({
    mock: {
      dayAllCsv: CSV,
      twt48u: twt48u([[rocChars(EXDATE), '2330', '台積電', '息', '0.00000000', '0.00000000', '0.00000000', '5.00000000', '', '', '', '', '']]),
      twt49u: twt49u([[rocChars(EXDATE), '2330', '台積電', '2255.00', '2250.00', '5.000000', '息', '2475.00', '2025.00', '2250.00', '2250.00', '', '', '', '']]),
    },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
    closes: [{ code: '2330', date: PREV, close: 2255, change: 10, exMark: false }],
  });
  eq(upd1.status, 'settled', `更新狀態 settled（${upd1.message}）`);

  const ev1 = await eventsOf();
  eq(ev1.length, 1, '建立了一筆除權息事件');
  eq(ev1[0].id, `2330-${EXDATE}`, '事件 id 是「代號-除權息日」');
  eq(ev1[0].kind, 'cash', '是除息');
  eq(ev1[0].cashPerShare, 5, '每股配息 5 元');
  eq(ev1[0].sharesHeld, 1000, '除息日持有 1000 股');
  eq(ev1[0].refPrice, 2250, '從 TWT49U 拿到參考價 2250');
  eq(ev1[0].status, 'pending', '除權息日已過 → 待確認');

  const s1 = await settleOf(EXDATE);
  const row2330 = s1.byCode.find((r) => r.code === '2330');
  eq(row2330.basisSource, 'refPrice', '基準價來自除權息參考價，不是前一日收盤');
  eq(row2330.basis, 2250, '基準價是 2250');
  // 價格部分：1000 × (2250 − 2250) = 0
  eq(row2330.pl, '0', '價格造成的損益是 0');
  ok(row2330.pl !== String(-5000n * 1000000n),
    '不是 −5,000 —— 那才是「用前一日收盤 2255 當基準」的假虧損');
  // 應收股利：1000 × 5 = 5,000；當日損益 = 0 + 5,000
  eq(s1.dividend, String(5000n * 1000000n), '當日應收股利 5,000 元');
  eq(s1.dayPL, String(5000n * 1000000n), '當日損益 +5,000 元（價格 0 ＋ 應收股利 5,000）');

  section('畫面要講出來這一天用了參考價');
  const homeText = await showView('home', '#view .big-number');
  ok(homeText.includes('含除息調整'), '首頁標了「含除息調整」');
  ok(homeText.includes('+5,000'), `當日損益 +5,000（${homeText.slice(0, 80)}）`);
  ok(homeText.includes('有 1 筆除權息等你確認'), '首頁頂部提示有待確認事件');

  // 對照組：金額有公告的事件，那一列**要有**金額節點。
  // 少了這一條，情境 3 的「一個 .num 都沒有」在整頁都畫不出來時也會過。
  await showView('dividends', '#view [data-card="pendingEvents"]');
  const pendNums = await page.$$eval('#view [data-card="pendingEvents"] .num', (els) => els.map((e) => e.textContent));
  ok(pendNums.length > 0, `（對照）金額已公告的待確認列有 ${pendNums.length} 個金額節點：${pendNums.join('、')}`);
  ok(pendNums.includes('5,000'), '而且顯示的是 5,000 元');

  // =================================================================
  section('情境 2：除息日拿不到參考價 —— 整檔不算，不是算成虧損');
  const upd2 = await setup({
    mock: {
      dayAllCsv: CSV,
      twt48u: twt48u([[rocChars(EXDATE), '2330', '台積電', '息', '0.00000000', '0.00000000', '0.00000000', '5.00000000', '', '', '', '', '']]),
      twt49u: { stat: '很抱歉，沒有符合條件的資料!' },     // 結果表還沒出來
    },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
    closes: [{ code: '2330', date: PREV, close: 2255, change: 10, exMark: false }],
  });
  void upd2;
  const ev2 = await eventsOf();
  eq(ev2[0].refPrice, null, '沒有參考價');
  const s2 = await settleOf(EXDATE);
  const r2 = s2.byCode.find((r) => r.code === '2330');
  eq(r2.status, 'exNoRef', '狀態是「除權息日，尚未取得參考價」');
  eq(r2.pl, null, '這一檔的損益是 null');
  eq(s2.dayPL, null, '當日損益整個是 null —— 不會拿前收硬算成 −5,000');
  eq(s2.counted, 0, '沒有任何一檔算進去');
  const t2 = await showView('home', '#view .big-number');
  ok(t2.includes('尚未取得參考價'), '畫面講清楚為什麼沒算', '實際畫面：' + t2.slice(0, 400));
  noneOf([await page.$eval('#view .big-number', (el) => el.textContent.trim())], (v) => /\d/.test(v),
    '當日損益那一格沒有任何數字');

  // =================================================================
  section('情境 3：金額待公告 —— 不顯示 0 元');
  await setup({
    mock: {
      dayAllCsv: CSV,
      // TWSE 實際會在現金股利欄位塞一段 HTML
      twt48u: twt48u([['115年12月15日', '2330', '台積電', '息', '0.00000000', '0.00000000', '0.00000000',
        '<p style= text-align:center;>待公告實際收益分配金額</p>', '', '', '', '', '']]),
      twt49u: { stat: '很抱歉，沒有符合條件的資料!' },
    },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
    closes: [{ code: '2330', date: PREV, close: 2255, change: 10, exMark: false }],
  });
  const ev3 = await eventsOf();
  eq(ev3.length, 1, '事件建起來了');
  eq(ev3[0].cashPerShare, null, '每股配息是 null（不是 0）');
  eq(ev3[0].amountEst, null, '預估金額是 null（不是 0 元）');
  eq(ev3[0].status, 'upcoming', '日期在未來 → 日曆上的 upcoming');

  await showView('dividends', '#view [data-card="upcomingEvents"]');
  const divText = await page.$eval('#view [data-card="upcomingEvents"]', (el) => el.textContent.replace(/\s+/g, ' '));
  ok(divText.includes('金額待公告'), `日曆上寫「金額待公告」：「${divText.slice(0, 120)}」`);
  noneOf([divText], (t) => /預估\s*0\s*元|每股配息\s*0\.00/.test(t), '沒有出現 0 元的預估');
  const noAmountNums = await page.$$eval('#view [data-card="upcomingEvents"] .num', (els) => els.length);
  eq(noAmountNums, 0, '金額未公告的那一列連一個金額節點都沒有建出來');

  // =================================================================
  section('情境 4：確認股利 → 計入累積已領股利');
  await setup({
    mock: {
      dayAllCsv: CSV,
      twt48u: twt48u([[rocChars(EXDATE), '2330', '台積電', '息', '0.00000000', '0.00000000', '0.00000000', '5.00000000', '', '', '', '', '']]),
      twt49u: twt49u([[rocChars(EXDATE), '2330', '台積電', '2255.00', '2250.00', '5.000000', '息', '2475.00', '2025.00', '2250.00', '2250.00', '', '', '', '']]),
    },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
    closes: [{ code: '2330', date: PREV, close: 2255, change: 10, exMark: false }],
    prefsSet: { dividendAutoFees: false },
  });

  const afterConfirm = await page.evaluate(async (id) => {
    const ev = await import('./js/events.js');
    await ev.confirm(id, {});
    const s = await ev.summary({ year: Number(id.split('-')[1]) });
    return { total: s.totalMicro == null ? null : s.totalMicro.toString(), counted: s.counted, unknown: s.unknown };
  }, `2330-${EXDATE}`);
  // 自動扣費關閉：1000 股 × 5 元 = 5,000 元，一毛都不扣
  eq(afterConfirm.total, String(5000n * 1000000n), '累積已領股利 5,000 元（自動扣費關閉，不扣任何費用）');
  eq(afterConfirm.counted, 1, '一筆');

  section('開啟自動扣費');
  const withFees = await page.evaluate(async (id) => {
    const ev = await import('./js/events.js');
    await ev.unconfirm(id);
    await ev.confirm(id, { autoFees: true });
    const s = await ev.summary({});
    return s.totalMicro.toString();
  }, `2330-${EXDATE}`);
  // 5,000 元未達 20,000，只扣匯費 10 元 → 4,990
  eq(withFees, String(4990n * 1000000n), '扣匯費 10 元 → 4,990 元（未達 2 萬，不扣補充保費）');

  section('實收金額可以改成券商實際入帳的數字');
  const overridden = await page.evaluate(async (id) => {
    const ev = await import('./js/events.js');
    await ev.unconfirm(id);
    await ev.confirm(id, { amountActual: '4987', autoFees: true });
    const s = await ev.summary({});
    const e = await ev.get(id);
    return { total: s.totalMicro.toString(), actual: e.amountActual };
  }, `2330-${EXDATE}`);
  eq(overridden.total, String(4987n * 1000000n), '使用者填 4,987 就以 4,987 為準');
  ok(overridden.total !== String(4990n * 1000000n), '不是自動算出來的 4,990');

  section('確認過的事件，不能被下一次開頁的自動更新洗掉');
  // 這是真實情境：確認完金額之後隔天再開 App，程式會重抓一次 TWT48U。
  // 如果重抓時直接覆蓋，使用者對過對帳單填進去的 4,987 就不見了。
  const afterResync = await page.evaluate(async (id) => {
    const store = await import('./js/store.js');
    await store.update({ force: true });          // 再跑一次完整更新（會重抓預告表）
    const ev = await import('./js/events.js');
    const e = await ev.get(id);
    const s = await ev.summary({});
    return { status: e.status, actual: e.amountActual, total: s.totalMicro == null ? null : s.totalMicro.toString() };
  }, `2330-${EXDATE}`);
  eq(afterResync.status, 'confirmed', '重抓之後仍然是已確認');
  eq(afterResync.actual, String(4987n * 1000000n), '使用者填的 4,987 還在');
  eq(afterResync.total, String(4987n * 1000000n), '累積已領股利也還是 4,987');

  section('「這筆我沒有」不計入');
  const dismissed = await page.evaluate(async (id) => {
    const ev = await import('./js/events.js');
    await ev.dismiss(id);
    const s = await ev.summary({});
    return { total: s.totalMicro, counted: s.counted };
  }, `2330-${EXDATE}`);
  eq(dismissed.total, null, '忽略之後總計回到 null（不是 0）');
  eq(dismissed.counted, 0, '沒有任何一筆算進去');

  // =================================================================
  section('情境 5：配股 —— 股數增加、餘數提示');
  await setup({
    mock: {
      dayAllCsv: dayAllCsv(EXDATE, [['1235', '興泰', 20, 0]]),
      // 興泰的真實配股率 0.04999999（每仟股配 49.99999 股）＋ 每股配息 0.5 元
      twt48u: twt48u([[rocChars(EXDATE), '1235', '興泰', '權息', '0.04999999', '0.00000000', '0.00000000', '0.50000000', '', '', '', '', '']]),
      twt49u: twt49u([[rocChars(EXDATE), '1235', '興泰', '21.50', '20.00', '1.500000', '權息', '23.65', '19.35', '20.00', '20.00', '', '', '', '']]),
    },
    holdings: [{ code: '1235', shares: 1000, date: '2026-01-05' }],
    closes: [{ code: '1235', date: PREV, close: 21.5, change: 0.1, exMark: false }],
  });

  // 先看待確認的描述（確認之後那一列就移到「已確認」，不再顯示配股細節）
  await showView('dividends', '#view [data-card="pendingEvents"]');
  const stockText = await page.$eval('#view [data-card="pendingEvents"]', (el) => el.textContent.replace(/\s+/g, ' '));
  ok(/每仟股配 50\.00 股/.test(stockText), `寫出每仟股配 50.00 股：「${stockText.slice(0, 160)}」`);
  ok(/約增加 49 股/.test(stockText), '約增加 49 股（不是 50）');
  ok(stockText.includes('餘數') && stockText.includes('現金找零'), '提到餘數以現金找零');
  ok(/0\.99999/.test(stockText), '餘數寫成 0.99999 股');

  const stockResult = await page.evaluate(async (id) => {
    const ev = await import('./js/events.js');
    const hd = await import('./js/holdings.js');
    const before = (await hd.list()).find((x) => x.code === '1235').shares;
    await ev.confirm(id, {});
    const after = (await hd.list()).find((x) => x.code === '1235').shares;
    const changes = await hd.changesOf('1235');
    return { before, after, kinds: changes.map((c) => c.kind), deltas: changes.map((c) => c.deltaShares) };
  }, `1235-${EXDATE}`);
  eq(stockResult.before, 1000, '確認前 1000 股');
  // 1000 × 0.04999999 = 49.99999 → 加 49 股（不是 50），餘 0.99999 股以現金找零
  eq(stockResult.after, 1049, '確認後 1,049 股（加 49 股，不是 50 股）');
  ok(stockResult.kinds.includes('stockDividend'), '產生了一筆 stockDividend 的持股變動');
  eq(stockResult.deltas, [1000, 49], '變動紀錄是 +1000 與 +49');

  const divText2 = await showView('dividends', '#view .card');
  ok(!divText2.includes('待確認（'), '確認之後就不在待確認清單裡了');
  ok(/已確認（1 筆）/.test(divText2), '出現在已確認清單');

  section('沒有頁面錯誤');
  eq(pageErrors.filter((t) => !/favicon|503|Failed to load resource/i.test(t)), [], '沒有未預期的錯誤');

  section('請求次數');
  const calls = await page.evaluate(() => window.__twseCalls.length);
  ok(calls <= 3, `一次更新最多 3 個請求（收盤、預告表、結果表），實際 ${calls}`);
} finally {
  await browser.close();
  srv.close();
}

everyOf([1], () => true, '測試跑完了');
done('eventtest');
