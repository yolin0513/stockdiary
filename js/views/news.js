// 新聞頁：標題、來源、時間、跟我的持股有關的標記。點了開原站。
//
// 畫面規則（PLAN §7.1）：
//   · 只顯示標題與來源，**沒有摘要**——我們根本沒有存（見 js/rss.js）
//   · 每一則都是外連，點了離開 App 到原站看
//   · 哪一家沒抓到要寫出來，不要讓使用者以為「今天新聞就這麼少」

import { h, toast } from '../ui.js';
import { setTop, render } from '../shell.js';
import * as news from '../news.js';
import * as holdings from '../holdings.js';
import * as catalog from '../catalog.js';
import { localISODate } from '../roc.js';

let lastResults = null;

export default async function newsView() {
  setTop({ title: '新聞' });

  const today = localISODate(new Date());
  let items = await news.forDate(today);

  // 今天還沒抓過就抓一次；抓過了就直接用存下來的（30 分鐘節流在 news.refresh 裡）
  if (items.length === 0) {
    const r = await news.refresh();
    lastResults = r.results;
    items = await news.forDate(r.date);
  }

  const held = await holdings.list();
  const withIndustry = held.map((hd) => ({
    code: hd.code,
    name: hd.name,
    industry: catalog.lookup(hd.code)?.industry ?? null,
  }));
  const marked = news.markRelated(items, withIndustry);

  const tw = marked.filter((it) => regionOf(it.source) === 'tw');
  const intl = marked.filter((it) => regionOf(it.source) === 'intl');
  const related = marked.filter((it) => it.relatedCodes?.length);

  render([
    failureCard(lastResults),
    related.length ? listCard(`跟你的持股有關（${related.length}）`, related, { showCodes: true }) : null,
    listCard(`台股（${tw.length}）`, tw),
    listCard(`國際（${intl.length}）`, intl),
    footerCard(),
  ].filter(Boolean));
}

function regionOf(sourceId) {
  return news.SOURCES.find((s) => s.id === sourceId)?.region ?? 'tw';
}

function sourceName(sourceId) {
  return news.SOURCES.find((s) => s.id === sourceId)?.name ?? sourceId;
}

/** 抓不到的來源要講出來 —— 靜默少幾則，使用者會以為今天就是沒新聞。 */
function failureCard(results) {
  const failed = (results ?? []).filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return h('section', { class: 'card', dataset: { card: 'newsFailures' } },
    h('h2', { class: 'card-title' }, `有 ${failed.length} 個來源這次沒抓到`),
    ...failed.map((f) => h('p', { class: 'muted sm' }, `${sourceName(f.source)}：${f.error}`)),
    h('p', { class: 'muted sm' }, '下面的清單不包含這些來源的新聞。'));
}

function listCard(title, items, { showCodes = false } = {}) {
  const refresh = h('button', { class: 'btn' }, '重新整理');
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    refresh.textContent = '抓取中…';
    try {
      const r = await news.refresh({ force: true });
      lastResults = r.results;
      const failed = r.results.filter((x) => !x.ok).length;
      toast(failed ? `更新完成，但有 ${failed} 個來源沒抓到` : `更新完成，共 ${r.total} 則`);
    } catch (e) {
      toast(`更新失敗：${e?.message || e}`);
    }
    await newsView();
  });

  return h('section', { class: 'card', dataset: { card: 'newsList' } },
    h('h2', { class: 'card-title' }, title),
    items.length
      ? h('div', { class: 'rows' }, ...items.map((it) => row(it, showCodes)))
      : h('p', { class: 'muted' }, '這次沒有抓到新聞。'),
    refresh);
}

function row(item, showCodes) {
  return h('a', {
    class: 'row news-row',
    href: item.link,
    target: '_blank',
    rel: 'noopener noreferrer',
  },
  h('span', { class: 'news-title' }, item.title),
  h('span', { class: 'muted sm' },
    [sourceName(item.source), whenText(item.publishedAt),
      showCodes && item.relatedCodes?.length ? item.relatedCodes.join('、') : null]
      .filter(Boolean).join(' · ')));
}

/** 相對時間。算不出來就寫「時間不明」，不要寫「剛剛」。 */
function whenText(iso) {
  if (!iso) return '時間不明';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '時間不明';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 0) return new Date(t).toLocaleString('zh-TW', { hour12: false });
  if (mins < 60) return `${mins} 分鐘前`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} 小時前`;
  return new Date(t).toLocaleDateString('zh-TW');
}

function footerCard() {
  return h('section', { class: 'card', dataset: { card: 'newsFooter' } },
    h('p', { class: 'muted sm' },
      '只顯示標題與連結，點了會離開 App 到原站閱讀。這裡不轉載內文，也不做摘要。'),
    h('p', { class: 'muted sm' },
      `來源：${news.SOURCES.map((s) => s.name).join('、')}。保留 ${news.KEEP_DAYS} 天。`));
}
