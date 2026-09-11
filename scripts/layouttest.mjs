// 版面掃描（npm run layouttest）。
//
// 每一頁 × 四種字級 × 三種寬度，掃兩件事：
//
//   **溢出**：有沒有東西超出畫面右緣（手機上就是被切掉看不到）
//   **重疊**：兩段文字有沒有疊在一起
//
// 為什麼要做這個：字級調到「特大」時中文會撐開，數字欄位、產業名稱、條狀圖的
// 百分比最容易擠爆。這種問題在預設字級下完全看不出來，而會去調特大字級的人，
// 正是最需要看得清楚的人。
//
// 這支測試會**先塞一批資料進去**（持股、計畫、除權息、新聞、今日觀察），
// 因為空畫面不會爆版 —— 掃一個沒有資料的 App 等於什麼都沒掃。

import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf } from './tap.mjs';
import { listen } from './serve.mjs';

const SCALES = ['sm', 'md', 'lg', 'xl'];
// 320：iPhone SE 這種最窄的；390：主流；430：Pro Max
const WIDTHS = [320, 390, 430];
const ROUTES = ['/', '/holdings', '/plans', '/dividends', '/news', '/calc', '/settings'];

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  // -------------------------------------------------------------------------
  section('先把畫面塞滿 —— 空畫面不會爆版');
  const seeded = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const plans = await import('./js/plans.js');
    for (const s of db.EXPORTABLE_STORES) await db.clear(s);
    await db.clear('news');
    await db.clear('insights');

    // 名字長、產業名長的都放進去 —— 短名字不會爆版
    await holdings.addOpening({ code: '2330', shares: 123456, avgCost: 1234.56, date: '2026-09-01', note: '開帳' });
    await holdings.addOpening({ code: '5906', shares: 98765, avgCost: 41.55, date: '2026-09-01' });
    await holdings.addOpening({ code: '2882', shares: 1000000, avgCost: 80.25, date: '2026-09-01' });
    await holdings.addChange({ code: '2330', date: '2026-09-05', deltaShares: 5000, price: 1200, kind: 'manual' });
    await plans.save({ code: '2330', amount: 30000, days: [6, 16, 26], feeRate: 0.001425, reinvest: true });

    // 一筆結算，讓市值與集中度算得出來
    await db.put('settle', {
      date: '2026-09-11',
      byCode: [
        { code: '2330', close: 1234.5, status: 'ok' },
        { code: '5906', close: 41.55, status: 'ok' },
        { code: '2882', close: 80.25, status: 'ok' },
      ],
    });

    // 新聞：放幾則**很長**的標題
    await db.put('news', {
      date: new Date().toLocaleDateString('sv'),
      items: [
        { id: 'n1', title: '台積電法說會釋出資本支出上調訊號，供應鏈同步受惠，外資圈同步調整財測與評價基準', link: 'https://a/1', source: 'cna', publishedAt: new Date().toISOString() },
        { id: 'n2', title: '三大法人賣超台股1123.72億元，其中外資賣超987.65億元創今年單日新高', link: 'https://a/2', source: 'cnyes', publishedAt: new Date().toISOString() },
        { id: 'n3', title: 'A very long English headline about semiconductors and the global supply chain that keeps going', link: 'https://a/3', source: 'cnbc', publishedAt: new Date().toISOString() },
      ],
      fetchedAt: Object.fromEntries(['cna', 'cnyes', 'ltn', 'yahoo', 'cnbc', 'marketwatch'].map((s) => [s, new Date().toISOString()])),
    });

    // 今日觀察：一段正常、一段越界（越界那段會顯示「已隱藏」）
    const prefs = await import('./js/prefs.js');
    await prefs.load();
    await prefs.set('insightConsent', true);
    const secrets = await import('./js/secrets.js');
    await secrets.save({ key: `sk-ant-api03-${'A'.repeat(50)}` });
    await db.put('insights', {
      date: new Date().toLocaleDateString('sv'),
      model: 'claude-sonnet-5',
      json: {
        summary: '今天以半導體與金融兩條線為主，兩者的新聞都提到了利率與匯率的影響。',
        sections: [
          { theme: '半導體供應鏈', newsIds: ['n1', 'n3'], relatedCodes: ['2330'], observation: '法說會提到的資本支出上調，與 n3 的全球供應鏈報導方向一致；這是新聞中已陳述的事實。' },
          { theme: '越界的一段', newsIds: ['n2'], relatedCodes: [], observation: '建議買進台積電，目標價 1500 元。' },
        ],
        watchDates: [{ date: '2026-09-20', what: '2330 除息，當天股價會扣掉息值' }],
      },
      usage: { inputTokens: 6500, outputTokens: 2000 },
      createdAt: new Date().toISOString(),
    });
    return { holdings: (await db.getAll('holdings')).length, changes: (await db.getAll('changes')).length };
  });
  ok(seeded.holdings >= 3, `塞了 ${seeded.holdings} 檔持股、${seeded.changes} 筆異動`);

  // -------------------------------------------------------------------------
  // 掃描器：回傳所有溢出與重疊的元素
  const scan = () => page.evaluate(() => {
    const root = document.getElementById('app');
    const docW = document.documentElement.clientWidth;
    const overflow = [];
    const els = [...root.querySelectorAll('*')];

    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // 允許 1px 的捨入誤差
      if (r.right > docW + 1 || r.left < -1) {
        overflow.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString?.().slice(0, 40) ?? '',
          left: Math.round(r.left), right: Math.round(r.right), docW,
          text: (el.textContent ?? '').trim().slice(0, 40),
        });
      }
    }

    // 重疊：只比對**帶文字的葉節點**（容器本來就會包住小孩，比對容器沒有意義）。
    //
    // 而且要排除「固定定位的東西**以及它們的子孫**」——底部分頁列是固定的，
    // 內容本來就會從它下面捲過去，那不是爆版。第一版只排除了元素自己、
    // 沒排除子孫，於是分頁列裡的每個圖示與文字都被算成重疊（84 組裡有 55 組中招）。
    const inFixed = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
      }
      return false;
    };
    const leaves = els.filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.children.length > 0) return false;
      if (inFixed(el)) return false;
      return (el.textContent ?? '').trim().length > 0;
    });
    const boxes = leaves.map((el) => {
      const r = el.getBoundingClientRect();
      return { el, r, text: el.textContent.trim().slice(0, 30) };
    }).filter((b) => b.r.width > 0 && b.r.height > 0);

    const overlaps = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i].r; const b = boxes[j].r;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // 2px 以上的雙向重疊才算 —— 抗鋸齒與行高會造成 1px 級的碰觸
        if (ox > 2 && oy > 2) {
          overlaps.push({ a: boxes[i].text, b: boxes[j].text, ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
    return { overflow, overlaps, docW, scrollW: document.documentElement.scrollWidth, leafCount: boxes.length };
  });

  // 每一個組合的結果都留著 —— 母體必須是「全部 84 組」，
  // 不是「有問題的那幾組」。用後者當母體的話，沒問題時母體只剩 0 或 1 個，
  // 那幾條 noneOf 就等於什麼都沒檢查（第一版就是這樣寫的）。
  const all = [];
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 844 });
    for (const scale of SCALES) {
      await page.evaluate(async (s) => {
        const prefs = await import('./js/prefs.js');
        await prefs.set('fontScale', s);
        prefs.applyFontScale(s);
      }, scale);
      for (const route of ROUTES) {
        await page.evaluate((r) => { location.hash = `#${r}`; }, route);
        await page.waitForFunction(() => document.querySelector('#view')?.textContent?.trim().length > 0);
        await new Promise((r) => setTimeout(r, 350));
        const res = await scan();
        all.push({ width, scale, route, ...res });
      }
    }
  }

  const where = (p) => `${p.route} @${p.width}px/${p.scale}`;
  section(`掃了 ${all.length} 個組合（${ROUTES.length} 頁 × ${SCALES.length} 字級 × ${WIDTHS.length} 寬度）`);
  eq(all.length, ROUTES.length * SCALES.length * WIDTHS.length, '組合數對得上');
  ok(all.every((p) => p.leafCount >= 3),
    `每一組都真的量到東西（最少的一組有 ${Math.min(...all.map((p) => p.leafCount))} 個文字節點）`);

  noneOf(all, (p) => p.overflow.length > 0, '沒有任何元素超出畫面寬度',
    all.filter((p) => p.overflow.length).slice(0, 3)
      .map((p) => `${where(p)}：${JSON.stringify(p.overflow.slice(0, 2))}`).join(' ／ '));

  noneOf(all, (p) => p.overlaps.length > 0, '沒有任何兩段文字疊在一起',
    all.filter((p) => p.overlaps.length).slice(0, 3)
      .map((p) => `${where(p)}：${JSON.stringify(p.overlaps.slice(0, 3))}`).join(' ／ '));

  noneOf(all, (p) => p.scrollW > p.docW + 1, '畫面不會橫向捲動',
    all.filter((p) => p.scrollW > p.docW + 1).slice(0, 3)
      .map((p) => `${where(p)}：scrollWidth ${p.scrollW} > ${p.docW}`).join(' ／ '));

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('layouttest');
