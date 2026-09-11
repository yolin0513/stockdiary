// 今日觀察的界線（npm run insighttest）。
//
// 這支測試守三件事，每一件都是「做錯了就是投資建議」等級的：
//
//   1. 禁用詞過濾**攔得到**買賣建議、目標價、進出場時機、個股評等
//   2. 禁用詞過濾**不會亂擋**正常的新聞整理句子 —— 沒有這條，過濾器可以寫成
//      「全部都擋」然後第一條永遠通過，而使用者看到的是一片「已隱藏」
//   3. 送出去的 prompt 裡**沒有任何股數與金額**（執行期斷言，不是讀程式碼）

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { listen } from './serve.mjs';
import fs from 'node:fs';
import {
  BANNED, scanViolations, sentences, buildSystemPrompt, buildUserContent,
  buildPrompt, parseOutput, filterInsight, extractJsonObject, explainParseFailure,
  OUTPUT_SCHEMA, MAX_NEWS_ITEMS, MAX_OUTPUT_TOKENS,
} from '../js/insight.js';
import { buildRequest, httpHint } from '../js/secrets.js';

const REPLIES = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/anthropic-responses.json', import.meta.url)), 'utf8'));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------------------
section('攔得到：買賣建議、目標價、進出場時機、個股評等');
const MUST_CATCH = [
  // 買賣建議
  '建議買進台積電',
  '可以加碼這檔',
  '應該減碼手上的部位',
  '值得承接',
  '不妨逢低買進',
  '逢高賣出比較安全',
  '拉回布局是不錯的選擇',
  '現在正是進場的時機',
  '目前是買點',
  // 目標價與點位
  '目標價上看 1200 元',
  '合理價大約在 850 元',
  '支撐價在月線附近',
  '壓力區在 1000 元',
  '跌破頸線要小心',
  // 停損停利
  '記得設停損',
  '停利點可以放在 5%',
  '可以攤平成本',
  // 評等
  '我看好這檔的後市',
  '整體看壞金融股',
  '偏空看待',
  '給予買進評等',
  '優於大盤評等',
  // 漲跌預測
  '這檔必漲',
  '下週會跌',
  '將大漲一波',
  '上看歷史新高',
  // 包裝過的
  '建議留意買點',
  '應該把握這次機會',
  '值得考慮',
];
const caught = MUST_CATCH.filter((s) => scanViolations(s).length > 0);
eq(caught.length, MUST_CATCH.length, `${MUST_CATCH.length} 句越界的全部攔到`);
noneOf(MUST_CATCH, (s) => scanViolations(s).length === 0, '沒有任何一句漏網');

// ---------------------------------------------------------------------------
section('不會亂擋：正常的新聞整理句子全部放行');
// **這一節跟上面一樣重要。** 少了它，過濾器可以寫成「全部都擋」而上面全過，
// 使用者打開「今日觀察」看到的會是一片「已隱藏」。
//
// 這些句子刻意塞了容易誤殺的詞：買超、賣超、支撐（經濟）、建議（董事會的）、
// 看好（別人說的、出現在新聞標題裡）、漲跌（陳述事實）。
const MUST_PASS = [
  '三大法人賣超台股 1123 億元',
  '外資買超台積電 2 萬張',
  '台股收跌 755 點，力守月線之上',
  '央行維持利率不變，以支撐經濟成長',
  '董事會決議建議股東會通過配息案',
  '這則新聞提到聯準會將在 9 月 17 日公布利率決議',
  '台積電法說會釋出資本支出上調的訊號，與 n3 的記憶體漲價互相呼應',
  '你的持股集中在半導體業，佔比偏高',
  '2330 與 2317 同屬電子供應鏈，n1 提到的關稅議題對兩者都有影響',
  '歷史上類似的匯率波動曾伴隨出口股回檔，但過去不代表未來',
  '9 月 20 日是 2330 的除息日，當天股價會扣掉息值',
  'n5 與 n7 對同一件事的說法不一致，資訊還不確定',
  '這則新聞沒有說明金額，細節尚未公告',
  '鴻海電動車新廠動土，n2 有提到預計投產時間',
  '美國 CPI 數據將在台灣時間今晚公布',
  '新聞中提到該公司上季營收年增 12%',
];
const wronglyBlocked = MUST_PASS.filter((s) => scanViolations(s).length > 0);
eq(wronglyBlocked, [], '正常句子一句都沒有被擋');
ok(MUST_PASS.length >= 15, `（母體）測了 ${MUST_PASS.length} 句正常的話`);

// 兩邊一起看：過濾器同時「抓得到」與「不亂抓」才算數
detects((s) => scanViolations(s).length > 0, {
  shouldHit: MUST_CATCH,
  shouldMiss: MUST_PASS,
}, '過濾器同時通過正例與反例');

ok(BANNED.length >= 8, `禁用樣式有 ${BANNED.length} 條`);
everyOf(BANNED, (b) => typeof b.why === 'string' && b.why.length > 1, '每條禁用樣式都寫了原因（畫面要顯示給使用者看）');

// ---------------------------------------------------------------------------
section('一句越界，只隱藏那一段，不是整篇');
eq(sentences('第一句。第二句！第三句？').length, 3, '句子切得開');
const mixed = filterInsight({
  summary: '今天以半導體新聞為主。',
  sections: [
    { theme: '半導體', newsIds: ['n1'], relatedCodes: ['2330'], observation: '台積電法說會提到資本支出上調，與 n1 相關。' },
    { theme: '建議', newsIds: ['n2'], relatedCodes: ['2317'], observation: '建議買進鴻海。' },
    { theme: '匯率', newsIds: ['n3'], relatedCodes: [], observation: '新台幣貶值有利出口商營收換算。' },
  ],
  watchDates: [{ date: '2026-09-20', what: '除息日' }],
});
eq(mixed.hiddenCount, 1, '只有一段被隱藏');
eq(mixed.sections[0].hidden, undefined, '正常的第一段沒有被動到');
eq(mixed.sections[1].hidden, true, '越界的第二段被標起來');
eq(mixed.sections[2].hidden, undefined, '正常的第三段也沒被動到');
ok(mixed.sections[1].hiddenWhy.length > 0, `而且說得出原因：${mixed.sections[1].hiddenWhy.join('、')}`);
eq(mixed.sections[1].observation, '建議買進鴻海。',
  '原文保留不改寫 —— 改寫模型的輸出會讓人以為那是模型說的話');
eq(mixed.summaryHidden, false, '總結沒問題就不隱藏');

const badSummary = filterInsight({ summary: '建議加碼半導體。', sections: [], watchDates: [] });
eq(badSummary.summaryHidden, true, '總結越界時也擋得下來');
eq(badSummary.hiddenCount, 1, '總結被擋也算一次');

// ---------------------------------------------------------------------------
section('系統提示把界線寫清楚');
const sys = buildSystemPrompt();
everyOf(['不是投資建議', '目標價', '評等', '預測', '建議'], (w) => sys.includes(w),
  '系統提示裡明講了每一條界線');
ok(sys.includes('只能引用下面提供的新聞編號'), '要求只能引用提供的新聞');
ok(sys.includes('過去不代表未來'), '提到歷史類比時要標註的那句話有寫進去');
ok(sys.includes('JSON'), '要求 JSON 輸出');

// ---------------------------------------------------------------------------
section('結構化輸出：真的有送出 output_config.format');
// v0.7.1 以前**完全沒送這個參數**，只靠系統提示裡一句「以 JSON 回覆」。
// 官方文件（Structured outputs）開宗明義說那正是這個功能要解決的問題：
// 「Even with careful prompting, you may encounter parsing errors from invalid JSON syntax」。
// 使用者實機看到的「模型回的不是 JSON」就是這麼來的。
const req = buildRequest({
  key: 'sk-ant-api03-' + 'A'.repeat(50), model: 'claude-sonnet-5',
  system: 'sys', messages: [{ role: 'user', content: 'x' }],
  maxTokens: MAX_OUTPUT_TOKENS, outputConfig: { format: OUTPUT_SCHEMA },
});
const sent = JSON.parse(req.init.body);
ok(sent.output_config != null, 'request body 裡有 output_config');
eq(sent.output_config.format.type, 'json_schema', 'type 是 json_schema');
eq(sent.max_tokens, MAX_OUTPUT_TOKENS, `max_tokens 是 ${MAX_OUTPUT_TOKENS}（2048 會截斷）`);
ok(MAX_OUTPUT_TOKENS > 2048, 'output 上限比原本的 2048 大');
// schema 本身要合法：文件說不支援 regex（pattern），其餘標準功能都可以
const schemaText = JSON.stringify(OUTPUT_SCHEMA);
ok(!schemaText.includes('"pattern"'), 'schema 裡沒有用到不支援的 pattern（regex）');
everyOf(['summary', 'sections', 'watchDates'], (k) => OUTPUT_SCHEMA.schema.required.includes(k),
  '三個頂層欄位都是 required（全部必填就沒有順序意外）');
eq(OUTPUT_SCHEMA.schema.additionalProperties, false, '不允許多餘的欄位');
// 對照組：沒給 outputConfig 時就不該憑空出現
const plain = JSON.parse(buildRequest({
  key: 'k', model: 'm', system: 's', messages: [], maxTokens: 10,
}).init.body);
ok(plain.output_config === undefined, '（對照）沒指定時 body 裡不會有 output_config');

section('送給模型的新聞則數有上限');
// 實機那天全部有 244 則、可餵模型的有 70 則。則數越多輸出越長，越容易被截斷，成本也越高。
const manyNews = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, title: `標題 ${i}`, source: 'cna' }));
const capped = buildPrompt({ date: '2026-09-11', news: manyNews, holdings: [] });
eq(capped.usedNewsIds.length, MAX_NEWS_ITEMS, `最多送 ${MAX_NEWS_ITEMS} 則`);
ok(manyNews.length > MAX_NEWS_ITEMS, '（對照）餵進去的確實超過上限 —— 上面那條不是因為本來就不夠');
// 先過來源白名單再限則數，順序反了的話被擋的來源會先佔掉名額
const mixedSources = [
  ...Array.from({ length: 80 }, (_, i) => ({ id: `bad${i}`, title: 'x', source: 'ltn' })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `good${i}`, title: 'y', source: 'cna' })),
];
const order = buildPrompt({ date: '2026-09-11', news: mixedSources, holdings: [] });
eq(order.usedNewsIds.length, 10, '被擋的來源不會佔掉名額');
noneOf(order.usedNewsIds, (id) => id.startsWith('bad'), '而且一則被擋的都沒進去');

// ---------------------------------------------------------------------------
section('挖 JSON：巢狀、字串裡的大括號、截斷');
eq(extractJsonObject('{"a":1}'), '{"a":1}', '單純的物件');
eq(extractJsonObject('廢話 {"a":{"b":2}} 廢話'), '{"a":{"b":2}}', '前後有廢話，而且是巢狀的');
eq(extractJsonObject('{"t":"}"}'), '{"t":"}"}', '字串裡的 } 不算結束');
eq(extractJsonObject('{"t":"\\""}'), '{"t":"\\""}', '跳脫的引號不算字串結束');
eq(extractJsonObject('{"a":1'), null, '開了沒關 → null（這就是被截斷的樣子）');
eq(extractJsonObject('完全沒有'), null, '沒有 JSON → null');

// ---------------------------------------------------------------------------
section('解析模型輸出');
eq(parseOutput('{"summary":"x","sections":[],"watchDates":[]}').json.summary, 'x', '純 JSON 解得開');
eq(parseOutput('```json\n{"summary":"y","sections":[]}\n```').json.summary, 'y', '包在 ``` 裡也解得開');
eq(parseOutput('這不是 JSON').ok, false, '不是 JSON 就講清楚，不硬湊');
eq(parseOutput('{"summary":123}').json.summary, '', '型別不對的欄位退回空值，不是塞進去');
eq(parseOutput('{"summary":"a"}').json.sections, [], '缺的陣列補成空陣列');
eq(parseOutput('').ok, false, '空字串');
eq(parseOutput('').kind, 'empty', '而且分得出是「什麼都沒回」');
eq(parseOutput('[]').kind, 'notObject', '回了陣列也擋掉');

section('分得出「被截斷」與「根本不是 JSON」');
// 這兩種的下一步完全不同：截斷按「重新產生」通常就好，不是 JSON 則是程式或模型的問題。
const truncated = parseOutput(REPLIES.truncated.content[0].text);
eq(truncated.ok, false, '截斷的解不出來');
eq(truncated.kind, 'truncated', '而且認得出是截斷');
const prose = parseOutput(REPLIES.prose.content[0].text);
eq(prose.ok, false, '純自然語言解不出來');
eq(prose.kind, 'notJson', '認得出是「根本不是 JSON」');
ok(truncated.kind !== prose.kind, '兩種失敗分得開 —— 這是給使用者不同下一步的前提');
// 前面有廢話但後面有合法 JSON 的，要**救得回來**
const pre = parseOutput(REPLIES.preamble.content[0].text);
ok(pre.ok, '前面有一段自然語言、後面是合法 JSON 的，救得回來');
eq(pre.json.summary, '前面有一段廢話。', '而且內容正確');
const fenced2 = parseOutput(REPLIES.fenced.content[0].text);
ok(fenced2.ok, '包在圍欄裡的也救得回來');

section('錯誤訊息要說得出下一步');
const msgs = {
  truncated: explainParseFailure({ kind: 'truncated' }, 'max_tokens'),
  stopOnly: explainParseFailure({ kind: 'notJson' }, 'max_tokens'),
  empty: explainParseFailure({ kind: 'empty' }, 'end_turn'),
  notJson: explainParseFailure({ kind: 'notJson' }, 'end_turn'),
};
everyOf(Object.values(msgs), (m) => m.length >= 12, '每一種失敗都有一句完整的說明');
everyOf(Object.values(msgs), (m) => /重新產生|更新/.test(m), '每一種都講得出下一步該做什麼');
ok(msgs.truncated.includes('截斷'), `截斷講的是截斷：「${msgs.truncated}」`);
ok(msgs.stopOnly === msgs.truncated, 'stop_reason=max_tokens 時，就算解析器沒認出來也當成截斷');
ok(msgs.notJson !== msgs.truncated, '不同失敗給不同訊息，不是同一句罐頭');
noneOf(Object.values(msgs), (m) => m.includes('JSON'),
  '訊息裡沒有「JSON」這種使用者看不懂的字');

section('HTTP 狀態碼要翻成人話');
const hints = [401, 402, 403, 429, 500, 529].map((c) => ({ code: c, text: httpHint(c) }));
everyOf(hints, (x) => x.text.length >= 8, '每個狀態碼都有一句說明');
ok(httpHint(401).includes('金鑰'), `401 講金鑰：「${httpHint(401)}」`);
ok(httpHint(429).includes('用量') || httpHint(429).includes('頻繁'), `429 講額度：「${httpHint(429)}」`);
ok(httpHint(529).includes('過載') || httpHint(529).includes('再試'), `529 叫人等一下：「${httpHint(529)}」`);
eq(new Set(hints.map((x) => x.text)).size, hints.length, '不同狀態碼給不同訊息，不是同一句罐頭');
noneOf(hints, (x) => /^Anthropic 回 \d+$/.test(x.text), '沒有一個是只丟狀態碼了事');

// ---------------------------------------------------------------------------
// 送出去的 prompt：執行期斷言，不是讀程式碼
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

  section('送出去的 prompt 裡沒有股數、金額、成本（執行期實測）');
  // 塞一批**獨一無二、不可能碰巧出現**的數字進持股，然後看送出去的字串裡有沒有它們。
  const SECRETS_IN_HOLDINGS = {
    shares: 8_675_309,
    avgCost: 1234.5678,
    costMicro: '987654321',
    marketValue: 4_242_424_242,
    note: '我在 2024 年用 55 萬買的',
  };
  const probe = await page.evaluate(async (magic) => {
    const insight = await import('./js/insight.js');
    const db = await import('./js/db.js');

    // 真的寫進 IndexedDB，再真的讀出來 —— 不是手捏一個乾淨的物件餵給它
    await db.clear('holdings');
    await db.put('holdings', {
      code: '2330', name: '台積電', industry: '半導體業',
      shares: magic.shares, avgCost: magic.avgCost, avgCostMicro: magic.costMicro,
      marketValue: magic.marketValue, note: magic.note, changePct: 1.2,
    });
    await db.put('holdings', {
      code: '2317', name: '鴻海', industry: '其他電子業',
      shares: magic.shares + 1, avgCost: magic.avgCost + 1, changePct: -0.8,
    });
    const holdings = await db.getAll('holdings');

    const news = [
      { id: 'n1', title: '台積電法說會登場', source: 'cna' },
      { id: 'n2', title: '自由財經獨家報導', source: 'ltn' },   // 未允許 AI 的來源
      { id: 'n3', title: 'Yahoo 的一則', source: 'yahoo' },      // 未允許 AI 的來源
      { id: 'n4', title: 'CNBC on chips', source: 'cnbc' },
    ];

    const p = insight.buildPrompt({
      date: '2026-09-11', news, holdings, marketChangePct: -1.5,
    });
    return {
      sent: JSON.stringify({ system: p.system, messages: p.messages }),
      userContent: p.messages[0].content,
      usedNewsIds: p.usedNewsIds,
      holdingsHadShares: holdings.every((h) => h.shares > 0),
    };
  }, SECRETS_IN_HOLDINGS);

  ok(probe.holdingsHadShares,
    '（對照）持股資料裡**真的有**股數 —— 下面那些「找不到」才有意義');

  const forbidden = [
    String(SECRETS_IN_HOLDINGS.shares),
    String(SECRETS_IN_HOLDINGS.shares + 1),
    String(SECRETS_IN_HOLDINGS.avgCost),
    SECRETS_IN_HOLDINGS.costMicro,
    String(SECRETS_IN_HOLDINGS.marketValue),
    SECRETS_IN_HOLDINGS.note,
    '55 萬',
  ];
  noneOf(forbidden, (v) => probe.sent.includes(v),
    '送出去的內容裡找不到任何一個股數／成本／市值／備註');
  noneOf(['shares', 'avgCost', 'avgCostMicro', 'marketValue'], (k) => probe.sent.includes(k),
    '連欄位名稱都沒有出現');

  // 該有的要有 —— 不然「找不到股數」可能是因為根本沒送持股
  everyOf(['2330', '台積電', '半導體業', '2317', '鴻海'], (v) => probe.userContent.includes(v),
    '（對照）代號、名稱、產業確實有送出去');
  ok(probe.userContent.includes('+1.2%') && probe.userContent.includes('-0.8%'),
    '當日漲跌％也有送出去');

  section('未允許 AI 的來源，標題不進 prompt（執行期實測）');
  eq(probe.usedNewsIds.sort(), ['n1', 'n4'], '只有 cna 與 cnbc 的兩則進得去');
  noneOf(['自由財經獨家報導', 'Yahoo 的一則'], (t) => probe.sent.includes(t),
    'ltn 與 yahoo 的標題一個字都沒有出現在送出的內容裡');
  ok(probe.sent.includes('台積電法說會登場'),
    '（對照）允許來源的標題確實有送出去 —— 不是「全部都沒送」');

  section('沒有金鑰時不會偷偷送出任何東西');
  const noKey = await page.evaluate(async () => {
    const insight = await import('./js/insight.js');
    const db = await import('./js/db.js');
    await db.clear('secrets');
    await db.clear('insights');
    let called = 0;
    const spy = async () => { called += 1; return new Response('{}', { status: 200 }); };
    const r = await insight.generate({
      date: '2026-09-11', news: [], holdings: [], fetchImpl: spy,
    });
    return { ok: r.ok, error: r.error, called };
  });
  eq(noKey.ok, false, '沒有金鑰就產生不出來');
  eq(noKey.called, 0, '而且一次網路請求都沒發');
  ok(noKey.error.includes('金鑰'), `錯誤講得出原因：「${noKey.error}」`);

  section('超過用量上限就停住');
  const capped = await page.evaluate(async () => {
    const insight = await import('./js/insight.js');
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    await db.clear('insights');
    await secrets.save({ key: 'sk-ant-api03-' + 'A'.repeat(50) });
    const rec = await secrets.load();
    await db.put('secrets', { ...rec, capMicroUsd: 1000, usage: { month: secrets.monthOf(new Date()), usedMicroUsd: 5000 } });
    let called = 0;
    const spy = async () => { called += 1; return new Response('{}', { status: 200 }); };
    const r = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: spy });
    return { ok: r.ok, error: r.error, called };
  });
  eq(capped.ok, false, '超過上限就不產生');
  eq(capped.called, 0, '也沒有發出請求');
  ok(capped.error.includes('上限'), `錯誤講得出原因：「${capped.error}」`);

  section('產生成功：存起來、記用量、同一天不重生成');
  const gen = await page.evaluate(async () => {
    const insight = await import('./js/insight.js');
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    await db.clear('insights');
    const rec = await secrets.load();
    await db.put('secrets', { ...rec, capMicroUsd: 2_000_000, usage: { month: secrets.monthOf(new Date()), usedMicroUsd: 0 } });

    let called = 0;
    const reply = async () => {
      called += 1;
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({
          summary: '今天以半導體為主。',
          sections: [{ theme: '半導體', newsIds: ['n1'], relatedCodes: ['2330'], observation: '法說會提到資本支出。' }],
          watchDates: [{ date: '2026-09-20', what: '除息日' }],
        }) }],
        usage: { input_tokens: 6500, output_tokens: 2000 },
      }), { status: 200 });
    };
    const first = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: reply });
    const second = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: reply });
    const forced = await insight.generate({ date: '2026-09-11', news: [], holdings: [], force: true, fetchImpl: reply });
    const st = await secrets.status();
    const stored = await db.get('insights', '2026-09-11');
    return {
      firstOk: first.ok, firstCached: first.cached,
      secondCached: second.cached, forcedCached: forced.cached,
      called, used: st.usedMicroUsd, storedKeys: Object.keys(stored).sort(),
      summary: stored.json.summary,
    };
  });
  eq(gen.firstOk, true, '第一次產生成功');
  eq(gen.firstCached, false, '第一次是真的打了 API');
  eq(gen.secondCached, true, '同一天再問就直接用存好的');
  eq(gen.forcedCached, false, '按「重新產生」才會再打一次');
  eq(gen.called, 2, `總共只打了 ${gen.called} 次 API`);
  // 6500×2 + 2000×10 = 33000 微美金，打兩次 = 66000
  eq(gen.used, 66_000, '用量照 token 數與費率精準累加（兩次共 $0.066）');
  eq(gen.storedKeys, ['createdAt', 'date', 'json', 'model', 'usage'], 'insights 存的欄位就是規劃的那幾個');
  eq(gen.summary, '今天以半導體為主。', '存下來的內容對得上');

  section('每一種真實的回應形狀，端對端走一遍');
  // **這一節是這次 bug 真正缺的東西。**
  // 原本 generate() 的測試只餵一種回應（格式完美的 JSON），於是整組斷言都建立在
  // 「模型會回合法 JSON」這個假設上 —— 實機一撞到別的形狀就爆，而測試全綠。
  const shapes = await page.evaluate(async (replies) => {
    const insight = await import('./js/insight.js');
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    const out = {};
    for (const [name, reply] of Object.entries(replies)) {
      if (name.startsWith('_')) continue;
      await db.clear('insights');
      const rec = await secrets.load();
      await db.put('secrets', { ...rec, capMicroUsd: 2_000_000, usage: { month: secrets.monthOf(new Date()), usedMicroUsd: 0 } });
      const fake = async () => new Response(JSON.stringify(reply), { status: 200 });
      const r = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: fake });
      const stored = await db.get('insights', '2026-09-11');
      out[name] = {
        ok: r.ok, error: r.error ?? null, kind: r.kind ?? null, stopReason: r.stopReason ?? null,
        detail: r.detail ?? null, stored: !!stored,
        summary: stored?.json?.summary ?? null,
      };
    }
    return out;
  }, REPLIES);

  ok(shapes.clean.ok, '正常回應：成功');
  ok(shapes.fenced.ok, '包在圍欄裡：成功（容錯）');
  ok(shapes.preamble.ok, '前面有一段廢話：成功（容錯）');
  eq(shapes.preamble.summary, '前面有一段廢話。', '而且救回來的內容正確');

  eq(shapes.truncated.ok, false, '被截斷：失敗');
  eq(shapes.truncated.stopReason, 'max_tokens', '而且記下了 stop_reason');
  ok(shapes.truncated.error.includes('截斷'), `訊息講的是截斷：「${shapes.truncated.error}」`);
  eq(shapes.truncated.stored, false, '失敗就不要存進 insights（不然明天會拿到半截的）');

  eq(shapes.refusal.ok, false, '模型拒絕：失敗');
  eq(shapes.refusal.stopReason, 'refusal', '認得出是拒絕');
  ok(shapes.refusal.error.includes('拒絕'), `訊息講的是拒絕：「${shapes.refusal.error}」`);

  eq(shapes.prose.ok, false, '純自然語言：失敗');
  eq(shapes.prose.kind, 'notJson', '認得出是「不是 JSON」');
  eq(shapes.empty.ok, false, '空 content：失敗');
  eq(shapes.empty.kind, 'empty', '認得出是「什麼都沒回」');

  // 每一種失敗都要給不同的訊息，而且都要有下一步
  const failures = ['truncated', 'refusal', 'prose', 'empty'].map((k) => shapes[k].error);
  eq(new Set(failures).size, failures.length, '四種失敗給四種不同的訊息，不是同一句罐頭');
  everyOf(failures, (m) => /重新產生|更新|再試/.test(m), '每一種都講得出下一步');
  noneOf(failures, (m) => m === '模型回的不是 JSON', '沒有一個是原本那句沒有意義的話');

  section('容錯不等於放寬安全：越界照樣擋');
  // 救得回格式，不代表內容就放行。
  const violating = await page.evaluate(async (reply) => {
    const insight = await import('./js/insight.js');
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    await db.clear('insights');
    const rec = await secrets.load();
    await db.put('secrets', { ...rec, capMicroUsd: 2_000_000, usage: { month: secrets.monthOf(new Date()), usedMicroUsd: 0 } });
    const fake = async () => new Response(JSON.stringify(reply), { status: 200 });
    const r = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: fake });
    const filtered = insight.filterInsight(r.json);
    return { ok: r.ok, hiddenCount: filtered.hiddenCount, sections: filtered.sections.map((x) => !!x.hidden) };
  }, REPLIES.violating);
  ok(violating.ok, '這一份是合法 JSON，所以產生成功');
  eq(violating.hiddenCount, 1, '但越界那一段照樣被擋下來');
  eq(violating.sections, [false, true], '正常的沒事、越界的被標起來');

  section('HTTP 失敗：訊息要有用，而且不存半成品');
  const httpFails = await page.evaluate(async () => {
    const insight = await import('./js/insight.js');
    const secrets = await import('./js/secrets.js');
    const db = await import('./js/db.js');
    const out = {};
    for (const status of [401, 429, 500, 529]) {
      await db.clear('insights');
      const rec = await secrets.load();
      await db.put('secrets', { ...rec, capMicroUsd: 2_000_000, usage: { month: secrets.monthOf(new Date()), usedMicroUsd: 0 } });
      const fake = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status });
      const r = await insight.generate({ date: '2026-09-11', news: [], holdings: [], fetchImpl: fake });
      out[status] = { ok: r.ok, error: r.error, stored: !!(await db.get('insights', '2026-09-11')) };
    }
    return out;
  });
  everyOf(Object.values(httpFails), (x) => x.ok === false, '四種 HTTP 錯誤都失敗');
  everyOf(Object.values(httpFails), (x) => x.stored === false, '而且都沒有存進 insights');
  ok(httpFails['401'].error.includes('金鑰'), `401 講金鑰：「${httpFails['401'].error}」`);
  eq(new Set(Object.values(httpFails).map((x) => x.error)).size, 4, '四種狀態碼給四種不同訊息');

  section('畫面：免責標籤不可關閉、同意頁擋得住');
  const ui = await page.evaluate(async () => {
    const prefs = await import('./js/prefs.js');
    const db = await import('./js/db.js');
    await prefs.load();
    await prefs.set('insightConsent', false);
    await db.clear('news');
    await db.put('news', {
      date: new Date().toLocaleDateString('sv'),
      items: [{ id: 'n1', title: '台積電法說會登場', link: 'https://a/1', source: 'cna', publishedAt: null }],
      fetchedAt: { cna: new Date().toISOString(), cnyes: new Date().toISOString(),
        ltn: new Date().toISOString(), yahoo: new Date().toISOString(),
        cnbc: new Date().toISOString(), marketwatch: new Date().toISOString() },
    });
    return true;
  });
  ok(ui, '測試資料準備好了');

  await page.evaluate(() => { location.hash = '#/news'; });
  await page.waitForSelector('#view [data-card="insightConsent"]', { timeout: 60000 });

  const consent = await page.evaluate(() => {
    const card = document.querySelector('#view [data-card="insightConsent"]');
    const badge = card.querySelector('[data-badge="insightDisclaimer"]');
    return {
      title: card.querySelector('.card-title').textContent,
      hasBadge: !!badge,
      badgeText: badge?.textContent ?? '',
      // 免責標籤上不可以有任何「關掉它」的東西
      badgeHasButton: !!badge?.querySelector('button, a, [role="button"]'),
      badgeHasCloseText: /[✕✖×]|關閉|知道了|不再顯示/.test(badge?.textContent ?? ''),
      checkboxChecked: card.querySelector('input[type="checkbox"]').checked,
      text: card.textContent,
    };
  });
  ok(consent.title.includes('非投資建議'), `標題固定寫著非投資建議：「${consent.title}」`);
  ok(consent.hasBadge, '免責標籤在');
  ok(consent.badgeText.includes('非投資建議'), '標籤文字講明不是投資建議');
  eq(consent.badgeHasButton, false, '**免責標籤上沒有任何按鈕或連結** —— 關不掉');
  eq(consent.badgeHasCloseText, false, '也沒有「知道了／不再顯示」這種關掉它的字');
  eq(consent.checkboxChecked, false, '同意的勾選預設沒有勾');
  everyOf(['不是投資建議', '費用由你付', '只存在這台裝置'], (w) => consent.text.includes(w),
    '同意頁把三件事都講了');

  // 沒勾就按下去 —— 不可以啟用
  const notConsented = await page.evaluate(async () => {
    const card = document.querySelector('#view [data-card="insightConsent"]');
    card.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 800));
    const prefs = await import('./js/prefs.js');
    return {
      consent: prefs.get('insightConsent'),
      stillOnConsent: !!document.querySelector('#view [data-card="insightConsent"]'),
    };
  });
  eq(notConsented.consent, false, '沒勾就按，**不會啟用**');
  eq(notConsented.stillOnConsent, true, '畫面還停在同意頁');

  // 勾了才過
  const consented = await page.evaluate(async () => {
    const card = document.querySelector('#view [data-card="insightConsent"]');
    card.querySelector('input[type="checkbox"]').checked = true;
    card.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 1200));
    const prefs = await import('./js/prefs.js');
    return { consent: prefs.get('insightConsent'), card: !!document.querySelector('#view [data-card="insight"]') };
  });
  eq(consented.consent, true, '（對照）勾了就啟用得了 —— 不是「怎樣都不給過」');
  eq(consented.card, true, '啟用之後出現今日觀察的卡片');

  section('畫面：越界的段落顯示為已隱藏，而且不用紅綠色與箭頭');
  const rendered = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const today = new Date().toLocaleDateString('sv');
    await db.put('insights', {
      date: today,
      model: 'claude-sonnet-5',
      json: {
        summary: '今天以半導體新聞為主。',
        sections: [
          { theme: '半導體', newsIds: ['n1'], relatedCodes: ['2330'], observation: '法說會提到資本支出上調。' },
          { theme: '越界的', newsIds: ['n1'], relatedCodes: [], observation: '建議買進台積電，目標價 1500 元。' },
        ],
        watchDates: [{ date: '2026-09-20', what: '除息日' }],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
      createdAt: new Date().toISOString(),
    });
    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 400));
    location.hash = '#/news';
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#view [data-block="insightHidden"]')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const card = document.querySelector('#view [data-card="insight"]');
    const styles = [...card.querySelectorAll('*')].map((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, text: el.textContent.slice(0, 30) };
    });
    return {
      text: card.textContent,
      hiddenBlocks: card.querySelectorAll('[data-block="insightHidden"]').length,
      footer: card.querySelector('[data-badge="insightFooter"]')?.textContent ?? '',
      hasBadge: !!card.querySelector('[data-badge="insightDisclaimer"]'),
      colors: [...new Set(styles.map((s) => s.color))],
      arrows: /[↑↓▲▼⬆⬇]/.test(card.textContent),
    };
  });
  eq(rendered.hiddenBlocks, 1, '越界的那一段被標成已隱藏');
  ok(!rendered.text.includes('建議買進台積電'), '**越界的原文沒有顯示在畫面上**');
  ok(!rendered.text.includes('目標價 1500'), '目標價也沒有顯示');
  ok(rendered.text.includes('法說會提到資本支出上調'), '（對照）正常的那一段照常顯示');
  ok(rendered.hasBadge, '免責標籤還在');
  ok(rendered.footer.includes('Sonnet 5') && rendered.footer.includes('不構成投資建議'),
    `底部署名固定：「${rendered.footer}」`);
  eq(rendered.arrows, false, '沒有任何漲跌箭頭');
  // 紅綠色是漲跌的視覺語言，套在 AI 文字上會讀起來像多空判斷
  noneOf(rendered.colors, (c) => /rgb\(\s*(2[0-9]{2}|1[89][0-9])\s*,\s*[0-9]{1,2}\s*,/.test(c),
    '文字沒有用到紅色系');
  noneOf(rendered.colors, (c) => /rgb\(\s*[0-9]{1,2}\s*,\s*(1[5-9][0-9]|2[0-9]{2})\s*,\s*[0-9]{1,2}\s*\)/.test(c),
    '文字也沒有用到綠色系');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('insighttest');
