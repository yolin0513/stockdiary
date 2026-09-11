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
import * as insight from '../insight.js';
import * as secrets from '../secrets.js';
import * as prefs from '../prefs.js';
import { localISODate } from '../roc.js';

let lastResults = null;
let insightState = null;   // { busy } | { error } | null
// 這一輪畫面上的新聞，給「引用：[n1]」那幾個連結查連結用。
let currentItems = [];

export default async function newsView() {
  setTop({ title: '新聞' });

  const today = localISODate(new Date());
  let items = await news.forDate(today);

  // 今天還沒抓過就抓一次；抓過了就直接用存下來的（30 分鐘節流在 news.refresh 裡）。
  //
  // 抓六個來源要好幾秒。在那之前先畫一張「抓取中」——
  // 不然標題已經變成「新聞」、內容卻還停在上一頁，看起來像當掉了。
  // （setTop 在 view 一開始就跑，render 要等資料回來，中間那段空窗就是這個現象。）
  if (items.length === 0) {
    render([h('section', { class: 'card', dataset: { card: 'newsLoading' } },
      h('h2', { class: 'card-title' }, '新聞'),
      h('p', { class: 'muted' }, '正在抓取六個來源…'))]);
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
  currentItems = marked;

  const tw = marked.filter((it) => regionOf(it.source) === 'tw');
  const intl = marked.filter((it) => regionOf(it.source) === 'intl');
  const related = marked.filter((it) => it.relatedCodes?.length);

  const keyStatus = await secrets.status();
  const todayInsight = await insight.forDate(today);

  render([
    await insightCard({ today, items: marked, holdings: withIndustry, keyStatus, todayInsight }),
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


// ---------------------------------------------------------------------------
// 今日觀察
//
// 畫面上的規矩（PLAN §7.2），每一條都是刻意的：
//   · 標題固定「今日觀察（AI 整理，非投資建議）」，不可改、不可關
//   · 灰底免責標籤沒有關閉鈕 —— 它不是通知，是這塊內容的一部分
//   · 底部固定署名（哪個模型、幾點產生、未經查證、不構成投資建議）
//   · **不用紅綠色、不用箭頭** —— 那些是漲跌的視覺語言，會讓文字讀起來像多空判斷
//   · 越界的段落原文保留但不顯示，標「AI 越界，已隱藏」與原因

function disclaimerBadge() {
  // 沒有 onclick、沒有關閉鈕。要關掉只能改程式，那正是重點。
  return h('p', { class: 'disclaimer', dataset: { badge: 'insightDisclaimer' } },
    'AI 整理，非投資建議。內容未經查證，請以原始新聞與公開資訊為準。');
}

async function insightCard({ today, items, holdings: held, keyStatus, todayInsight }) {
  if (!keyStatus.configured) return insightSetupHint();
  if (!prefs.get('insightConsent')) return consentCard();

  const body = [];
  if (todayInsight) {
    body.push(...insightBody(todayInsight));
  } else if (insightState?.busy) {
    body.push(h('p', { class: 'muted' }, '正在整理…（大約十幾秒）'));
  } else {
    body.push(h('p', { class: 'muted sm' }, '今天還沒有整理過。'));
  }
  if (insightState?.error) body.push(errorBlock(insightState));

  const btn = h('button', { class: 'btn' }, todayInsight ? '重新產生' : '產生今日觀察');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    insightState = { busy: true };
    await newsView();
    const r = await insight.generate({
      date: today,
      news: items,
      holdings: held,
      force: !!todayInsight,
    });
    insightState = r.ok ? null : { error: r.error, detail: r.detail, kind: r.kind, stopReason: r.stopReason };
    await newsView();
  });

  return h('section', { class: 'card', dataset: { card: 'insight' } },
    h('h2', { class: 'card-title' }, '今日觀察（AI 整理，非投資建議）'),
    disclaimerBadge(),
    ...body,
    btn);
}

function insightBody(rec) {
  const filtered = insight.filterInsight(rec.json);
  const out = [];

  out.push(filtered.summaryHidden
    ? hiddenBlock(filtered.summaryHiddenWhy)
    : h('p', { class: 'insight-summary' }, filtered.summary));

  for (const s of filtered.sections) {
    out.push(h('div', { class: 'insight-section' },
      h('h3', { class: 'sub-title' }, s.theme ?? ''),
      s.hidden ? hiddenBlock(s.hiddenWhy) : h('p', {}, s.observation ?? ''),
      newsRefs(s.newsIds)));
  }

  if (filtered.watchDates.length) {
    out.push(h('h3', { class: 'sub-title' }, '值得留意的日期'));
    out.push(h('div', { class: 'rows' }, ...filtered.watchDates.map((w) =>
      h('p', { class: 'muted sm' }, `${w.date ?? ''}　${w.what ?? ''}`))));
  }

  const m = secrets.modelById(rec.model);
  const at = new Date(rec.createdAt);
  const hhmm = Number.isFinite(at.getTime())
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : '未知時間';
  out.push(h('p', { class: 'muted sm', dataset: { badge: 'insightFooter' } },
    `由 Claude（${m?.name ?? rec.model}）依新聞標題於 ${hhmm} 產生，未經查證，不構成投資建議。`));

  if (filtered.hiddenCount > 0) {
    out.push(h('p', { class: 'muted sm' },
      `有 ${filtered.hiddenCount} 段因為越界被隱藏。可以按「重新產生」再試一次。`));
  }
  return out;
}

/**
 * 產生失敗時的畫面。
 *
 * 兩層：上面是**使用者看得懂、而且知道下一步**的一句話；下面收起來的是原始細節，
 * 給回報問題用。以前只有一句「模型回的不是 JSON」—— 使用者不知道是金鑰錯、
 * 額度滿、網路問題還是程式壞了，只能乾瞪眼。
 *
 * 細節一律過 scrub()：上游的錯誤回應有時會把送出的標頭原樣回 echo。
 */
function errorBlock(state) {
  const parts = [h('p', { class: 'warn' }, secrets.scrub(state.error))];
  const detail = [state.kind ? `類型：${state.kind}` : null,
    state.stopReason ? `stop_reason：${state.stopReason}` : null,
    state.detail ? `回應開頭：${secrets.scrub(String(state.detail)).slice(0, 300)}` : null,
  ].filter(Boolean);
  if (detail.length) {
    parts.push(h('details', { class: 'muted sm', dataset: { block: 'insightErrorDetail' } },
      h('summary', {}, '技術細節（回報問題時用得到）'),
      ...detail.map((d) => h('p', { class: 'muted sm' }, d))));
  }
  return h('div', { dataset: { block: 'insightError' } }, ...parts);
}

/** 越界的段落：講清楚發生什麼事，不要靜默消失。 */
function hiddenBlock(why) {
  return h('p', { class: 'warn', dataset: { block: 'insightHidden' } },
    `這一段越界了（${(why ?? []).join('、') || '不符合界線'}），已隱藏。`);
}

/** 引用的新聞編號，點得回原文。 */
function newsRefs(ids) {
  if (!ids?.length) return null;
  return h('p', { class: 'muted sm' }, '引用：', ...ids.map((id) => {
    const item = currentItems.find((x) => x.id === id);
    return item
      ? h('a', { href: item.link, target: '_blank', rel: 'noopener noreferrer' }, `[${id}] `)
      : h('span', {}, `[${id}] `);
  }));
}

function insightSetupHint() {
  return h('section', { class: 'card', dataset: { card: 'insightNoKey' } },
    h('h2', { class: 'card-title' }, '今日觀察（AI 整理，非投資建議）'),
    disclaimerBadge(),
    h('p', { class: 'muted sm' }, '要用這個功能，先到「設定」填你自己的 Anthropic 金鑰。'),
    h('a', { class: 'btn', href: '#/settings' }, '去設定'));
}

/** 首次啟用的一次性說明。**沒有勾選就不會產生任何 AI 內容。** */
function consentCard() {
  const box = h('input', { type: 'checkbox', dataset: { field: 'insightConsent' } });
  const go = h('button', { class: 'btn btn-primary' }, '我了解，啟用今日觀察');
  go.addEventListener('click', async () => {
    if (!box.checked) { toast('要先勾選才能啟用'); return; }
    await prefs.set('insightConsent', true);
    await newsView();
  });
  return h('section', { class: 'card', dataset: { card: 'insightConsent' } },
    h('h2', { class: 'card-title' }, '今日觀察（AI 整理，非投資建議）'),
    disclaimerBadge(),
    h('p', {}, '啟用前請先看清楚三件事：'),
    h('p', { class: 'muted sm' }, '一、這是**資訊整理，不是投資建議**。不會有買賣建議、目標價、進出場時機或個股評等；'
      + '真的出現了，程式會把那一段隱藏起來，但你仍然不應該把任何一句話當成建議。'),
    h('p', { class: 'muted sm' }, '二、**費用由你付**。用的是你自己的 Anthropic 金鑰，直接跟 Anthropic 結算，這個 App 不經手。'),
    h('p', { class: 'muted sm' }, '三、**金鑰只存在這台裝置**，不會上傳，也不會出現在匯出的備份檔裡。'),
    h('label', { class: 'pref-row' }, box, h('span', {}, ' 我了解以上三點')),
    go);
}
