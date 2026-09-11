// 金鑰、模型、用量。
//
// 三條規則，違反哪一條都是資安事故：
//
//  1. **金鑰只住在 `secrets` 這個 object store。** 它不在 `db.EXPORTABLE_STORES` 裡，
//     所有匯出／備份的程式碼只走那份清單 —— 結構上就讀不到金鑰，不是靠記得排除。
//  2. **任何要顯示給使用者的字串，先過 `scrub()`。** AI 的輸出、錯誤訊息、log 都算。
//     金鑰最常見的外洩方式不是被偷，是被自己印在錯誤訊息裡。
//  3. **畫面上永遠只顯示遮罩。** 存進去之後就沒有「再看一次完整金鑰」這個功能。
//
// 另外：清除本機金鑰**不等於**停用它。要真的停用，必須到 Anthropic 後台 Delete。
// 這句話要出現在畫面上，不能只寫在這裡。

import * as db from './db.js';

export const PROVIDER = 'anthropic';
export const KEY_PREFIX = 'sk-ant-';

/**
 * 模型與費率（美金／每百萬 token，FEASIBILITY §7 於 2026-09 記錄）。
 *
 * 六個費率**都是整數**，所以用量可以用整數微美金精準累加：
 *   成本(微美金) = token 數 × 每百萬 token 的美金價
 * （因為 tokens/1e6 × rate × 1e6 = tokens × rate）。沒有浮點數，不會漂。
 */
export const MODELS = [
  { id: 'claude-sonnet-5', name: 'Sonnet 5', inRate: 2, outRate: 10, note: '預設。速度與品質的平衡' },
  { id: 'claude-opus-5', name: 'Opus 5', inRate: 5, outRate: 25, note: '最貴' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', inRate: 1, outRate: 5, note: '最便宜、最快' },
];
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_CAP_MICRO_USD = 2_000_000; // $2

export function modelById(id) { return MODELS.find((m) => m.id === id) ?? null; }

/**
 * 把任何看起來像金鑰的東西抹掉。
 * 顯示給使用者的每一個字串都要先過這裡 —— 包含例外訊息與 AI 的輸出。
 */
export function scrub(text) {
  if (text == null) return text;
  return String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
}

/** 遮罩：只露出前綴與最後 4 碼，足夠讓使用者認出「是這一把」，不夠拿去用。 */
export function mask(key) {
  if (!key) return '';
  const tail = key.slice(-4);
  return `${KEY_PREFIX}…${tail}`;
}

/**
 * 格式檢查。只看得出「明顯不對」，看不出「這把能不能用」——
 * 後者只有真的打一次 API 才知道，所以存之前一定要 testKey()。
 */
export function checkFormat(key) {
  const k = String(key ?? '').trim();
  if (!k) return { ok: false, error: '還沒貼上金鑰' };
  if (/\s/.test(k)) return { ok: false, error: '金鑰裡有空白字元，可能複製到多餘的東西' };
  if (!k.startsWith(KEY_PREFIX)) return { ok: false, error: `金鑰應該以 ${KEY_PREFIX} 開頭` };
  if (k.length < 40) return { ok: false, error: '金鑰長度不對，可能沒複製完整' };
  return { ok: true, key: k };
}

// ---------- 儲存 ----------

export async function load() {
  return (await db.get('secrets', PROVIDER)) ?? null;
}

export async function hasKey() {
  const r = await load();
  return !!r?.key;
}

/** 畫面要用的東西。**永遠不回傳金鑰本身。** */
export async function status({ now = new Date() } = {}) {
  const r = await load();
  const month = monthOf(now);
  const used = r?.usage?.month === month ? (r.usage.usedMicroUsd ?? 0) : 0;
  const capMicro = r?.capMicroUsd ?? DEFAULT_CAP_MICRO_USD;
  return {
    configured: !!r?.key,
    masked: r?.key ? mask(r.key) : '',
    model: r?.model ?? DEFAULT_MODEL,
    month,
    usedMicroUsd: used,
    capMicroUsd: capMicro,
    overCap: used >= capMicro,
    savedAt: r?.savedAt ?? null,
  };
}

export async function save({ key, model = DEFAULT_MODEL }) {
  const check = checkFormat(key);
  if (!check.ok) throw new Error(check.error);
  const prev = await load();
  await db.put('secrets', {
    provider: PROVIDER,
    key: check.key,
    model,
    capMicroUsd: prev?.capMicroUsd ?? DEFAULT_CAP_MICRO_USD,
    usage: prev?.usage ?? { month: monthOf(new Date()), usedMicroUsd: 0 },
    savedAt: new Date().toISOString(),
  });
}

export async function setModel(model) {
  if (!modelById(model)) throw new Error(`不認得的模型：${model}`);
  const r = await load();
  if (!r) throw new Error('還沒有金鑰');
  await db.put('secrets', { ...r, model });
}

export async function setCap(microUsd) {
  const r = await load();
  if (!r) throw new Error('還沒有金鑰');
  if (!Number.isInteger(microUsd) || microUsd < 0) throw new Error('上限必須是非負整數（微美金）');
  await db.put('secrets', { ...r, capMicroUsd: microUsd });
}

/** 清掉本機這一把。**這不等於停用** —— 畫面必須同時講清楚要去後台 Delete。 */
export async function clear() {
  await db.del('secrets', PROVIDER);
}

export function monthOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 這次呼叫花了多少（微美金）。整數運算，不會漂。 */
export function costMicroUsd({ model, inputTokens = 0, outputTokens = 0 }) {
  const m = modelById(model);
  if (!m) throw new Error(`不認得的模型：${model}`);
  const n = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
  return n(inputTokens) * m.inRate + n(outputTokens) * m.outRate;
}

/** 把一次呼叫的用量加上去。跨月自動歸零重算。 */
export async function addUsage({ model, inputTokens, outputTokens, now = new Date() }) {
  const r = await load();
  if (!r) return null;
  const month = monthOf(now);
  const base = r.usage?.month === month ? (r.usage.usedMicroUsd ?? 0) : 0;
  const cost = costMicroUsd({ model: model ?? r.model, inputTokens, outputTokens });
  const usage = { month, usedMicroUsd: base + cost };
  await db.put('secrets', { ...r, usage });
  return { cost, ...usage };
}

/** 微美金 → 顯示用字串。小數點後兩位不夠看（一次可能才幾分錢），用四位。 */
export function fmtUsd(microUsd) {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

// ---------- 呼叫 ----------

/**
 * 組出要送去 api.anthropic.com 的請求。
 *
 * 拆成獨立函式是為了**能在不送出的情況下檢查它** —— 測試要能斷言
 * 「送出去的東西裡沒有股數、沒有金額、只有允許來源的標題」。
 * 送出的動作在 callAnthropic()，組裝在這裡。
 */
export function buildRequest({ key, model, system, messages, maxTokens = 2048 }) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // 瀏覽器直連需要這個標頭，否則 CORS 不放行。
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    },
  };
}

/**
 * 打一次 API。錯誤訊息一律 scrub 過再往外丟 ——
 * Anthropic 的錯誤回應有時會把送出的標頭原樣回echo。
 */
export async function callAnthropic({ key, model, system, messages, maxTokens, fetchImpl = fetch, timeoutMs = 60000 }) {
  const { url, init } = buildRequest({ key, model, system, messages, maxTokens });
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(scrub(`連不上 Anthropic：${e?.name === 'TimeoutError' ? '逾時' : (e?.message || e)}`));
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text)?.error?.message ?? text; } catch { /* 原樣 */ }
    throw new Error(scrub(`Anthropic 回 ${res.status}：${String(detail).slice(0, 300)}`));
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Anthropic 回了不是 JSON 的東西'); }
  return json;
}

/**
 * 驗這把金鑰能不能用：送一次**最小**呼叫（max_tokens 1）。
 * 不用這把去做任何實際工作，純粹確認它是活的。
 */
export async function testKey({ key, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  const check = checkFormat(key);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const json = await callAnthropic({
      key: check.key,
      model,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1,
      fetchImpl,
      timeoutMs: 20000,
    });
    return { ok: true, usage: json?.usage ?? null };
  } catch (e) {
    return { ok: false, error: scrub(e?.message || String(e)) };
  }
}
