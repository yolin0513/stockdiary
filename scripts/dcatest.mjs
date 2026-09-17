// 定期定額的端對端行為（npm run dcatest）。真的開瀏覽器跑。
//
// 驗收條件（STATUS M3）：
//   · 「跳過三個月再開 App」→ 產生三筆 pending 且**都未確認**
//   · 配息再投入只有在計畫開啟時才產生
//   · 均價：有填成交價才更新；沒填就不動並寫 costNote

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, near, section, done, noneOf, everyOf, note } from './tap.mjs';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay, DEFAULT_TODAY_THRESHOLD } from '../js/market.js';
import { isoToRocCompact } from '../js/roc.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const cal = makeCalendar(calJson);
// calendar.json 是多年格式（{ years: { "2026": {...} } }），沒有頂層的 tradingDays。
// makeCalendar 同時讀得懂新舊兩種格式，所以一律從它的 days 拿。
const ALL_TRADING_DAYS = cal.days;

const TODAY = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
section('測試前提');
ok(TODAY != null, `應公布的最新交易日：${TODAY}`, 'data/calendar.json 可能過期了 → npm run build-calendar');
if (!TODAY) done('dcatest');

// 找出 TODAY 之前、每月 16 號（順延後）的三個扣款日
const days16 = ALL_TRADING_DAYS.filter((d) => d <= TODAY);
function due16(monthIso) {
  const scheduled = `${monthIso}-16`;
  return days16.find((d) => d >= scheduled) ?? null;
}
const months = [];
{
  // **取最近三個「扣款日已經發生」的月份**，不是寫死往前推 3、2、1 個月。
  //
  // 寫死的版本有一個只在每個月下半月才出現的 bug：計畫的建立日是 months[0]，
  // App 會從那天一路展開到今天 —— 所以只要今天已經過了**當月**的扣款日，
  // 就會多出第四筆，而測試硬編「三筆」。
  // 實際發生過：2026-09-16 之後跑這支測試，七條斷言一起紅，
  // 而程式一個字都沒改。症狀看起來像偶發，其實是日期漂移。
  //
  // 這種失敗**任何 diff 都挑不到**（`mutationtest --changed` 也挑不到），
  // 因為它不是被誰改壞的 —— 是時間走過去了。
  const [y, m] = TODAY.split('-').map(Number);
  for (let i = 0; months.length < 3 && i < 12; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (due16(iso)) months.unshift(iso);
  }
}
const dueDates = months.map(due16).filter(Boolean);
ok(dueDates.length === 3, `三個扣款日：${dueDates.join('、')}`);
if (dueDates.length !== 3) done('dcatest');
const START = `${months[0]}-01`;   // 計畫建立日（第一個扣款日之前）

const CSV_HEADER = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
const dayAllCsv = (date, rows) => [CSV_HEADER, ...rows.map(([c, n2, close, chg]) =>
  `"${isoToRocCompact(date)}","${c}","${n2}","1000","1000","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${chg.toFixed(4)}","10"`,
)].join('\n') + '\n';
const CSV = dayAllCsv(TODAY, [['0050', '元大台灣50', 109.15, -0.5], ['2330', '台積電', 2450, -15]]);

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

  await page.evaluateOnNewDocument((csv) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes('twse.com.tw')) return real(input, init);
      if (url.includes('STOCK_DAY_ALL')) return new Response(csv, { status: 200 });
      return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }), { status: 200 });
    };
  }, CSV);

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');

  const reset = () => page.evaluate(async () => {
    const db = await import('./js/db.js');
    for (const s of db.STORE_NAMES) await db.clear(s);
  });

  const seedCloses = (rows) => page.evaluate(async (list) => {
    const db = await import('./js/db.js');
    for (const r of list) await db.put('closes', r);
  }, rows);

  const changesOf = (code) => page.evaluate(async (c) => {
    const hd = await import('./js/holdings.js');
    return (await hd.changesOf(c)).map((x) => ({
      id: x.id, date: x.date, deltaShares: x.deltaShares, price: x.price,
      kind: x.kind, status: x.status, note: x.note, amount: x.amount,
    }));
  }, code);

  const holdingOf = (code) => page.evaluate(async (c) => {
    const db = await import('./js/db.js');
    return db.get('holdings', c);
  }, code);

  const runUpdate = () => page.evaluate(async () => {
    const store = await import('./js/store.js');
    const r = await store.update({ force: true });
    return { status: r.status, message: r.message, problems: r.problems ?? [] };
  });

  const showView = async (module, selector) => {
    await page.evaluate(async (m) => {
      location.hash = m === 'home' ? '#/' : `#/${m}`;
      await (await import(`./js/views/${m}.js`)).default();
    }, module);
    await page.waitForSelector(selector);
    return page.$eval('#view', (el) => el.textContent.replace(/\s+/g, ' '));
  };

  // =================================================================
  section('情境 1：跳過三個月再開 App');
  await reset();
  // 三個扣款日的收盤價。每期 3,000 元，所以股數 = floor(3000 ÷ 收盤價)。
  //
  // ⚠ 最後一個扣款日**有可能就是今天**（每個月 16 號之後跑就會是）。
  // 今天那一筆的收盤價會被當日的 STOCK_DAY_ALL 覆蓋掉（CSV 裡的 109.15），
  // 我們種的 150 不會生效 —— 所以預期股數要照**實際會被用到的**價格算，
  // 不能寫死 [30, 25, 20]。寫死的版本在 2026-09-16 那天開始紅，
  // 而程式一個字都沒改。
  const SEEDED_CLOSE = [100, 120, 150];
  const TODAY_CLOSE = 109.15;   // 與上面 CSV 裡的 0050 一致
  await seedCloses(dueDates.map((d, i) => (
    { code: '0050', date: d, close: SEEDED_CLOSE[i], change: 0, exMark: false })));
  const effectiveClose = (d, i) => (d === TODAY ? TODAY_CLOSE : SEEDED_CLOSE[i]);
  const expectShares = dueDates.map((d, i) => Math.floor(3000 / effectiveClose(d, i)));
  await page.evaluate(async (startDate) => {
    const plans = await import('./js/plans.js');
    await plans.save({
      code: '0050', amount: 3000, days: [16], feeRate: 0,
      reinvestDividend: false, active: true,
      startDate, createdAt: `${startDate}T00:00:00.000Z`,
    });
  }, START);

  const upd1 = await runUpdate();
  ok(['settled', 'partial', 'todayPending', 'upToDate'].includes(upd1.status),
    `更新狀態 ${upd1.status}（${upd1.message}）`);

  const ch1 = await changesOf('0050');
  const dca = ch1.filter((c) => c.kind === 'dca');
  // 筆數跟著 fixture 走。寫死 3 的話，fixture 一改（或日期一漂）就對不起來，
  // 而那正是這支測試踩過的坑。
  eq(dca.length, dueDates.length, `產生了 ${dueDates.length} 筆定期定額扣款`);
  eq(dca.map((c) => c.date), dueDates, `日期是 ${dueDates.join('、')}`);
  everyOf(dca, (c) => c.status === 'pending',
    `${dueDates.length} 筆**都是待確認**，沒有任何一筆被自動確認`);
  noneOf(dca, (c) => c.status === 'confirmed', '一筆都沒有自動確認');
  // 手算：3000 / 100 = 30 股；3000 / 120 = 25 股；3000 / 150 = 20 股
  eq(dca.map((c) => c.deltaShares), expectShares,
    `估算股數 ${expectShares.join('、')}（3,000 元 ÷ ${dueDates.map((d, i) => effectiveClose(d, i)).join('、')}）`);
  // 對照：這些股數真的是算出來的，不是巧合的固定值
  ok(new Set(expectShares).size >= 2,
    `（對照）三筆的股數不一樣（${expectShares.join('、')}）—— 證明它真的跟著收盤價走`);

  const h1 = await holdingOf('0050');
  eq(h1.shares, 0, '待確認的扣款不會讓股數增加（還是 0 股）');

  section('重跑更新不會產生重複');
  await runUpdate();
  const ch1b = await changesOf('0050');
  eq(ch1b.filter((c) => c.kind === 'dca').length, dueDates.length,
    `還是 ${dueDates.length} 筆，沒有變成 ${dueDates.length * 2} 筆`);

  section('畫面上看得到三筆待確認');
  const plansText = await showView('plans', '#view [data-card="pendingChanges"]');
  ok(plansText.includes(`待確認扣款（${dueDates.length} 筆）`),
    `定期定額頁列出 ${dueDates.length} 筆`, plansText.slice(0, 200));
  const homeText = await showView('home', '#view .big-number');
  // v0.7.10 起提示列一種一條，文案從「3 筆扣款」變成「3 筆定期定額扣款」。
  // 這裡不要再比對整句 —— 改成驗**語意**：講得出筆數、而且那一條真的通往定期定額。
  ok(new RegExp(`${dueDates.length} 筆[^，。]*扣款`).test(homeText),
    `首頁提示列講得出筆數（${dueDates.length}）：「${homeText.slice(0, 44)}…」`);
  const bannerHref = await page.evaluate(() => document.querySelector('#view [data-card="pendingBannerChanges"]')?.getAttribute('href') ?? null);
  eq(bannerHref, '#/plans', '而且那一條帶去定期定額頁（不是股利頁）');

  // =================================================================
  section('情境 2：確認扣款 —— 有填成交價才更新均價');
  // 先確認第一筆，填成交價 100
  const afterFirst = await page.evaluate(async (id) => {
    const hd = await import('./js/holdings.js');
    await hd.confirmChange(id, { deltaShares: 30, price: 100 });
    const db = await import('./js/db.js');
    return db.get('holdings', '0050');
  }, dca[0].id);
  eq(afterFirst.shares, 30, '股數變成 30');
  eq(afterFirst.avgCost, 100, '均價 100（第一筆，原本 0 股）');
  eq(afterFirst.costNote, null, '沒有「少算」的說明');

  // 第二筆：25 股 @120 → (100×30 + 120×25) / 55 = (3000+3000)/55 = 109.090909
  const afterSecond = await page.evaluate(async (id) => {
    const hd = await import('./js/holdings.js');
    await hd.confirmChange(id, { deltaShares: 25, price: 120 });
    const db = await import('./js/db.js');
    return db.get('holdings', '0050');
  }, dca[1].id);
  eq(afterSecond.shares, 55, '股數 55');
  near(afterSecond.avgCost, 109.090909, 1e-5, '加權平均 109.090909（(100×30 + 120×25) ÷ 55）');

  section('沒填成交價 → 均價不動，但要講出來');
  const afterThird = await page.evaluate(async (id) => {
    const hd = await import('./js/holdings.js');
    await hd.confirmChange(id, { deltaShares: 20, price: '' });
    const db = await import('./js/db.js');
    return db.get('holdings', '0050');
  }, dca[2].id);
  eq(afterThird.shares, 75, '股數 75');
  near(afterThird.avgCost, 109.090909, 1e-5, '均價沒有變（第三筆沒填成交價）');
  ok(afterThird.costNote != null, `而且講出來：「${afterThird.costNote}」`);
  ok(afterThird.costNote.includes('1 次'), '說明裡寫「1 次」');
  // 對照組：如果程式偷偷拿收盤價當成交價，均價會變成別的數字
  ok(Math.abs(afterThird.avgCost - 109.090909) < 1e-5,
    '（對照）均價不是把收盤價 150 加權進去的結果');

  section('取消確認之後均價要算得回去');
  const afterUndo = await page.evaluate(async (id) => {
    const hd = await import('./js/holdings.js');
    await hd.deleteChange(id);
    const db = await import('./js/db.js');
    return db.get('holdings', '0050');
  }, dca[1].id);
  eq(afterUndo.shares, 50, '刪掉第二筆 → 股數 30 + 20 = 50');
  eq(afterUndo.avgCost, 100, '均價回到 100（第二筆的加權被撤銷了）');

  // =================================================================
  section('情境 3：配息再投入只有計畫開啟時才產生');
  await reset();
  // 除息日要挑一個**今天之前**的扣款日。挑到今天那一筆的話，
  // 「除息日之後第一個交易日」會落在未來，而 App 不會產生未來的變動 ——
  // 於是這一節會整段拿到空陣列，看起來像功能壞了。
  const exDate = dueDates.filter((d) => d < TODAY).pop() ?? dueDates[0];
  const nextDay = ALL_TRADING_DAYS.find((d) => d > exDate);
  ok(nextDay != null, `除息日 ${exDate}，下一個交易日 ${nextDay}`);
  await seedCloses([{ code: '0050', date: nextDay, close: 100, change: 0, exMark: false }]);

  const makeScenario = (reinvest) => page.evaluate(async ({ rein, ex, start }) => {
    const db = await import('./js/db.js');
    for (const s of ['plans', 'changes', 'events', 'holdings']) await db.clear(s);
    const hd = await import('./js/holdings.js');
    await hd.addOpening({ code: '0050', shares: 1000, date: start });
    const plans = await import('./js/plans.js');
    await plans.save({
      code: '0050', amount: 3000, days: [16], feeRate: 0,
      reinvestDividend: rein, active: true, startDate: start, createdAt: `${start}T00:00:00.000Z`,
    });
    await db.put('events', {
      id: `0050-${ex}`, code: '0050', name: '元大台灣50', exDate: ex, kind: 'cash',
      cashPerShare: 3, stockRate: 0, rightsRate: 0, rightsPrice: 0,
      sharesHeld: 1000, refPrice: null, amountEst: String(3000n * 1000000n),
      amountActual: String(3000n * 1000000n), status: 'confirmed',
    });
  }, { rein: reinvest, ex: exDate, start: START });

  await makeScenario(false);
  await runUpdate();
  const noRein = (await changesOf('0050')).filter((c) => c.kind === 'dividendReinvest');
  eq(noRein.length, 0, '計畫沒開配息再投入 → 不產生再投入的變動');

  await makeScenario(true);
  await runUpdate();
  const withRein = (await changesOf('0050')).filter((c) => c.kind === 'dividendReinvest');
  eq(withRein.length, 1, '計畫開了配息再投入 → 產生一筆');
  eq(withRein[0].date, nextDay, `日期是除息日之後第一個交易日 ${nextDay}`);
  eq(withRein[0].status, 'pending', '一樣是待確認，不自動確認');
  // 手算：3000 元 ÷ 100 元 = 30 股
  eq(withRein[0].deltaShares, 30, '估算 30 股（3,000 元 ÷ 100 元）');
  ok(withRein[0].note.includes('配息再投入'), `說明寫清楚來源：「${withRein[0].note}」`);

  section('再投入不會重複產生');
  await runUpdate();
  eq((await changesOf('0050')).filter((c) => c.kind === 'dividendReinvest').length, 1, '重跑還是一筆');

  // =================================================================
  section('情境 4：拿不到扣款日收盤價 —— 仍然產生，股數留空');
  await reset();
  await page.evaluate(async (start) => {
    const plans = await import('./js/plans.js');
    await plans.save({
      code: '2330', amount: 5000, days: [16], feeRate: 0,
      reinvestDividend: false, active: true, startDate: start, createdAt: `${start}T00:00:00.000Z`,
    });
  }, START);
  const upd4 = await runUpdate();
  const noClose = (await changesOf('2330')).filter((c) => c.kind === 'dca');
  ok(noClose.length >= 1, `還是產生了 ${noClose.length} 筆待確認 —— 扣款是真的發生了`);
  everyOf(noClose, (c) => c.deltaShares === null, '股數是 null（不是 0）');
  noneOf(noClose, (c) => c.deltaShares === 0, '沒有任何一筆股數是 0');
  everyOf(noClose, (c) => c.note.includes('尚未取得當日收盤價'), '每一筆都講了原因');
  ok(upd4.problems.some((p) => p.includes('股數留空')), `更新結果也帶得出來：「${upd4.problems[0]}」`);

  const t4 = await showView('plans', '#view [data-card="pendingChanges"]');
  ok(t4.includes('股數待填'), '畫面顯示「股數待填」');
  noneOf([t4], (t) => /估\s*0\s*股/.test(t), '沒有出現「估 0 股」');

  section('股數留空的那筆，不填股數就不能確認');
  const cannotConfirm = await page.evaluate(async (id) => {
    const hd = await import('./js/holdings.js');
    try { await hd.confirmChange(id, {}); return null; } catch (e) { return String(e.message); }
  }, noClose[0].id);
  eq(cannotConfirm, '確認的時候要填股數', '擋下來並說清楚要填什麼');

  // =================================================================
  section('情境 5：扣款日的收盤價要自己去回補（不是等別人餵）');
  // 前面的情境都先把 closes 塞好了，測不到「程式知不知道要去抓那幾個月」。
  // 這裡完全不塞，讓它自己決定要回補哪些月份 —— 少了這一段，
  // 「跳過三個月再開 App」在真實環境會三筆都估不出股數。
  await reset();
  await page.evaluate(async ({ days, monthsWanted }) => {
    // 假的 STOCK_DAY：照要求的月份回那個月的逐日收盤（收盤一律 100）
    window.__stockDayMonths = [];
    const tradingDays = days;
    const real = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (url.includes('twse.com.tw') && url.includes('STOCK_DAY?')) {
        const d = new URL(url).searchParams.get('date');
        const month = `${d.slice(0, 4)}-${d.slice(4, 6)}`;
        window.__stockDayMonths.push(month);
        const rows = tradingDays.filter((x) => x.startsWith(month)).map((x) => {
          const [y, m, dd] = x.split('-');
          return [`${Number(y) - 1911}/${m}/${dd}`, '1,000', '100,000', '100.00', '100.00', '100.00', '100.00', '+0.00', '10', ''];
        });
        return new Response(JSON.stringify({
          stat: 'OK',
          title: `月報`,
          fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'],
          data: rows,
        }), { status: 200 });
      }
      return real(input, init);
    };
    void monthsWanted;
  }, { days: ALL_TRADING_DAYS, monthsWanted: months });

  await page.evaluate(async (start) => {
    const plans = await import('./js/plans.js');
    await plans.save({
      code: '0050', amount: 3000, days: [16], feeRate: 0,
      reinvestDividend: false, active: true, startDate: start, createdAt: `${start}T00:00:00.000Z`,
    });
  }, START);

  const upd5 = await runUpdate();
  const fetched = await page.evaluate(() => window.__stockDayMonths);
  const dca5 = (await changesOf('0050')).filter((c) => c.kind === 'dca');
  eq(dca5.length, dueDates.length,
    `自己回補之後還是產生 ${dueDates.length} 筆（${upd5.status}）`);
  everyOf(dca5, (c) => c.deltaShares === 30,
    `${dueDates.length} 筆都估出 30 股（3,000 元 ÷ 100 元）`);
  noneOf(dca5, (c) => c.deltaShares == null, '沒有任何一筆的股數是空的');
  everyOf(months, (m) => fetched.includes(m), `回補的月份涵蓋三個扣款月：要 ${months.join('、')}，實際抓了 ${[...new Set(fetched)].join('、')}`);

  section('沒有頁面錯誤');
  eq(pageErrors.filter((t) => !/favicon|503|Failed to load resource/i.test(t)), [], '沒有未預期的錯誤');
} finally {
  await browser.close();
  srv.close();
}

// 這裡不是斷言 —— 「有跑到最後一行」這件事本來就由 done() 的斷言數反映。
// 以前寫成 everyOf([1], () => true, …)：述詞是常數、母體是寫死的，永遠不會失敗，
// 卻混進通過數裡，看起來像多驗了一件事。
note('測試跑完了');
done('dcatest');
