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
import {
  BANNED, scanViolations, sentences, buildSystemPrompt, buildUserContent,
  buildPrompt, parseOutput, filterInsight,
} from '../js/insight.js';

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
section('解析模型輸出');
eq(parseOutput('{"summary":"x","sections":[],"watchDates":[]}').json.summary, 'x', '純 JSON 解得開');
eq(parseOutput('```json\n{"summary":"y","sections":[]}\n```').json.summary, 'y', '包在 ``` 裡也解得開');
eq(parseOutput('這不是 JSON').ok, false, '不是 JSON 就講清楚，不硬湊');
eq(parseOutput('{"summary":123}').json.summary, '', '型別不對的欄位退回空值，不是塞進去');
eq(parseOutput('{"summary":"a"}').json.sections, [], '缺的陣列補成空陣列');

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
