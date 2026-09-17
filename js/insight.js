// 今日觀察：**資訊整理與觀察，不是投資建議。**
//
// 這個檔案有兩道防線，兩道都必須守得住：
//
//   前線：系統提示把界線寫給模型（buildSystemPrompt）
//   後線：輸出回來之後**用程式再掃一次**（scanViolations），命中的那一段整段不顯示
//
// 前線一定會有漏的時候 —— 模型就是會偶爾越界。所以後線不是「保險」，是主要防線。
// 後線寧可錯殺也不放過，但**不能亂殺**：正常的新聞整理句子必須全部放行，
// 不然使用者看到的就是一片「已隱藏」，這個功能等於沒有。insighttest 有對照組盯著。
//
// 還有一條結構性的規則：**送出去的東西裡不准有股數、金額、成本。**
// buildUserContent() 只從持股取 code／name／industry／changePct 四個欄位，
// 呼叫端就算把整包持股（含股數與成本）丟進來，也漏不出去。

import * as secrets from './secrets.js';
import * as db from './db.js';
import { forAI } from './news.js';

/**
 * 越界的樣式。
 *
 * 每一條後面的註解寫的是「**為什麼不能用更寬的寫法**」——
 * 這些都是對照組實際抓出來的誤殺。
 */
export const BANNED = [
  // 「買」「賣」單獨出現是新聞常態（三大法人買超／賣超、買盤、賣壓），不能直接擋。
  { rx: /(建議|應該|可以|值得|不妨|記得|務必)\s*(買進|買入|賣出|加碼|減碼|承接|布局|進場|出場|停損|停利|攤平)/, why: '買賣動作的建議' },
  { rx: /(逢低|逢高|拉回)\s*(買進|買入|承接|布局|加碼|賣出|減碼|調節)/, why: '進出場時機' },
  { rx: /(現在|此時|目前)\s*(是|正是)\s*(買|賣|進場|出場|布局)/, why: '進出場時機' },
  { rx: /目標價|目標價位|合理價|合理股價|推估股價/, why: '目標價' },
  { rx: /停損|停利|攤平/, why: '買賣動作' },
  { rx: /支撐價|壓力價|支撐位|壓力位|支撐區|壓力區|頸線|均線多頭排列/, why: '技術面進出點' },
  // 「看好」在新聞標題裡是別人說的（法人看好），但出現在 AI 自己的觀察裡就是評等。
  { rx: /(我|本文|以上|整體)?\s*(看好|看壞|看多|看空|偏多|偏空|中性偏)/, why: '個股評等' },
  { rx: /(買進|賣出|加碼|減碼|中立|優於大盤|劣於大盤|強力買進)\s*(評等|評級|建議)/, why: '個股評等' },
  { rx: /(必漲|必跌|將大漲|將大跌|會漲|會跌|上看|下看|挑戰新高|直逼)/, why: '漲跌預測' },
  { rx: /(值得|建議|應該)\s*(留意|關注|注意)\s*(買|賣|進|出)/, why: '包裝過的買賣建議' },
  { rx: /^(建議|應該|值得)/, why: '以「建議／應該／值得」開頭的句子' },
  { rx: /(比|較)\s*\S{2,6}\s*(更值得|更好|更優|更適合)(買|投資|持有)/, why: '比較個股優劣' },
];

/** 把一段文字切成句子。標點與換行都算句界。 */
export function sentences(text) {
  return String(text ?? '')
    .split(/[。！？\n；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 掃越界。回傳命中的句子與原因；沒有就是空陣列。
 * 一句一句掃，才能只隱藏出問題的那一段，而不是整篇。
 */
export function scanViolations(text) {
  const hits = [];
  for (const s of sentences(text)) {
    for (const b of BANNED) {
      if (b.rx.test(s)) { hits.push({ sentence: s, why: b.why }); break; }
    }
  }
  return hits;
}

// ---------- 送出去的內容 ----------

/**
 * 結構化輸出的 schema（`output_config.format`，官方文件 Structured outputs）。
 *
 * **這是 v0.7.2 才補上的。** 在那之前只靠系統提示裡一句「以 JSON 回覆」，
 * 結果就是使用者實機看到的「模型回的不是 JSON」。官方文件開宗明義：
 * 「Even with careful prompting, you may encounter parsing errors from invalid JSON syntax」。
 *
 * 限制：schema 不支援 regex（pattern）。這裡也用不到。
 * 每個欄位都列進 required —— 文件說必填欄位會照 schema 順序排在前面，
 * 全部必填就沒有順序意外。
 */
export const OUTPUT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '一段話總結今天的重點' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme: { type: 'string', description: '主題' },
            newsIds: { type: 'array', items: { type: 'string' }, description: '引用的新聞編號，只能用提供的' },
            relatedCodes: { type: 'array', items: { type: 'string' }, description: '相關的持股代號' },
            observation: { type: 'string', description: '這件事跟持股的關聯與原因' },
          },
          required: ['theme', 'newsIds', 'relatedCodes', 'observation'],
          additionalProperties: false,
        },
      },
      watchDates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            what: { type: 'string', description: '要留意什麼' },
          },
          required: ['date', 'what'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'sections', 'watchDates'],
    additionalProperties: false,
  },
};

/** 送幾則新聞給模型。太多會把輸出撐爆、也會讓成本上去。 */
export const MAX_NEWS_ITEMS = 60;
/** 輸出的 token 上限。2048 對「幾段觀察＋值得留意的日期」來說會截斷。 */
export const MAX_OUTPUT_TOKENS = 4096;

/** 系統提示。界線照 PLAN §7.2，一字不改地寫進去。 */
export function buildSystemPrompt() {
  return [
    '你是一個台股資訊整理助手。你的輸出**不是投資建議**，使用者也不會把它當建議看。',
    '',
    '你可以做的事：',
    '· 說明新聞與使用者持股之間的關聯與原因（供應鏈、客戶、同業、利率、匯率、政策）',
    '· 陳述新聞中已經寫明的事實',
    '· 提到歷史上類似事件的市場反應，但必須同時寫出「過去不代表未來」',
    '· 指出值得留意的日期（法說會、財報、除權息、FOMC、CPI）',
    '· 提醒持股集中度',
    '· 指出資訊不確定、或新聞彼此矛盾的地方',
    '',
    '你**絕對不可以**做的事：',
    '· 任何買、賣、加碼、減碼、停損、停利、進場、出場的建議或暗示',
    '· 目標價、合理價、支撐壓力、任何價格點位',
    '· 預測任何期間的漲跌',
    '· 對個股表示看好或看壞，或給任何形式的評等',
    '· 以「建議」「應該」「值得」開頭的句子',
    '· 比較個股之間的優劣',
    '· 引用沒有提供給你的新聞',
    '',
    '只能引用下面提供的新聞編號。找不到依據的話，寧可少寫，也不要自己補。',
    '',
    '以 JSON 回覆，格式如下，不要有其他文字：',
    '{"summary":"一段話總結今天的重點",',
    ' "sections":[{"theme":"主題","newsIds":["n1"],"relatedCodes":["2330"],"observation":"這件事跟持股的關聯與原因"}],',
    ' "watchDates":[{"date":"2026-09-20","what":"要留意什麼"}]}',
  ].join('\n');
}

/**
 * 使用者訊息的內容。
 *
 * **只取這四個欄位**：代號、名稱、產業、當日漲跌％。
 * 不是「取完再過濾」，是從頭就只挑這四個 —— 呼叫端丟整包持股進來也漏不出去。
 * insighttest 會塞一堆股數與成本進來，然後斷言送出的字串裡找不到那些數字。
 */
export function buildUserContent({ date, news, holdings, marketChangePct }) {
  const lines = [`日期：${date}`];

  // 拿不到就**明講拿不到**，不是把這一行省掉。
  // 省掉的話模型看不出差別，可能自己從新聞標題推一個大盤方向出來當事實。
  lines.push(Number.isFinite(marketChangePct)
    ? `大盤當日漲跌：${marketChangePct > 0 ? '+' : ''}${marketChangePct}%`
    : '大盤當日漲跌：無法取得（不要推測，也不要當成持平）');

  lines.push('', '我的持股（只有代號、名稱、產業、當日漲跌％）：');
  for (const h of holdings) {
    const pct = Number.isFinite(h.changePct) ? `${h.changePct > 0 ? '+' : ''}${h.changePct}%` : '當日無報價';
    lines.push(`· ${h.code} ${h.name ?? ''}｜${h.industry ?? '產業未知'}｜${pct}`);
  }

  lines.push('', '今天的新聞（只能引用這些編號）：');
  for (const n of news) lines.push(`[${n.id}] ${n.title}`);

  return lines.join('\n');
}

/**
 * 組出完整請求內容。news 一定要先過 forAI() ——
 * 未明示允許 AI 輸入的來源連標題都不能進來（使用者定的規則）。
 */
export function buildPrompt({ date, news, holdings, marketChangePct, maxItems = MAX_NEWS_ITEMS }) {
  // 先過 forAI（來源白名單），再限制則數。順序不能反 ——
  // 反過來的話，被擋的來源會先佔掉名額。
  const allowed = forAI(news).slice(0, maxItems);
  return {
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserContent({ date, news: allowed, holdings, marketChangePct }) }],
    usedNewsIds: allowed.map((n) => n.id),
  };
}

// ---------- 產生與過濾 ----------

/**
 * 從一段文字裡挖出第一個**完整且平衡**的 JSON 物件。
 *
 * 用括號配對而不是正則：正則抓不出巢狀結構，遇到 `{"a":{"b":1}}` 會在第一個 `}` 就停。
 * 字串裡的大括號與跳脫字元也要正確跳過，不然 `{"t":"}"}` 會算錯。
 *
 * 這是**容錯**，不是放寬安全：挖出來的東西照樣要過禁用詞過濾（filterInsight）。
 */
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 開了沒關 —— 通常就是被 max_tokens 截斷
}

/**
 * 把模型回的文字拆成 JSON。
 *
 * 依序嘗試：整段當 JSON → 去掉 ``` 圍欄 → 挖出第一個平衡的物件。
 * 三種都失敗才放棄，而且要說得出**是哪一種失敗**（截斷 vs 根本不是 JSON），
 * 因為那兩種的下一步完全不同。
 */
export function parseOutput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '模型沒有回任何文字', kind: 'empty' };

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [raw, fenced?.[1], extractJsonObject(fenced?.[1] ?? raw)].filter(Boolean);

  let json = null;
  for (const c of candidates) {
    try { json = JSON.parse(c); break; } catch { /* 換下一個 */ }
  }
  if (json == null) {
    // 有 `{` 卻挖不出平衡的物件 ＝ 開了沒關 ＝ 幾乎一定是被截斷
    const looksTruncated = raw.includes('{') && extractJsonObject(raw) == null;
    return looksTruncated
      ? { ok: false, error: '模型的回覆被截斷了（JSON 沒有結束）', kind: 'truncated', raw: raw.slice(0, 400) }
      : { ok: false, error: '模型回的不是 JSON', kind: 'notJson', raw: raw.slice(0, 400) };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: '模型回的不是物件', kind: 'notObject', raw: raw.slice(0, 400) };
  }
  return {
    ok: true,
    json: {
      summary: typeof json.summary === 'string' ? json.summary : '',
      sections: Array.isArray(json.sections) ? json.sections : [],
      watchDates: Array.isArray(json.watchDates) ? json.watchDates : [],
    },
  };
}

/**
 * 後線：把越界的段落標起來。
 *
 * 命中的段落**不刪掉、也不改寫**，而是標 `hidden` 與原因，讓畫面顯示
 * 「這一段越界了，已隱藏」。改寫模型的輸出會讓人以為那是模型說的話。
 */
export function filterInsight(json) {
  const summaryHits = scanViolations(json.summary);
  const sections = (json.sections ?? []).map((s) => {
    const hits = scanViolations(s.observation ?? '');
    return hits.length ? { ...s, hidden: true, hiddenWhy: [...new Set(hits.map((h) => h.why))] } : s;
  });
  return {
    summary: json.summary,
    summaryHidden: summaryHits.length > 0,
    summaryHiddenWhy: [...new Set(summaryHits.map((h) => h.why))],
    sections,
    watchDates: json.watchDates ?? [],
    hiddenCount: (summaryHits.length ? 1 : 0) + sections.filter((s) => s.hidden).length,
  };
}

/**
 * 解析失敗時要跟使用者說什麼。
 *
 * 「模型回的不是 JSON」對使用者毫無意義 —— 他不知道是金鑰錯、額度滿、網路問題
 * 還是程式有 bug。這裡把「怎麼失敗的」翻成「你可以做什麼」。
 */
export function explainParseFailure(parsed, stopReason) {
  if (stopReason === 'max_tokens' || parsed.kind === 'truncated') {
    return '整理到一半被長度上限截斷了。按「重新產生」通常就會好；一直發生的話代表今天的新聞太多。';
  }
  if (parsed.kind === 'empty') {
    return '模型沒有回任何內容。按「重新產生」再試一次。';
  }
  return '模型回的格式不對，這次沒有辦法顯示。按「重新產生」再試一次；'
    + '如果一直這樣，可能是這個 App 要更新了。';
}

// ---------- 儲存 ----------

export async function forDate(date) {
  return (await db.get('insights', date)) ?? null;
}

/**
 * 產生今天的觀察。
 * 同一天已經有就直接回，除非 force（畫面上的「重新產生」）。
 */
export async function generate({ date, news, holdings, marketChangePct, force = false, fetchImpl = fetch, now = new Date() }) {
  const existing = await forDate(date);
  if (existing && !force) return { ok: true, cached: true, ...existing };

  const st = await secrets.status({ now });
  if (!st.configured) return { ok: false, error: '還沒有設定 AI 金鑰' };
  if (st.overCap) return { ok: false, error: `本月用量已達上限 ${secrets.fmtUsd(st.capMicroUsd)}，暫停產生` };

  const rec = await secrets.load();
  const prompt = buildPrompt({ date, news, holdings, marketChangePct });

  let res;
  try {
    res = await secrets.callAnthropic({
      key: rec.key,
      model: st.model,
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      outputConfig: { format: OUTPUT_SCHEMA },
      fetchImpl,
    });
  } catch (e) {
    // callAnthropic 已經把狀態碼翻成人話了；detail 留著給除錯用（已 scrub）。
    return { ok: false, error: secrets.scrub(e?.message || String(e)), detail: e?.detail ?? null };
  }

  // stop_reason 是**唯一**分得出「模型拒絕」與「被截斷」的訊號，
  // 而且兩種都是 HTTP 200（官方文件 Structured outputs → Invalid outputs）。
  // 不看它的話，兩種都只會變成一句莫名其妙的「模型回的不是 JSON」。
  const stop = res?.stop_reason ?? null;
  if (stop === 'refusal') {
    return {
      ok: false,
      error: '模型基於安全理由拒絕回答這次的請求。可以按「重新產生」再試一次。',
      stopReason: stop,
    };
  }

  const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const parsed = parseOutput(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: explainParseFailure(parsed, stop),
      kind: parsed.kind,
      stopReason: stop,
      detail: secrets.scrub(parsed.raw ?? ''),
    };
  }

  const usage = res?.usage ?? {};
  await secrets.addUsage({
    model: st.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    now,
  });

  const record = {
    date,
    model: st.model,
    json: parsed.json,
    usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
    createdAt: now.toISOString(),
  };
  await db.put('insights', record);
  return { ok: true, cached: false, ...record };
}
