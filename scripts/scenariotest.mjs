// 真實情境端對端（npm run scenariotest）。
//
// 這支補的是**健檢掃出來完全沒有測試涵蓋**的三個情境。它們的共同點是
// 「平常不會遇到，遇到的時候會算錯，而且使用者看不出算錯了」：
//
//   1. **除權息日剛好是定期定額扣款日**
//      那天的「收盤價」是除息後的價、「參考價」是另一個數字。估股數該用哪個？
//      用錯的話股數會偏，而且畫面上完全看不出來。
//
//   2. **停牌／當日無成交的持股走到結算**
//      TWSE 對沒成交的證券把收盤價寫成空字串、漲跌價差寫成 "0.0000"。
//      照抄的話畫面會出現一筆「看起來很正常的持平」。
//      parsetest 有守解析層，但**沒有任何測試走完整條結算路徑**。
//
//   3. **同一天既除息又沒成交**
//      兩個降級路徑交叉，最容易冒出一個湊出來的數字。
//
// 三個情境都用**手算對照**：先寫出應該是多少，再斷言畫面與資料庫。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay, DEFAULT_TODAY_THRESHOLD } from '../js/market.js';
import { isoToRocCompact } from '../js/roc.js';

/** TWT48U／TWT49U 的日期格式是「115年09月11日」。 */
const rocChars = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1911}年${m}月${d}日`;
};

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const cal = makeCalendar(calJson);
// calendar.json 是多年格式（{ years: { "2026": {...} } }），沒有頂層的 tradingDays。
// makeCalendar 同時讀得懂新舊兩種格式，所以一律從它的 days 拿。
const ALL_TRADING_DAYS = cal.days;

const TODAY = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
section('測試前提');
ok(TODAY != null, `應公布的最新交易日：${TODAY}`, 'data/calendar.json 可能過期了 → npm run build-calendar');
if (!TODAY) done('scenariotest');
const PREV = ALL_TRADING_DAYS.filter((d) => d < TODAY).pop();
ok(PREV != null, `前一個交易日：${PREV}`);

const CSV_HEADER = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
/** rows: [代號, 名稱, 收盤(null 代表沒成交), 漲跌字串] */
const dayAllCsv = (date, rows) => `${[CSV_HEADER, ...rows.map(([c, n, close, chg]) => (close == null
  // 沒成交：價格欄全空，但**漲跌價差照樣寫 0.0000** —— 這是 TWSE 真的會回的形狀
  ? `"${isoToRocCompact(date)}","${c}","${n}","0","0","","","","","${chg}","0"`
  : `"${isoToRocCompact(date)}","${c}","${n}","1000","1000","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${close.toFixed(2)}","${chg}","10"`))].join('\n')}\n`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const { srv, port } = await listen(0);
const pageErrors = [];

/**
 * 開一個乾淨的頁面，並用假的 fetch 餵 TWSE 三個端點。
 *
 * ⚠ 同一個瀏覽器的分頁**共用 IndexedDB**，所以每個情境都要清掉 **db.STORE_NAMES
 * 全部**，不能只清 EXPORTABLE_STORES —— `settle` 與 `closes` 不在那份清單裡，
 * 上一個情境的結算會殘留下來，於是測試量到的是上一個情境的數字。（踩過。）
 */
async function freshApp({ csvToday, csvPrev, t48 = [], t49 = [] }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.evaluateOnNewDocument((fx) => {
    const real = window.fetch.bind(window);
    window.__calls = [];
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes('twse.com.tw')) return real(input, init);
      window.__calls.push(url);
      if (url.includes('STOCK_DAY_ALL')) return new Response(fx.csvToday, { status: 200 });
      if (url.includes('TWT48U')) return new Response(JSON.stringify({ stat: 'OK', fields: fx.t48Fields, data: fx.t48 }), { status: 200 });
      if (url.includes('TWT49U')) return new Response(JSON.stringify({ stat: 'OK', fields: fx.t49Fields, data: fx.t49 }), { status: 200 });
      if (url.includes('STOCK_DAY')) return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }), { status: 200 });
      return new Response('{}', { status: 200 });
    };
  }, {
    csvToday,
    t48,
    t49,
    t48Fields: ['除權除息日期', '股票代號', '名稱', '除權息', '無償配股率', '現金增資配股率', '現金增資認購價', '現金股利',
      '詳細資料', '參考價<br>試算', '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
    t49Fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息', '漲停價格', '跌停價格', '開盤競價基準', '減除股利參考價', '詳細資料', '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
  });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');
  // **先清乾淨再種資料**，順序反了的話種進去的前收價會被自己清掉。
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    for (const s of db.STORE_NAMES) await db.clear(s);
  });
  // 前一日的收盤價直接寫進 closes，不必再模擬一次回補
  if (csvPrev) {
    await page.evaluate(async (rows) => {
      const db = await import('./js/db.js');
      for (const r of rows) await db.put('closes', r);
    }, csvPrev);
  }
  // **清完一定要重載。** 開機時 App 自己會跑一次 store.update()，那一次用的是
  // 上一個情境殘留的資料，而且會把「已結算到今天」快取在記憶體裡；
  // 不重載的話，後面再呼叫 update() 會直接回 upToDate 什麼都不做。（踩過。）
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');
  return page;
}

try {
  // =========================================================================
  section('情境 1：除權息日剛好是定期定額扣款日');
  // 2330 今天除息 10 元：前收 2460 → 參考價 2450，而當天實際收盤 2455。
  // **估股數要用當天的實際收盤價 2455**（券商就是照市價成交），
  // 不是參考價 2450，也不是前收 2460。三個數字差很多，用錯看不出來。
  {
    const page = await freshApp({
      csvToday: dayAllCsv(TODAY, [['2330', '台積電', 2455, 'X0.00']]),
      csvPrev: [{ code: '2330', date: PREV, close: 2460 }],
      t48: [[rocChars(TODAY), '2330', '台積電', '息', '0.000000', '0.000000', '0.00', '10.00000000']],
      t49: [[rocChars(TODAY), '2330', '台積電', '2,460.00', '2,450.00', '10.00', '息', '2,695.00', '2,205.00', '2,450.00', '2,450.00', '', '', '', '']],
    });

    const r = await page.evaluate(async (args) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const plans = await import('./js/plans.js');
      const store = await import('./js/store.js');

      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' });
      // 扣款日就設成今天（除息日）。startDate 要早於扣款日，不然那一期不會產生。
      await plans.save({
        code: '2330', amount: 100000, days: [Number(args.today.slice(8, 10))], feeRate: 0,
        reinvestDividend: false, active: true,
        startDate: args.start, createdAt: `${args.start}T00:00:00.000Z`,
      });
      await store.update();

      const changes = await db.getAll('changes');
      const dca = changes.filter((c) => c.kind === 'dca');
      const settle = await db.get('settle', args.today);
      return {
        dca: dca.map((c) => ({ date: c.date, shares: c.deltaShares, estPrice: c.estimatePrice, status: c.status })),
        settleRow: settle?.byCode?.find((x) => x.code === '2330') ?? null,
      };
    }, { today: TODAY, start: `${TODAY.slice(0, 8)}01` });

    eq(r.dca.length, 1, '除息日那天照樣產生了一筆待確認扣款');
    eq(r.dca[0].status, 'pending', '而且是待確認，不會自動確認');
    eq(r.dca[0].estPrice, 2455,
      '**估算用的是當天的實際收盤價 2455** —— 不是參考價 2450，也不是前收 2460');
    // 手算：100000 ÷ 2455 = 40.73… → 40 股
    eq(r.dca[0].shares, 40, '手算 100000 ÷ 2455 = 40 股（無條件捨去）');
    // 對照：如果誤用參考價 2450 會得到 40 股（一樣），用前收 2460 也是 40 股 ——
    // 所以股數本身分不出來，真正分得出來的是 estimatePrice。這一條才是關鍵。
    ok(r.dca[0].estPrice !== 2450 && r.dca[0].estPrice !== 2460,
      `（對照）三個候選價 2455／2450／2460 各不相同，所以上一條分得出用了哪一個`);

    // 有參考價的除息日就是正常算得出來的狀態（status 'ok'）；
    // 真正分得出「有沒有用參考價」的是 basis 這個數字。
    eq(r.settleRow?.status, 'ok', '有參考價，所以這一檔算得出來');
    eq(r.settleRow?.basis, 2450,
      '而**當日損益的基準用的是參考價 2450**（不是前收 2460）—— 跟估股數用的 2455 是兩回事');
    // 手算：(2455 − 2450) × 1000 股 = +5,000 元。若誤用前收 2460 會變成 −5,000。
    // pl 在資料庫裡是**微元字串**（BigInt 沒辦法存進 IndexedDB／跨 puppeteer 邊界）
    eq(String(r.settleRow?.pl), '5000000000', '手算 (2455 − 2450) × 1000 ＝ +5,000 元');
    ok(!String(r.settleRow?.pl).startsWith('-'),
      '**不是負的** —— 用前收當基準的話這裡會是 −5,000，那就是除息日的假虧損');
    await page.close();
  }

  // =========================================================================
  section('情境 2：停牌／當日無成交的持股走到結算');
  // TWSE 對沒成交的證券：價格欄全空，**漲跌價差卻寫 "0.0000"**。
  // 照抄的話畫面會出現一筆看起來很正常的「持平」。
  {
    const page = await freshApp({
      csvToday: dayAllCsv(TODAY, [
        ['2330', '台積電', 2450, '-15.0000'],
        // 2317 當天沒成交：價格欄全空，漲跌價差卻是 "0.0000"（TWSE 真的這樣回）
        ['2317', '鴻海', null, '0.0000'],
      ]),
      csvPrev: [{ code: '2330', date: PREV, close: 2465 }, { code: '2317', date: PREV, close: 200 }],
    });

    const r = await page.evaluate(async (today) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const store = await import('./js/store.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' });
      await holdings.addOpening({ code: '2317', shares: 500, avgCost: 150, date: '2026-01-05' });
      const upd = await store.update();
      const settle = await db.get('settle', today);
      // hash 本來就是 '#/'，再設一次不會觸發重繪 —— 要直接叫首頁重畫一次，
      // 不然量到的是開機當下（還沒有持股）的畫面。
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((r2) => setTimeout(r2, 200));
      const view = document.querySelector('#view');
      return {
        rows: (settle?.byCode ?? []).map((x) => ({ code: x.code, close: x.close, pl: x.pl == null ? null : String(x.pl), status: x.status })),
        debug: {
          upd: JSON.stringify(upd ?? null, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)).slice(0, 300),
          settleDates: (await db.getAll('settle')).map((x) => x.date),
          closes: (await db.getAll('closes')).map((x) => `${x.code}@${x.date}=${x.close}`),
        },
        counted: settle?.counted ?? null,
        dayPL: settle?.dayPL ?? null,
        text: view.textContent.replace(/\s+/g, ' '),
      };
    }, TODAY);

    const halted = r.rows.find((x) => x.code === '2317');
    ok(halted != null, '停牌那一檔仍然出現在結算裡（不是默默消失）',
      `實際結算了這幾檔：${JSON.stringify(r.rows)}
      DEBUG ${JSON.stringify(r.debug)}`);
    if (!halted) { await page.close(); throw new Error('停牌那一檔沒有進結算，先看上面的實際內容'); }
    eq(halted.close, null, '**它的收盤價是 null，不是 0**');
    eq(halted.pl, null, '**它的當日損益是 null，不是 0** —— 沒成交不等於持平');
    const traded = r.rows.find((x) => x.code === '2330');
    // 手算：(2450 − 2465) × 1000 股 ＝ −15,000 元。
    // （原本這裡寫成拿 traded.pl 跟自己比 —— 那是恆真的假斷言，自己踩到了。）
    eq(String(traded.pl), '-15000000000', '（對照）有成交那一檔手算 (2450 − 2465) × 1000 ＝ −15,000 元');
    eq(traded.close, 2450, '（對照）有成交的收盤價正常讀到');
    ok(r.text.includes('不含') || r.text.includes('尚未取得'),
      '畫面講出有幾檔沒算進去', r.text.slice(0, 160));
    noneOf(r.rows, (x) => x.close === 0 || String(x.pl) === '0',
      '沒有任何一列的收盤價或損益是 0（「不知道」不可以變成 0）');
    await page.close();
  }

  // =========================================================================
  section('情境 3：同一天既除息、又沒成交');
  // 兩個降級路徑交叉。最危險的是「用參考價減去 null」湊出一個數字。
  {
    const page = await freshApp({
      csvToday: dayAllCsv(TODAY, [['2330', '台積電', null, 'X0.00']]),
      csvPrev: [{ code: '2330', date: PREV, close: 2460 }],
      t48: [[rocChars(TODAY), '2330', '台積電', '息', '0.000000', '0.000000', '0.00', '10.00000000']],
      t49: [[rocChars(TODAY), '2330', '台積電', '2,460.00', '2,450.00', '10.00', '息', '2,695.00', '2,205.00', '2,450.00', '2,450.00', '', '', '', '']],
    });

    const r = await page.evaluate(async (today) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const store = await import('./js/store.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' });
      await store.update();
      const settle = await db.get('settle', today);
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((r2) => setTimeout(r2, 200));
      return {
        row: settle?.byCode?.find((x) => x.code === '2330') ?? null,
        dayPL: settle?.dayPL ?? null,
        counted: settle?.counted ?? null,
        text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    }, TODAY);

    eq(r.row?.close, null, '收盤價是 null');
    eq(r.row?.pl, null, '**損益是 null —— 不會拿參考價去減一個不存在的收盤價**');
    eq(r.dayPL, null, '當日損益整個是 null');
    eq(r.counted, 0, '一檔都沒算進去');
    noneOf([r.text], (t) => /當日損益\s*[+-]?[\d,]+/.test(t),
      '畫面上的當日損益沒有生出一個數字');
    // 這條原本是 `/當日損益\\s*—/.test(r.text) || r.text.includes('—')`：
    // 前半跳脫壞掉永遠不成立，後半只是「這一頁有破折號」—— 而破折號在那個畫面上到處都是。
    // 改成只看**當日損益那一格**，而且要求它就是破折號。
    ok(/當日損益\s*—/.test(r.text),
      `當日損益那一格顯示「—」：「${/當日損益[^持]{0,12}/.exec(r.text)?.[0]}」`);
    await page.close();
  }

  // =========================================================================
  section('情境 4：除息日，參考價既查不到也算不出來');
  //
  // 這一段是突變測試逼出來的：「除息日拿不到參考價就退回前一日收盤」那條突變
  // **改壞了 settle.js 但 scenariotest 還是綠的** —— 因為前三個情境每一個都餵了
  // TWT49U 的參考價，那條 fallback 路徑一次都沒走到。
  //
  // 真的會發生：TWT48U 的預告表有這一天（所以知道要除息），但**現金股利還沒公告**
  // （TWSE 對 ETF 常寫「待公告實際收益分配金額」），而 TWT49U 的結果表只留最近一次，
  // 查不到這一天。此時參考價既拿不到、也推導不出來。
  //
  // 唯一正確的行為是**不算這一檔**。拿前收當基準的話，畫面會生出一筆
  // 等於息值的假虧損，而且看起來完全正常。
  {
    const page = await freshApp({
      csvToday: dayAllCsv(TODAY, [['2330', '台積電', 2455, 'X0.00']]),
      csvPrev: [{ code: '2330', date: PREV, close: 2460 }],
      // 現金股利欄位寫「待公告實際收益分配金額」→ 解出來是 null → 推導不出參考價
      t48: [[rocChars(TODAY), '2330', '台積電', '息', '0.000000', '0.000000', '0.00', '待公告實際收益分配金額']],
      t49: [],   // 結果表查不到這一天
    });

    const r = await page.evaluate(async (today) => {
      const db = await import('./js/db.js');
      const holdings = await import('./js/holdings.js');
      const store = await import('./js/store.js');
      await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' });
      await store.update();
      const settle = await db.get('settle', today);
      const home = await import('./js/views/home.js');
      await home.default();
      await new Promise((r2) => setTimeout(r2, 200));
      return {
        row: settle?.byCode?.find((x) => x.code === '2330') ?? null,
        dayPL: settle?.dayPL ?? null,
        counted: settle?.counted ?? null,
        text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      };
    }, TODAY);

    ok(r.row != null, '這一檔還在結算紀錄裡（不是默默消失）', JSON.stringify(r.row));
    eq(r.row?.close, 2455, '（前提）當天有成交，收盤價讀得到');
    eq(r.row?.status, 'exNoRef', '狀態是「除權息日，尚未取得參考價」');
    eq(r.row?.basis, null, '**基準價是 null —— 沒有退回前一日收盤 2460**');
    eq(r.row?.basisSource, 'none', '而且來源標成 none，不是 prevClose');
    eq(r.row?.pl, null, '這一檔的當日損益是 null');
    eq(r.dayPL, null, '整體當日損益也是 null，不是一個湊出來的數字');
    eq(r.counted, 0, '一檔都沒算進去');
    // 手算：拿前收當基準會得到 (2455 − 2460) × 1000 ＝ −5,000。
    // 那個數字**一次都不可以出現**，畫面上也不行。
    noneOf([String(r.row?.pl), String(r.dayPL), r.text],
      (t) => t.includes('-5000000000') || t.includes('-5,000'),
      '**「−5,000」這個假虧損一次都沒出現** —— 那正是拿前收當基準會算出來的數字');
    ok(r.text.includes('參考價'), `畫面講出卡在哪裡：「${/有持股在這一天除權息[^。]{0,40}/.exec(r.text)?.[0] ?? r.text.slice(0, 80)}」`);
    await page.close();
  }

  eq(pageErrors.filter((e) => !/favicon/.test(e)), [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('scenariotest');
