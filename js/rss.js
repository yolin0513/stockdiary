// RSS／Atom 解析 —— 只取標題、連結、時間，**故意不碰其他任何欄位**。
//
// 為什麼手寫而不是用 DOMParser：
//   · 解析器要能在 Node 裡跑固定樣本測試（DOMParser 只有瀏覽器有）
//   · 兩套程式路徑＝兩種行為，換到手機上才發現不一樣就來不及了
// 只取三個欄位，語法面夠單純，手寫是划算的。六家來源的真實樣本在
// `scripts/fixtures/rss-*.xml`，`newstest` 全部跑過。
//
// **這裡不解析 `<description>`／`<content:encoded>`，一個字都不取。**
// 這不是「取了再丟掉」，是結構上就沒有那條路 —— PLAN §7.1：只存標題、連結、
// 來源、時間，不重製全文。要驗證這件事，看 newstest 的「結構上拿不到內文」那一節。

/** `<![CDATA[…]]>` 拆掉。 */
function uncdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–',
};

/** HTML 實體還原。認不得的實體原樣留著，不要吃掉。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED ? NAMED[name] : m));
}

/** 把標籤與多餘空白清掉，回傳純文字。 */
function text(raw) {
  if (raw == null) return '';
  return decodeEntities(uncdata(raw).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 取出 block 裡第一個 <name> 的內容（含命名空間前綴，例如 dc:date）。 */
function tagContent(block, name) {
  const rx = new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}\\b[^>]*?(/)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${name}>`, 'i');
  const m = rx.exec(block);
  return m ? m[2] : null;
}

/** 取出第一個 <name … attr="值"> 的屬性值。 */
function tagAttr(block, name, attr, where = () => true) {
  const rx = new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}\\b([^>]*)>`, 'gi');
  for (const m of block.matchAll(rx)) {
    const attrs = m[1];
    if (!where(attrs)) continue;
    const a = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
    if (a) return a[1];
  }
  return null;
}

/**
 * 連結。RSS 是 `<link>網址</link>`，Atom 是 `<link rel="alternate" href="…">`。
 * 只收 http(s) —— `javascript:` 之類的東西不准從外部資料流進畫面。
 */
function linkOf(block) {
  const plain = text(tagContent(block, 'link'));
  const href = tagAttr(block, 'link', 'href', (a) => !/\brel\s*=\s*["'](?:self|replies|edit)["']/i.test(a));
  const guidIsUrl = /isPermaLink\s*=\s*["']true["']/i.test(block) ? text(tagContent(block, 'guid')) : '';
  for (const cand of [plain, href, guidIsUrl]) {
    if (cand && /^https?:\/\//i.test(cand)) return cand;
  }
  return null;
}

/** 時間。解析不出來就回 null —— **不要拿「現在」充數**，那會讓舊聞看起來像剛發生。 */
function publishedOf(block) {
  for (const name of ['pubDate', 'published', 'updated', 'date']) {
    const raw = text(tagContent(block, name));
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/**
 * 解析一份 RSS／Atom。回傳 `[{title, link, publishedAt}]`。
 *
 * 標題或連結缺一不可 —— 缺了就整筆不收。寧可少一則，也不要在畫面上放一個
 * 點不開的標題，或一條沒有標題的連結。
 */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return [];
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of doc.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2];
    const title = text(tagContent(block, 'title'));
    const link = linkOf(block);
    if (!title || !link) continue;
    out.push({ title, link, publishedAt: publishedOf(block) });
  }
  return out;
}
