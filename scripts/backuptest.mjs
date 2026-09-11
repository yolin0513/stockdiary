// 匯出／匯入（npm run backuptest）。
//
// 三件事：
//   1. **round-trip**：匯出 → 清空 → 匯入，資料一模一樣（連欄位順序以外的細節都一樣）
//   2. **備份檔不含金鑰**：真的存一把金鑰再匯出，斷言檔案裡看不到它；
//      而且匯入之後那把金鑰還在（匯入不碰 secrets）
//   3. **壞檔案要擋下來並講清楚原因**，每一種拒絕都附對照組

import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { validateImport, parseBackup, FORMAT, FORMAT_VERSION, filenameFor } from '../js/backup.js';
import { EXPORTABLE_STORES } from '../js/db.js';

const FAKE_KEY = 'sk-ant-api03-BBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL-BaCkUp77';

// ---------------------------------------------------------------------------
section('檔名');
const fn = filenameFor(new Date(2026, 8, 11, 9, 5));
eq(fn, 'stockdiary-20260911-0905.json', '檔名帶日期時間，一眼看得出是哪一份');

// ---------------------------------------------------------------------------
section('壞檔案擋得下來，而且講得出原因');
const good = { format: FORMAT, formatVersion: FORMAT_VERSION, data: Object.fromEntries(EXPORTABLE_STORES.map((s) => [s, []])) };
ok(validateImport(good).ok, '（對照）正常的備份檔過得了 —— 不是「什麼都擋」');

const bads = [
  { what: 'null', v: null },
  { what: '陣列', v: [] },
  { what: '字串', v: 'hello' },
  { what: '別的 App 的檔案', v: { format: 'tripquest-backup', formatVersion: 1, data: {} } },
  { what: '沒有 format', v: { formatVersion: 1, data: {} } },
  { what: '沒有版本號', v: { format: FORMAT, data: {} } },
  { what: '更新版本的格式', v: { format: FORMAT, formatVersion: FORMAT_VERSION + 1, data: {} } },
  { what: '沒有 data', v: { format: FORMAT, formatVersion: 1 } },
  { what: 'data 不是物件', v: { format: FORMAT, formatVersion: 1, data: [] } },
  { what: '夾帶 secrets', v: { format: FORMAT, formatVersion: 1, data: { holdings: [], secrets: [{ key: FAKE_KEY }] } } },
  { what: '認不得的 store', v: { format: FORMAT, formatVersion: 1, data: { holdings: [], evilStore: [] } } },
  { what: 'store 內容不是清單', v: { format: FORMAT, formatVersion: 1, data: { holdings: {} } } },
];
const results = bads.map((b) => ({ ...b, r: validateImport(b.v) }));
everyOf(results, (x) => x.r.ok === false, '每一種壞檔案都被擋下來');
everyOf(results, (x) => typeof x.r.error === 'string' && x.r.error.length >= 8,
  '每一種都講得出原因（不是只回一句「格式錯誤」）');
// 夾帶金鑰那一份特別重要：不能靜默忽略，要明確拒絕
const smuggle = results.find((x) => x.what === '夾帶 secrets');
ok(smuggle.r.error.includes('secrets'), `夾帶金鑰的檔案被明確點名拒絕：「${smuggle.r.error}」`);
// 版本比較新的那份，訊息要告訴使用者該做什麼
const newer = results.find((x) => x.what === '更新版本的格式');
ok(newer.r.error.includes('更新'), `版本太新時告訴使用者去更新 App：「${newer.r.error}」`);

eq(parseBackup('{ 壞掉的 json').ok, false, 'JSON 壞掉也擋得下來');
ok(parseBackup('{ 壞掉的 json').error.includes('JSON'), '而且說得出是 JSON 壞了');

section('缺了某個 store 不算錯，但要講出來');
const partial = validateImport({ format: FORMAT, formatVersion: 1, data: { holdings: [{ code: '2330' }] } });
ok(partial.ok, '只有 holdings 的備份檔可以匯入');
eq(partial.missing.sort(), EXPORTABLE_STORES.filter((s) => s !== 'holdings').sort(),
  '而且列出缺了哪些 —— 匯入之後那幾項會是空的，使用者要先知道');
eq(partial.counts.holdings, 1, '算得出每一項有幾筆');

// ---------------------------------------------------------------------------
const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  section('round-trip：匯出 → 清空 → 匯入，資料一模一樣');
  const trip = await page.evaluate(async (KEY) => {
    const db = await import('./js/db.js');
    const backup = await import('./js/backup.js');
    const holdings = await import('./js/holdings.js');
    const plans = await import('./js/plans.js');
    const prefs = await import('./js/prefs.js');
    const secrets = await import('./js/secrets.js');

    for (const s of db.EXPORTABLE_STORES) await db.clear(s);
    await db.clear('secrets');

    // 放一批有代表性的資料：兩檔持股、幾筆異動、一個計畫、改過的設定
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 850.5, date: '2026-09-01', note: '開帳' });
    await holdings.addChange({ code: '2330', date: '2026-09-05', deltaShares: 500, price: 900, kind: 'manual' });
    await holdings.addOpening({ code: '2317', shares: 2000, avgCost: null, date: '2026-09-02' });
    await plans.save({ code: '2330', amount: 5000, days: [6, 16], feeRate: 0.001425, reinvest: true });
    await prefs.load();
    await prefs.set('fontScale', 'xl');
    await prefs.set('dayPLIncludeDividend', false);
    await secrets.save({ key: KEY });

    const before = {};
    for (const s of db.EXPORTABLE_STORES) before[s] = await db.getAll(s);

    const payload = await backup.buildExport();
    const text = JSON.stringify(payload);

    // 全部清掉（連金鑰也留著，等一下確認匯入沒動到它）
    for (const s of db.EXPORTABLE_STORES) await db.clear(s);
    const emptied = {};
    for (const s of db.EXPORTABLE_STORES) emptied[s] = (await db.getAll(s)).length;

    const parsed = backup.parseBackup(text);
    const wrote = parsed.ok ? await backup.applyImport(parsed.data) : null;

    const after = {};
    for (const s of db.EXPORTABLE_STORES) after[s] = await db.getAll(s);

    const sortKey = (r) => JSON.stringify(r);
    const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))]));

    return {
      parsedOk: parsed.ok,
      parsedError: parsed.error ?? null,
      emptiedTotal: Object.values(emptied).reduce((a, b) => a + b, 0),
      wrote,
      same: JSON.stringify(norm(before)) === JSON.stringify(norm(after)),
      beforeCounts: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length])),
      afterCounts: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.length])),
      exportText: text,
      keyStillThere: (await secrets.status()).configured,
      fontScale: prefs.get('fontScale'),
    };
  }, FAKE_KEY);

  ok(trip.parsedOk, `匯出的檔案自己匯得回去${trip.parsedError ? `（${trip.parsedError}）` : ''}`);
  ok(Object.values(trip.beforeCounts).reduce((a, b) => a + b, 0) >= 5,
    `（對照）測試資料不是空的：${JSON.stringify(trip.beforeCounts)}`);
  eq(trip.emptiedTotal, 0, '中間確實清空過 —— 不然 round-trip 是假的');
  ok(trip.same, '匯入之後每一筆都跟匯出前一模一樣',
    `之前 ${JSON.stringify(trip.beforeCounts)}、之後 ${JSON.stringify(trip.afterCounts)}`);
  eq(trip.afterCounts, trip.beforeCounts, '每個 store 的筆數都對得上');
  eq(trip.fontScale, 'xl', '設定也還原了（字級）');

  section('備份檔不含金鑰，匯入也不動金鑰');
  ok(!trip.exportText.includes(FAKE_KEY), '**匯出的檔案裡沒有金鑰**');
  ok(!trip.exportText.includes('sk-ant'), '連 sk-ant 這個前綴都沒有');
  ok(!trip.exportText.includes('secrets'), '檔案裡連 secrets 這個字都沒有出現');
  ok(trip.keyStillThere, '匯入之後，這台裝置上原本的金鑰還在 —— 匯入不碰 secrets');

  section('匯入夾帶金鑰的檔案：擋下來，而且真的沒寫進去');
  const smuggled = await page.evaluate(async (KEY) => {
    const db = await import('./js/db.js');
    const backup = await import('./js/backup.js');
    await db.clear('secrets');
    const evil = JSON.stringify({
      format: 'stockdiary-backup', formatVersion: 1,
      data: { holdings: [{ code: '2330' }], secrets: [{ provider: 'anthropic', key: KEY }] },
    });
    const parsed = backup.parseBackup(evil);
    // 就算有人繞過檢查直接呼叫 applyImport，也不可以寫進 secrets
    await backup.applyImport(JSON.parse(evil).data);
    return {
      refused: !parsed.ok,
      error: parsed.error ?? null,
      secretsRows: (await db.getAll('secrets')).length,
      holdingsRows: (await db.getAll('holdings')).length,
    };
  }, FAKE_KEY);
  ok(smuggled.refused, `檢查階段就擋下來了：「${smuggled.error}」`);
  eq(smuggled.secretsRows, 0,
    '**就算直接呼叫 applyImport 繞過檢查，secrets 也一筆都沒被寫進去**（它只走 EXPORTABLE_STORES）');
  eq(smuggled.holdingsRows, 1, '（對照）同一份檔案裡的 holdings 確實寫進去了 —— 不是整個沒執行');

  section('畫面上的匯出按鈕真的產生得出檔案');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('#view [data-card="backup"]');
  const uiExport = await page.evaluate(async () => {
    // 攔兩個東西：createObjectURL（拿得到 Blob 本體）與 a.click()（拿得到檔名）。
    // 不要用 fetch(blob:) 去讀 —— CSP 的 connect-src 沒有開 blob:，會被擋下。
    // （下載本身不受影響：a[download] 是下載不是 fetch。）
    const card = document.querySelector('#view [data-card="backup"]');
    let captured = null;
    let blob = null;
    const origCreate = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function patched(b) { blob = b; return origCreate.call(URL, b); };
    HTMLAnchorElement.prototype.click = function patched() {
      if (this.download) captured = { name: this.download, href: this.href };
      else origClick.call(this);
    };
    card.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 800));
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
    return {
      captured,
      text: blob ? await blob.text() : null,
      blobType: blob?.type ?? null,
      hrefIsBlob: (captured?.href ?? '').startsWith('blob:'),
      status: card.textContent,
    };
  });
  ok(uiExport.captured?.name?.endsWith('.json'), `按下匯出會下載一個 .json（${uiExport.captured?.name}）`);
  ok(uiExport.hrefIsBlob, '下載用的是 blob: 網址（不會把資料送去任何伺服器）');
  eq(uiExport.blobType, 'application/json', 'Blob 的型別是 application/json');
  ok(uiExport.text && uiExport.text.includes('"format"'), '而且檔案內容是備份格式');
  ok(!uiExport.text.includes('sk-ant'), '畫面匯出的檔案裡也沒有金鑰');
  ok(/已匯出\s*\d+\s*筆/.test(uiExport.status), '畫面上回報匯出了幾筆');

  section('沒打勾就按匯入：什麼都不做');
  const noConfirm = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const before = (await db.getAll('holdings')).length;
    const card = document.querySelector('#view [data-card="backup"]');
    const btns = [...card.querySelectorAll('button')];
    btns[btns.length - 1].click();
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: (await db.getAll('holdings')).length, text: card.textContent };
  });
  eq(noConfirm.after, noConfirm.before, '資料沒有被動到');
  ok(noConfirm.text.includes('先打勾'), '而且畫面講清楚要先打勾');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('backuptest');
