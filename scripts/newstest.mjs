// 新聞抓取與解析（npm run newstest）。
//
// 固定樣本全部取自**實際回應**（scripts/fixtures/rss-*.xml，六家來源各一份，
// 2026-09-11 抓的）。CNBC 那份是用瀏覽器抓的 —— 它對 curl 的 UA 回 Access Denied，
// 但對瀏覽器正常，而前端就是從瀏覽器直打的。用 curl 抓會得到一份「拒絕存取」的
// HTML 當樣本，測了個寂寞。
//
// 最重要的兩節：
//   · 「結構上拿不到內文」—— 只存標題連結來源時間，不是「取了再刪」
//   · 「未明示允許的來源不進 prompt」—— 有對照組，證明不是「全部都不給」

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { parseFeed, decodeEntities } from '../js/rss.js';
import { SOURCES, newsId, mergeItems, forAI, markRelated, nameNeedles, urlOf } from '../js/news.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const feeds = Object.fromEntries(SOURCES.map((s) => [s.id, read(`rss-${s.id}.xml`)]));

// ---------------------------------------------------------------------------
section('六家來源的真實樣本都解析得出東西');
const parsed = Object.fromEntries(Object.entries(feeds).map(([id, xml]) => [id, parseFeed(xml)]));
for (const s of SOURCES) {
  const items = parsed[s.id];
  ok(items.length >= 5, `${s.name}（${s.id}）解出 ${items.length} 則`);
}
everyOf(Object.values(parsed).flat(), (it) => typeof it.title === 'string' && it.title.length > 0,
  '每一則都有標題');
everyOf(Object.values(parsed).flat(), (it) => /^https?:\/\//.test(it.link), '每一則的連結都是 http(s)');
everyOf(Object.values(parsed).flat(), (it) => it.publishedAt === null || !Number.isNaN(Date.parse(it.publishedAt)),
  '時間要嘛是可解析的 ISO，要嘛是 null（不會是亂碼）');

// ---------------------------------------------------------------------------
section('結構上拿不到內文');
// PLAN §7.1：只存標題、連結、來源、時間，不重製全文。
// 這一節要證明的不是「我們有記得刪掉」，是**解析器根本沒有那條路**。
const allItems = Object.values(parsed).flat();
const keys = [...new Set(allItems.flatMap((it) => Object.keys(it)))].sort();
eq(keys, ['link', 'publishedAt', 'title'], '解析結果就只有這三個欄位');
noneOf(allItems, (it) => 'description' in it || 'content' in it || 'summary' in it,
  '沒有任何一則帶著 description／content／summary');

// 對照組：樣本裡**真的有**內文可以被拿走 —— 不然上面那兩條是因為來源沒給才過的。
const withDesc = Object.entries(feeds).filter(([, xml]) => /<description[\s>]|<content:encoded/.test(xml));
ok(withDesc.length >= 3,
  `（對照）${withDesc.length} 家來源的原始 XML 裡確實有 description／content 可以拿 —— 是我們不取，不是它沒有`,
  withDesc.map(([id]) => id).join('、'));

// ---------------------------------------------------------------------------
section('解析器的細節');
eq(decodeEntities('AT&amp;T &lt;tag&gt; &#39;x&#39; &#x4e2d;'), "AT&T <tag> 'x' 中", 'HTML 實體還原');
eq(decodeEntities('&nosuchentity; 留著'), '&nosuchentity; 留著', '認不得的實體原樣留著，不要吃掉');
eq(parseFeed('<rss><channel><item><title>只有標題</title></item></channel></rss>'), [],
  '缺連結的整筆不收（不要放一個點不開的標題）');
eq(parseFeed('<rss><channel><item><link>https://a.example/1</link></item></channel></rss>'), [],
  '缺標題的整筆不收');
eq(parseFeed('<rss><channel><item><title>壞時間</title><link>https://a.example/1</link>'
  + '<pubDate>not a date</pubDate></item></channel></rss>')[0].publishedAt, null,
  '時間解析不出來就是 null —— 不要拿「現在」充數，那會讓舊聞看起來像剛發生');
eq(parseFeed('<rss><channel><item><title>危險</title><link>javascript:alert(1)</link></item></channel></rss>'), [],
  'javascript: 連結不收');
eq(parseFeed('<feed><entry><title>Atom</title><link rel="self" href="https://a.example/self"/>'
  + '<link rel="alternate" href="https://a.example/real"/><published>2026-09-11T00:00:00Z</published>'
  + '</entry></feed>')[0].link, 'https://a.example/real', 'Atom 取 alternate，不是 self');
eq(parseFeed('<rss><channel><item><title><![CDATA[CDATA 標題]]></title>'
  + '<link>https://a.example/1</link></item></channel></rss>')[0].title, 'CDATA 標題', 'CDATA 拆得開');
eq(parseFeed(''), [], '空字串回空陣列，不丟例外');
eq(parseFeed('<html><body>Access Denied</body></html>'), [], '不是 RSS 就回空陣列');

// ---------------------------------------------------------------------------
section('識別碼：同一則連結永遠同一個 id');
const link = 'https://www.cna.com.tw/news/afe/202609110178.aspx';
eq(newsId(link), newsId(link), '同樣的連結兩次算出同樣的 id');
ok(newsId(link) !== newsId(link + '?x=1'), '不同連結算出不同的 id');
const ids = allItems.map((it) => newsId(it.link));
eq(new Set(ids).size, new Set(allItems.map((it) => it.link)).size,
  `${ids.length} 則裡，不同連結沒有撞到同一個 id`);

// ---------------------------------------------------------------------------
section('合併：重抓不會變成兩筆');
const a = { id: 'n1', title: '舊', link: 'https://a/1', source: 'cna', publishedAt: '2026-09-11T01:00:00.000Z' };
const a2 = { ...a, title: '同一則、標題改了' };
const b = { id: 'n2', title: 'B', link: 'https://a/2', source: 'cna', publishedAt: '2026-09-11T02:00:00.000Z' };
const merged = mergeItems([a, b], [a2]);
eq(merged.length, 2, '同一個 id 不會變成兩筆');
eq(merged.find((x) => x.id === 'n1').title, '同一則、標題改了', '後抓到的覆蓋先前的');
eq(merged.map((x) => x.id), ['n2', 'n1'], '照發布時間新到舊');
const noDate = mergeItems([], [{ id: 'n3', title: 'C', link: 'https://a/3', source: 'cna', publishedAt: null }, b]);
eq(noDate.map((x) => x.id), ['n2', 'n3'], '沒有時間的排在有時間的後面');

// ---------------------------------------------------------------------------
section('未明示允許 AI 輸入的來源，連標題都不進 prompt');
// 依據是各家 robots 的宣告，不是我們自己放寬。這是唯一的出口。
const sample = SOURCES.map((s) => ({ id: 'x' + s.id, title: s.name + ' 的標題', link: 'https://a/' + s.id, source: s.id }));
const allowed = forAI(sample);
const blockedIds = SOURCES.filter((s) => !s.aiInput).map((s) => s.id);
noneOf(sample, (it) => blockedIds.includes(it.source) && allowed.some((x) => x.id === it.id),
  '未標記允許的來源，一則都沒有進到可餵模型的清單');
ok(blockedIds.length > 0, `確實有未標記允許的來源存在（${blockedIds.join('、')}）—— 上面那條不是空轉`);
// 對照組：不是「全部都不給」
everyOf(SOURCES.filter((s) => s.aiInput), (s) => allowed.some((x) => x.source === s.id),
  '（對照）標記允許的來源都進得去');
ok(allowed.length > 0 && allowed.length < sample.length,
  `擋掉一部分、留下一部分（${allowed.length}/${sample.length}）`);

// 真實樣本也走一次。
//
// 注意這裡斷言的是「**這一筆**是不是來自被擋的來源」，不是「這串標題文字有沒有
// 出現過」。同一則新聞常常多家同時刊（Yahoo 大量轉載中央社），實測六份樣本裡就有
// 6 個標題同時出現在 yahoo 與 cna／cnyes。餵中央社自己那一份是正當的 ——
// 用「標題字串有沒有出現」去斷言，會把轉載誤判成外洩。
const realAll = SOURCES.flatMap((s) => parsed[s.id].map((it) => ({ ...it, id: newsId(it.link), source: s.id })));
const realAllowed = forAI(realAll);
ok(realAllowed.length > 0, `真實樣本裡有 ${realAllowed.length} 則可以餵模型`);
noneOf(realAllowed, (it) => blockedIds.includes(it.source),
  `可餵模型的 ${realAllowed.length} 則，沒有任何一則來自被擋的來源`);
const sharedTitles = realAll.filter((it) => blockedIds.includes(it.source))
  .filter((it) => realAllowed.some((a) => a.title === it.title));
ok(sharedTitles.length > 0,
  `（記錄）有 ${sharedTitles.length} 則標題同時出現在被擋與允許的來源 —— 轉載是常態，`
  + '所以不能用「標題字串有沒有出現」當作外洩的判準',
  sharedTitles[0]?.title)

// ---------------------------------------------------------------------------
section('前後端的來源清單要一致');
const workerSrc = fs.readFileSync(fileURLToPath(new URL('../workers/sources.mjs', import.meta.url)), 'utf8');
const workerIds = [...workerSrc.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]);
const workerAi = Object.fromEntries([...workerSrc.matchAll(/^ {2}(\w+): \{[\s\S]*?aiInput: (true|false),/gm)]
  .map((m) => [m[1], m[2] === 'true']));
const frontWorkerSources = SOURCES.filter((s) => s.via === 'worker');
eq(frontWorkerSources.map((s) => s.id).sort(), workerIds.sort(),
  '前端走 Worker 的來源，跟 Worker 的白名單一字不差');
everyOf(frontWorkerSources, (s) => workerAi[s.id] === s.aiInput,
  'aiInput 標記兩邊一致（漂掉的話，被 robots 擋的來源可能悄悄進了 prompt）');

// ---------------------------------------------------------------------------
section('網址：國內走 Worker、國際直打');
everyOf(SOURCES.filter((s) => s.via === 'worker'), (s) => urlOf(s).startsWith('https://stockdiary-news.'),
  '國內四家經 Worker');
everyOf(SOURCES.filter((s) => s.via === 'direct'), (s) => /^https:\/\/(www\.cnbc\.com|feeds\.content\.dowjones\.io)\//.test(urlOf(s)),
  '國際兩家直打，而且只打 CSP 允許的那兩個主機');

// ---------------------------------------------------------------------------
section('「跟我的持股有關」的標記');
const holdings = [
  { code: '2330', name: '台積電', industry: '半導體業' },
  { code: '2317', name: '鴻海', industry: '其他電子業' },
  { code: '5906', name: '台南-KY', industry: '紡織纖維' },
];
const news = [
  { id: 'a', title: '台積電法說會釋出資本支出上調訊號', link: 'https://a/1', source: 'cna' },
  { id: 'b', title: '2317 鴻海電動車新廠動土', link: 'https://a/2', source: 'cna' },
  { id: 'c', title: '半導體業景氣落底', link: 'https://a/3', source: 'cna' },
  { id: 'd', title: '台南-KY 越南廠訂單回溫', link: 'https://a/4', source: 'cna' },
  { id: 'e', title: '今日天氣晴時多雲', link: 'https://a/5', source: 'cna' },
];
const marked = markRelated(news, holdings);
const relOf = (id) => marked.find((x) => x.id === id).relatedCodes;
eq(relOf('a'), ['2330'], '公司名命中');
eq(relOf('b'), ['2317'], '代號命中');
eq(relOf('c'), ['2330'], '產業關鍵字命中');
eq(relOf('d'), ['5906'], '帶 -KY 的名字命中');
ok(!('relatedCodes' in marked.find((x) => x.id === 'e')),
  '無關的那則沒有被標 —— 不是「全部都標」');
eq(nameNeedles('台灣積體電路製造股份有限公司'), ['台灣積體電路製造股份有限公司', '台灣積體電路製造'],
  '公司名去掉尾綴後也拿來比對');
eq(nameNeedles('大'), [], '太短的名字不用來比對（會亂命中）');
detects((title) => markRelated([{ id: 'z', title, link: 'https://a/z', source: 'cna' }], holdings)[0].relatedCodes != null, {
  shouldHit: ['台積電先進封裝', '鴻海營收', '2330 除息', '紡織纖維出口'],
  shouldMiss: ['今日天氣晴時多雲', '大樂透開獎', '國際油價收黑'],
}, '標記器抓得到相關的，也不會亂標');

// ---------------------------------------------------------------------------
// 存起來、節流、過期清掉 —— 這幾件事要 IndexedDB，所以真的開瀏覽器跑。
// fetch 全程用假的（回固定樣本），不打真網路。
import puppeteer from 'puppeteer';
import { listen } from './serve.mjs';

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  // 把六份樣本交給頁面，讓它的 fetch 照來源回對應的那一份。
  await page.evaluateOnNewDocument((fx) => { window.__feeds = fx; }, feeds);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  const run = (fn, arg) => page.evaluate(fn, arg);

  section('抓回來只存四個欄位');
  const stored = await run(async () => {
    const news = await import('./js/news.js');
    const db = await import('./js/db.js');
    await db.clear('news');
    const fake = async (url) => {
      const id = news.SOURCES.find((s) => news.urlOf(s) === String(url))?.id;
      return id ? new Response(window.__feeds[id], { status: 200 }) : new Response('', { status: 404 });
    };
    const r = await news.refresh({ now: new Date('2026-09-11T12:00:00+08:00'), fetchImpl: fake });
    const rec = await db.get('news', r.date);
    return {
      date: r.date,
      total: r.total,
      results: r.results,
      keys: [...new Set(rec.items.flatMap((it) => Object.keys(it)))].sort(),
      sources: [...new Set(rec.items.map((it) => it.source))].sort(),
      sample: rec.items[0],
    };
  });
  ok(stored.total > 100, `六家共存下 ${stored.total} 則`);
  everyOf(stored.results, (r) => r.ok, '六家都抓成功');
  eq(stored.keys, ['id', 'link', 'publishedAt', 'source', 'title'],
    '存進 IndexedDB 的就只有 id／標題／連結／來源／時間');
  eq(stored.sources, SOURCES.map((s) => s.id).sort(), '六家的來源標記都在');

  section('30 分鐘內不重抓');
  const throttled = await run(async () => {
    const news = await import('./js/news.js');
    let calls = 0;
    const fake = async (url) => {
      calls += 1;
      const id = news.SOURCES.find((s) => news.urlOf(s) === String(url))?.id;
      return new Response(window.__feeds[id], { status: 200 });
    };
    const soon = await news.refresh({ now: new Date('2026-09-11T12:20:00+08:00'), fetchImpl: fake });
    const skipped = soon.results.filter((r) => r.skipped).length;
    const callsAfterSoon = calls;
    const forced = await news.refresh({ now: new Date('2026-09-11T12:20:00+08:00'), force: true, fetchImpl: fake });
    return { skipped, callsAfterSoon, forcedSkipped: forced.results.filter((r) => r.skipped).length, callsAfterForce: calls };
  });
  eq(throttled.skipped, 6, '20 分鐘後再抓，六家全部跳過');
  eq(throttled.callsAfterSoon, 0, '而且真的一次網路請求都沒發（不是抓了再丟）');
  eq(throttled.forcedSkipped, 0, '（對照）按「重新整理」強制抓時就不跳過');
  eq(throttled.callsAfterForce, 6, '強制抓時六家都真的打了');

  section('超過 14 天的整天刪掉');
  const pruned = await run(async () => {
    const news = await import('./js/news.js');
    const db = await import('./js/db.js');
    await db.clear('news');
    const mk = (d) => ({ date: d, items: [{ id: 'x', title: 't', link: 'https://a/1', source: 'cna', publishedAt: null }], fetchedAt: {} });
    for (const d of ['2026-08-20', '2026-08-27', '2026-08-28', '2026-09-10', '2026-09-11']) await db.put('news', mk(d));
    const before = (await db.getAll('news')).map((r) => r.date).sort();
    const gone = await news.prune({ now: new Date('2026-09-11T12:00:00+08:00') });
    const after = (await db.getAll('news')).map((r) => r.date).sort();
    return { before, gone: gone.sort(), after };
  });
  eq(pruned.before.length, 5, '先放了 5 天的資料');
  eq(pruned.gone, ['2026-08-20', '2026-08-27'], '只有超過 14 天的那兩天被刪');
  eq(pruned.after, ['2026-08-28', '2026-09-10', '2026-09-11'], '界線上那天（第 14 天）留著');

  section('某一家掛掉不會拖垮其他家');
  const partial = await run(async () => {
    const news = await import('./js/news.js');
    const db = await import('./js/db.js');
    await db.clear('news');
    const fake = async (url) => {
      const id = news.SOURCES.find((s) => news.urlOf(s) === String(url))?.id;
      if (id === 'cnyes') return new Response('boom', { status: 500 });
      if (id === 'ltn') throw new Error('網路斷了');
      return new Response(window.__feeds[id], { status: 200 });
    };
    const r = await news.refresh({ now: new Date('2026-09-11T12:00:00+08:00'), fetchImpl: fake });
    return { results: r.results, total: r.total };
  });
  ok(partial.total > 80, `其他四家照樣存下 ${partial.total} 則`);
  eq(partial.results.filter((r) => !r.ok).map((r) => r.source).sort(), ['cnyes', 'ltn'],
    '掛掉的兩家各自被記下來');
  everyOf(partial.results.filter((r) => !r.ok), (r) => typeof r.error === 'string' && r.error.length > 4,
    '每一家掛掉都講得出原因（畫面要說得出「哪一家沒抓到」，不能靜默）');

  section('「跟你的持股有關」可以依個股篩選');
  const filterUi = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const prefs = await import('./js/prefs.js');
    for (const s of db.EXPORTABLE_STORES) await db.clear(s);
    await db.clear('news');
    await prefs.load();

    await holdings.addOpening({ code: '2330', shares: 1000, date: '2026-09-01' });
    await holdings.addOpening({ code: '2317', shares: 1000, date: '2026-09-01' });
    await holdings.addOpening({ code: '2882', shares: 1000, date: '2026-09-01' });

    const mk = (id, title) => ({ id, title, link: `https://a/${id}`, source: 'cna', publishedAt: '2026-09-11T01:00:00.000Z' });
    await db.put('news', {
      date: new Date().toLocaleDateString('sv'),
      items: [
        mk('a', '台積電法說會登場'),                 // 只有 2330
        mk('b', '台積電與鴻海同列供應鏈受惠'),        // 2330 ＋ 2317
        mk('c', '鴻海電動車新廠動土'),               // 只有 2317
        mk('d', '今日天氣晴時多雲'),                 // 都沒有
      ],
      fetchedAt: Object.fromEntries(['cna', 'cnyes', 'ltn', 'yahoo', 'cnbc', 'marketwatch']
        .map((x) => [x, new Date().toISOString()])),
    });

    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 300));
    location.hash = '#/news';
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#view [data-card="relatedNews"]')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const read = () => {
      const card = document.querySelector('#view [data-card="relatedNews"]');
      return {
        chips: [...card.querySelectorAll('[data-row="relatedFilter"] .chip')]
          .map((b) => ({ code: b.dataset.filter, text: b.textContent, on: b.getAttribute('aria-pressed') === 'true' })),
        titles: [...card.querySelectorAll('.news-title')].map((e) => e.textContent),
        minChipHeight: Math.min(...[...card.querySelectorAll('.chip')].map((b) => b.getBoundingClientRect().height)),
      };
    };
    const all = read();
    const click = async (code) => {
      document.querySelector(`#view [data-filter="${code}"]`).click();
      await new Promise((r) => setTimeout(r, 500));
      return read();
    };
    return { all, only2330: await click('2330'), only2317: await click('2317'), backToAll: await click('all') };
  });

  eq(filterUi.all.titles.length, 3, '「全部」時列出三則有關的（不相關的那則不進來）');
  eq(filterUi.all.chips.map((c) => c.code), ['all', '2330', '2317'],
    '篩選按鈕只列真的有新聞的那幾檔（2882 沒新聞就不出現）');
  ok(filterUi.all.chips[0].on, '預設選「全部」');
  ok(/全部（3）/.test(filterUi.all.chips[0].text), `全部的計數正確：「${filterUi.all.chips[0].text}」`);
  ok(/2330 .*（2）/.test(filterUi.all.chips[1].text), `2330 有兩則：「${filterUi.all.chips[1].text}」`);
  ok(/2317 .*（2）/.test(filterUi.all.chips[2].text), `2317 有兩則：「${filterUi.all.chips[2].text}」`);

  eq(filterUi.only2330.titles, ['台積電法說會登場', '台積電與鴻海同列供應鏈受惠'], '只看 2330 時剩兩則');
  eq(filterUi.only2317.titles, ['台積電與鴻海同列供應鏈受惠', '鴻海電動車新廠動土'], '只看 2317 時剩兩則');
  ok(filterUi.only2330.titles.includes('台積電與鴻海同列供應鏈受惠')
    && filterUi.only2317.titles.includes('台積電與鴻海同列供應鏈受惠'),
    '**同時關係到兩檔的那一則，在兩邊都看得到**');
  eq(filterUi.backToAll.titles.length, 3, '按回「全部」就全部回來');
  ok(filterUi.only2330.chips.find((c) => c.code === '2330').on, '選中的那顆有標記（aria-pressed）');
  ok(filterUi.all.minChipHeight >= 44,
    `篩選按鈕夠大按得到（最小 ${Math.round(filterUi.all.minChipHeight)}px ≥ 44px）`);

  section('台股與國際分組可以摺疊，而且記得住');
  const collapse = await page.evaluate(async () => {
    const prefs = await import('./js/prefs.js');
    const read = () => {
      const heads = [...document.querySelectorAll('#view [data-toggle]')];
      return heads.map((h) => ({
        key: h.dataset.toggle,
        expanded: h.getAttribute('aria-expanded') === 'true',
        mark: h.querySelector('.collapse-mark').textContent,
        bodyHidden: document.querySelector(`#view [data-body="${h.dataset.toggle}"]`).hidden,
        height: h.getBoundingClientRect().height,
      }));
    };
    const before = read();
    document.querySelector('#view [data-toggle="newsTwOpen"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const afterClick = read();
    const stored = prefs.get('newsTwOpen');

    // 離開再回來 —— 收合狀態要還在
    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 400));
    location.hash = '#/news';
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#view [data-toggle="newsTwOpen"]')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const afterReturn = read();

    // 收起來的時候，裡面的連結不可以還被讀到（hidden 不是只改外觀）
    const hiddenLinks = [...document.querySelectorAll('#view [data-body="newsTwOpen"] a')]
      .filter((a) => a.getBoundingClientRect().height > 0).length;

    document.querySelector('#view [data-toggle="newsTwOpen"]').click();
    await new Promise((r) => setTimeout(r, 500));
    return { before, afterClick, stored, afterReturn, hiddenLinks, reopened: read() };
  });

  eq(collapse.before.map((x) => x.key), ['newsTwOpen', 'newsIntlOpen'], '兩組各有一個摺疊控制項');
  ok(collapse.before.every((x) => x.expanded), '預設都是展開的');
  ok(collapse.before.every((x) => x.height >= 44),
    `標題列夠高按得到（最小 ${Math.round(Math.min(...collapse.before.map((x) => x.height)))}px）`);
  eq(collapse.afterClick[0].expanded, false, '按一下台股就收起來');
  eq(collapse.afterClick[0].bodyHidden, true, '內容真的被隱藏（hidden，不是只改外觀）');
  eq(collapse.afterClick[1].expanded, true, '國際那組不受影響');
  eq(collapse.stored, false, '收合狀態寫進設定');
  eq(collapse.afterReturn[0].expanded, false, '**離開再回來還是收著的**');
  eq(collapse.afterReturn[1].expanded, true, '國際那組還是展開的');
  eq(collapse.hiddenLinks, 0, '收起來時裡面的連結量不到高度（真的不在版面上）');
  eq(collapse.reopened[0].expanded, true, '（對照）再按一下就展開 —— 不是「收起來就打不開」');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('newstest');
