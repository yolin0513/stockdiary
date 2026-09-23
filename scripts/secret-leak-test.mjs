// 金鑰不會外洩（npm run secret-leak-test）。
//
// 這支的預設立場是「金鑰一定會從某個縫隙漏出去」，然後一個一個把縫堵死：
//
//   1. **結構性**：金鑰住在 `secrets` store，而它不在 `db.EXPORTABLE_STORES` 裡。
//      所有匯出／備份的程式碼只走那份清單 —— 讀不到，不是靠記得排除。
//   2. **靜態**：除了 js/secrets.js 之外，沒有任何檔案碰 'secrets' 這個 store。
//   3. **執行期**：真的存一把金鑰進瀏覽器，然後把所有「會變成字串給人看」的路徑
//      全部走一遍（匯出、JSON.stringify 整個 DB、錯誤訊息、AI 輸出、畫面 DOM），
//      每一條都斷言看不到那把金鑰。
//
// 用的是一把**格式合法但不存在**的假金鑰。真的打 API 的驗證在 livecheck。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { listen } from './serve.mjs';
import { stripComments } from './srcscan.mjs';
import { scrub, mask, checkFormat, costMicroUsd, monthOf, buildRequest, MODELS, DEFAULT_CAP_MICRO_USD } from '../js/secrets.js';
import { EXPORTABLE_STORES, STORE_NAMES } from '../js/db.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 格式合法、但不是真的。長度與前綴都像真的，才測得出遮罩與掃描器。
const FAKE_KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK-LeAkMe99';

// ---------------------------------------------------------------------------
section('結構性：匯出範圍不包含 secrets');
ok(STORE_NAMES.includes('secrets'), 'secrets 確實是一個獨立的 object store');
ok(!EXPORTABLE_STORES.includes('secrets'), 'EXPORTABLE_STORES 不含 secrets');
everyOf(EXPORTABLE_STORES, (s) => STORE_NAMES.includes(s), '匯出清單裡的每一個 store 都真的存在');
ok(EXPORTABLE_STORES.length >= 4,
  `而且匯出清單不是空的（${EXPORTABLE_STORES.length} 個：${EXPORTABLE_STORES.join('、')}）—— `
  + '空清單會讓上面那條「不含 secrets」變成廢話');

// ---------------------------------------------------------------------------
section('靜態：只有 js/secrets.js 碰得到那個 store');
const jsFiles = [
  ...fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'js/views')).filter((f) => f.endsWith('.js')).map((f) => `js/views/${f}`),
];
const touchesStore = (rel) => /['"]secrets['"]/.test(stripComments(read(rel)));
const offenders = jsFiles.filter((f) => f !== 'js/secrets.js' && f !== 'js/db.js' && touchesStore(f));
eq(offenders, [], '除了 secrets.js 與 db.js，沒有別的檔案提到 secrets store');
ok(touchesStore('js/secrets.js'), '（對照）secrets.js 自己當然有提到 —— 上面那條不是因為掃描器壞掉');

// 沒有人把金鑰寫進 log
const logsKey = jsFiles.filter((f) => /console\.(log|warn|error)\([^)]*\bkey\b/.test(stripComments(read(f))));
eq(logsKey, [], '沒有任何檔案把 key 印進 console');

// ---------------------------------------------------------------------------
section('scrub()：任何字串裡的金鑰都要被抹掉');
ok(!scrub(`出錯了：${FAKE_KEY}`).includes(FAKE_KEY), '錯誤訊息裡的金鑰被抹掉');
ok(!scrub(JSON.stringify({ headers: { 'x-api-key': FAKE_KEY } })).includes(FAKE_KEY), 'JSON 裡的也是');
ok(!scrub(`前${FAKE_KEY}後`).includes(FAKE_KEY), '前後黏著字也抓得到');
eq(scrub('完全沒有金鑰的一句話'), '完全沒有金鑰的一句話', '沒有金鑰的字串原樣不動');
eq(scrub(null), null, 'null 不會變成字串 "null"');
detects((t) => scrub(t) !== t, {
  shouldHit: [FAKE_KEY, `a${FAKE_KEY}`, 'sk-ant-api03-x_y-Z', `錯誤：${FAKE_KEY} 無效`],
  shouldMiss: ['sk-ant', 'sk-', '一般的句子', 'ANTHROPIC_API_KEY 環境變數'],
}, 'scrub 抓得到金鑰，也不會把正常字串改掉');

section('mask()：只露得出「是哪一把」，露不出「能用的內容」');
const masked = mask(FAKE_KEY);
ok(!masked.includes(FAKE_KEY), '遮罩裡沒有完整金鑰');
ok(masked.endsWith(FAKE_KEY.slice(-4)), `看得出是哪一把（${masked}）`);
ok(masked.length < 20, '遮罩很短，不可能把主體露出來');
// 母體要是**中段的每一截**，不是手挑的兩段（2026-09-23 D2）：以前只驗 slice(7,30) 與 slice(10,40) 兩段，
// 一個「多露出中間五個字」的 mask 照樣會過（遮罩仍然短於 20 字，兩段長切片也都不是它的子字串）。
// 開頭的 sk-ant- 與最後四碼本來就是刻意露出來的，所以只切中段；每截 5 個字，短到露一小段就抓得到。
const MIDDLE = FAKE_KEY.slice('sk-ant-'.length, -4);
const CHUNKS = [...Array(MIDDLE.length - 4).keys()].map((i) => MIDDLE.slice(i, i + 5));
ok(CHUNKS.length > 30, `（前提）中段切成 ${CHUNKS.length} 截、每截 5 個字`);
noneOf(CHUNKS, (chunk) => masked.includes(chunk),
  '金鑰中段的任何一截都沒有出現在遮罩裡');

// ---------------------------------------------------------------------------
section('格式檢查');
ok(checkFormat(FAKE_KEY).ok, '合法格式通過');
ok(!checkFormat('').ok, '空字串擋掉');
ok(!checkFormat('abc123').ok, '沒有前綴擋掉');
ok(!checkFormat('sk-ant-short').ok, '太短擋掉');
// 只有前綴檢查擋得住的案例：長度夠、沒有空白，就是前綴不對。
// 少了這一條，「拿掉前綴檢查」這個突變會被長度檢查順便擋掉而看不出來（實際發生過）。
ok(!checkFormat('A'.repeat(60)).ok, '長度夠但沒有前綴，還是要擋掉');
ok(!checkFormat(`sk-proj-${'A'.repeat(50)}`).ok, '別家的金鑰前綴也擋掉');
ok(checkFormat(`${'sk-ant-'}${'A'.repeat(50)}`).ok,
  '（對照）同樣長度、前綴正確的就放行 —— 證明擋的是前綴不是長度');
ok(!checkFormat(`sk-ant-api03 ${'A'.repeat(50)}`).ok, '含空白擋掉（常見的複製錯誤）');
ok(checkFormat(`  ${FAKE_KEY}  `).ok, '前後空白會被 trim 掉，不算錯');

// ---------------------------------------------------------------------------
section('用量：整數微美金，不會漂');
// 六個費率都是整數，所以 token 數 × 費率就是精準的微美金。
eq(costMicroUsd({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 }), 2_000_000,
  'Sonnet 5 一百萬 input token ＝ $2');
eq(costMicroUsd({ model: 'claude-sonnet-5', inputTokens: 0, outputTokens: 1_000_000 }), 10_000_000,
  'Sonnet 5 一百萬 output token ＝ $10');
eq(costMicroUsd({ model: 'claude-haiku-4-5', inputTokens: 7000, outputTokens: 2000 }), 7000 * 1 + 2000 * 5,
  'Haiku 4.5 手算對得上');
eq(costMicroUsd({ model: 'claude-opus-5', inputTokens: 7000, outputTokens: 2000 }), 7000 * 5 + 2000 * 25,
  'Opus 5 手算對得上');
eq(costMicroUsd({ model: 'claude-sonnet-5', inputTokens: -5, outputTokens: NaN }), 0,
  '負數與 NaN 當成 0，不會算出負的花費');
everyOf(MODELS, (m) => Number.isInteger(m.inRate) && Number.isInteger(m.outRate),
  '六個費率都是整數 —— 這是用量能用整數精準累加的前提');
eq(DEFAULT_CAP_MICRO_USD, 2_000_000, '預設上限 $2（PLAN §7.3）');
eq(monthOf(new Date(2026, 0, 5)), '2026-01', '月份字串補零');

// PLAN §8 估的是 Sonnet 5 每月 US$0.55–0.9。用那裡寫的 token 量對一次，
// 對不上就代表費率表跟成本估算有一邊過期了。
const monthly = 22 * costMicroUsd({ model: 'claude-sonnet-5', inputTokens: 6500, outputTokens: 2000 });
ok(monthly >= 550_000 && monthly <= 900_000,
  `用 PLAN §8 的 token 量算出每月 ${(monthly / 1e6).toFixed(2)} 美元，落在估算的 0.55–0.9 之間`);

// ---------------------------------------------------------------------------
section('送出去的請求：金鑰只在該在的地方');
const req = buildRequest({
  key: FAKE_KEY, model: 'claude-sonnet-5',
  system: '系統提示', messages: [{ role: 'user', content: '標題一' }],
});
eq(req.url, 'https://api.anthropic.com/v1/messages', '打的是 Anthropic 官方端點');
eq(req.init.headers['x-api-key'], FAKE_KEY, '金鑰在 x-api-key 標頭裡');
ok(!req.init.body.includes(FAKE_KEY), '**request body 裡沒有金鑰**');
ok(!req.url.includes(FAKE_KEY) && !req.url.includes('key='), '網址裡沒有金鑰（不會進瀏覽器記錄或 Referer）');
eq(req.init.headers['anthropic-dangerous-direct-browser-access'], 'true', '瀏覽器直連需要的標頭有帶');
ok(!JSON.stringify(req.init.body).includes('sk-ant'), 'body 序列化之後也沒有金鑰的影子');

// ---------------------------------------------------------------------------
// 執行期：真的存一把進瀏覽器，把所有會變成字串的路徑都走一遍。
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

  section('存進去之後，所有序列化的出口都看不到它');
  const probe = await page.evaluate(async (KEY) => {
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    await db.clear('secrets');
    await secrets.save({ key: KEY });

    // 1. 照匯出的規則（只走 EXPORTABLE_STORES）把整個 App 的資料倒出來
    const exported = {};
    for (const s of db.EXPORTABLE_STORES) exported[s] = await db.getAll(s);

    // 2. 更粗暴的：把**每一個** store 都倒出來（模擬「有人寫錯、匯出了全部」）
    const everything = {};
    for (const s of db.STORE_NAMES) everything[s] = await db.getAll(s);

    // 3. status() 是畫面唯一拿得到的東西
    const st = await secrets.status();

    return {
      exportedJson: JSON.stringify(exported),
      everythingJson: JSON.stringify(everything),
      statusJson: JSON.stringify(st),
      statusKeys: Object.keys(st).sort(),
      secretsStoreHasIt: JSON.stringify(await db.getAll('secrets')).includes(KEY),
    };
  }, FAKE_KEY);

  ok(!probe.exportedJson.includes(FAKE_KEY), '**照匯出規則倒出來的 JSON 裡沒有金鑰**');
  ok(!probe.exportedJson.includes('sk-ant'), '連 sk-ant 這個前綴都沒有出現');
  ok(probe.exportedJson.length > 2, `（對照）匯出的內容不是空的（${probe.exportedJson.length} 字元）`);
  ok(probe.secretsStoreHasIt, '（對照）金鑰真的存進去了 —— 上面那幾條不是因為根本沒存');
  ok(probe.everythingJson.includes(FAKE_KEY),
    '（對照）如果有人寫錯、把所有 store 都倒出來，金鑰就會跟著出去 —— 這正是 EXPORTABLE_STORES 存在的理由');
  ok(!probe.statusJson.includes(FAKE_KEY), 'status() 回的東西裡沒有金鑰');
  ok(!probe.statusKeys.includes('key'), `status() 根本沒有 key 這個欄位（${probe.statusKeys.join('、')}）`);

  section('畫面上只看得到遮罩');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('#view [data-card="aiKeyConfigured"]');
  const ui = await page.evaluate(() => ({
    text: document.querySelector('#view').textContent,
    html: document.querySelector('#view').innerHTML,
    inputs: [...document.querySelectorAll('#view input')].map((i) => ({ type: i.type, value: i.value })),
  }));
  ok(!ui.text.includes(FAKE_KEY), '畫面文字裡沒有完整金鑰');
  ok(!ui.html.includes(FAKE_KEY), 'DOM 的 HTML 裡也沒有（不是用 CSS 蓋住的）');
  ok(ui.text.includes(mask(FAKE_KEY)), `看得到遮罩（${mask(FAKE_KEY)}）`);
  noneOf(ui.inputs, (i) => i.value.includes('sk-ant'), '沒有任何輸入框裡還留著金鑰');
  ok(ui.text.includes('Delete') || ui.text.includes('後台'),
    '畫面有講「清除不等於停用，要到後台刪掉」');

  section('本機上限改得動（A10）');
  //
  // 「下個月自動歸零，**或調高上限**」這句話以前是空頭支票：畫面上講了，
  // 但沒有任何地方可以調，而 secrets.setCap 一直存在、從來沒有人呼叫過。
  //
  // 單位是這裡最容易出錯的地方：畫面收美金，存進去是**微美金**。
  // 搞混會差一百萬倍，而且畫面上看起來完全正常。
  const capUi = await page.evaluate(async () => {
    const secrets = await import('./js/secrets.js');
    const settings = await import('./js/views/settings.js');
    const before = (await secrets.status()).capMicroUsd;

    const field = () => document.querySelector('#view [data-field="aiCap"]');
    const saveBtn = () => [...document.querySelectorAll('#view button')].find((b) => b.textContent === '儲存上限');
    const msg = () => document.querySelector('#view [data-card="aiKeyConfigured"] .muted.sm:last-of-type')?.textContent ?? '';

    const hasField = !!field();
    const shownAtFirst = field()?.value ?? null;

    // 改成 0.5 美金
    field().value = '0.5';
    saveBtn().click();
    await new Promise((r) => setTimeout(r, 400));
    const after05 = (await secrets.status()).capMicroUsd;

    // 負數要被擋下來，而且**不可以默默存成 0**
    //（0 的意思是「完全不准用」，跟「我填錯了」是兩件事）
    await settings.default();
    await new Promise((r) => setTimeout(r, 200));
    field().value = '-3';
    saveBtn().click();
    await new Promise((r) => setTimeout(r, 300));
    const afterNeg = (await secrets.status()).capMicroUsd;
    const negMsg = document.querySelector('#view [data-card="aiKeyConfigured"]').textContent;

    // 亂填也是
    field().value = 'abc';
    saveBtn().click();
    await new Promise((r) => setTimeout(r, 300));
    const afterJunk = (await secrets.status()).capMicroUsd;

    // 三位小數（超過分位）也擋
    field().value = '1.234';
    saveBtn().click();
    await new Promise((r) => setTimeout(r, 300));
    const afterTooPrecise = (await secrets.status()).capMicroUsd;

    return { before, hasField, shownAtFirst, after05, afterNeg, afterJunk, afterTooPrecise, negMsg };
  });

  ok(capUi.hasField, '設定頁上真的有「本機上限」這個欄位');
  ok(capUi.before > 0, `（前提）原本有一個上限：${capUi.before} 微美金`);
  ok(/^\d+\.\d{2}$/.test(String(capUi.shownAtFirst)),
    `欄位裡顯示的是**美金**（${capUi.shownAtFirst}），不是微美金那一長串`);
  eq(capUi.after05, 500000, '填 0.5 存進去是 500,000 微美金 —— 單位換算對得上（差一百萬倍的話這條會紅）');
  eq(capUi.afterNeg, 500000, '填負數不會被存進去（上限還是剛剛那個 0.5）');
  ok(/請填 0 或正數/.test(capUi.negMsg), `而且畫面講得出為什麼：「${/請填[^。]*。/.exec(capUi.negMsg)?.[0]}」`);
  eq(capUi.afterJunk, 500000, '亂填字母也不會被存進去');
  eq(capUi.afterTooPrecise, 500000, '超過兩位小數也擋下來（分以下沒有意義）');

  section('改完上限之後，超過就真的不發請求');
  // 上限改得動還不夠 —— 要證明改完之後**真的會照新的上限擋**。
  // 少了這條，一個「存得進去但沒人讀」的版本也會讓上面每一條通過。
  const capEffect = await page.evaluate(async () => {
    const secrets = await import('./js/secrets.js');
    const insight = await import('./js/insight.js');
    // 上限設成 0.000001 美金（1 微美金），用量一定超過
    await secrets.setCap(1);
    const st = await secrets.status();
    let calls = 0;
    const counting = async () => { calls += 1; return new Response('{}', { status: 200 }); };
    let err = null;
    try {
      await insight.generate({ items: [], holdings: [], fetchImpl: counting });
    } catch (e) { err = String(e.message || e); }
    return { cap: st.capMicroUsd, overCap: st.overCap, calls, err };
  });
  eq(capEffect.cap, 1, '（前提）上限真的被改成 1 微美金了');
  eq(capEffect.calls, 0, '超過上限時**一次請求都沒發**（不是發了再丟掉）');

  section('錯誤訊息不會把金鑰帶出來');
  const errs = await page.evaluate(async (KEY) => {
    const secrets = await import('./js/secrets.js');
    const out = {};
    // 上游把送出的標頭原樣回 echo —— 這是最容易漏的一條路
    const echoing = async () => new Response(JSON.stringify({
      error: { message: `invalid x-api-key: ${KEY}` },
    }), { status: 401 });
    try {
      await secrets.callAnthropic({ key: KEY, model: 'claude-sonnet-5', messages: [], fetchImpl: echoing });
      out.thrown = null;
    } catch (e) { out.thrown = e.message; out.detail = e.detail ?? null; }

    const r = await secrets.testKey({ key: KEY, fetchImpl: echoing });
    out.testError = r.error;
    return out;
  }, FAKE_KEY);
  ok(errs.thrown && !errs.thrown.includes(FAKE_KEY),
    'callAnthropic 丟出的錯誤裡沒有金鑰', errs.thrown);
  // 上游的錯誤細節從 v0.7.2 起放在 e.detail（給除錯用），不再塞進使用者看的那句話。
  // 兩邊都要驗：message 不可以有金鑰，detail 要看得出「這裡本來有一把」而不是整段消失。
  ok(errs.detail && !errs.detail.includes(FAKE_KEY), '細節裡也沒有完整金鑰', errs.detail);
  ok(errs.detail && errs.detail.includes('sk-ant-***'),
    '而且細節看得出「這裡本來有一把金鑰」，不是整段消失', errs.detail);
  ok(!errs.thrown.includes('sk-ant'),
    '使用者看到的那句話裡連遮罩過的金鑰都不該出現（那是除錯細節，不是給他看的）', errs.thrown);
  ok(errs.testError && !errs.testError.includes(FAKE_KEY), 'testKey 回的錯誤裡也沒有', errs.testError);

  section('清除');
  const cleared = await page.evaluate(async () => {
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    await secrets.clear();
    return {
      rows: (await db.getAll('secrets')).length,
      status: await secrets.status(),
      dump: JSON.stringify(await db.getAll('secrets')),
    };
  });
  eq(cleared.rows, 0, '清除之後 secrets store 是空的');
  ok(!cleared.dump.includes('sk-ant'), '倒出來也看不到殘影');
  eq(cleared.status.configured, false, 'status 說沒有設定金鑰');
  eq(cleared.status.masked, '', '遮罩也清掉了');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('secret-leak-test');
