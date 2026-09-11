// 對 www.twse.com.tw 的請求客戶端：**序列化 ＋ 最小間隔 ＋ 單次開頁上限**。
//
// 為什麼一定要有：TWSE 的社群共識是約 3 次／5 秒會被封 IP 一段時間
// （FEASIBILITY §1.2）。被封的後果不是「這次抓不到」，是「這個使用者接下來
// 一段時間完全打不開 App」。所以：
//   · 所有請求走同一條佇列，就算畫面同時叫了五個地方也一樣一個一個來
//   · 每兩個請求之間至少 MIN_GAP_MS
//   · 一次開頁最多 MAX_REQUESTS 個，超過就停手並讓畫面說清楚（PLAN §2.3）
//
// fetch 與計時都可以注入，測試才量得到真正的間隔，而不是讀程式碼猜。

export const MIN_GAP_MS = 2000;
export const MAX_REQUESTS = 30;
export const TIMEOUT_MS = 15000;

export class BudgetExceededError extends Error {
  constructor(max) {
    super(`這次已經向證交所查詢 ${max} 次，先停在這裡。稍後再開一次 App 會接著補。`);
    this.name = 'BudgetExceededError';
    this.budget = max;
  }
}

export function createClient({
  fetchImpl = (...a) => fetch(...a),
  minGapMs = MIN_GAP_MS,
  maxRequests = MAX_REQUESTS,
  timeoutMs = TIMEOUT_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastAt = 0;
  let count = 0;
  const gaps = [];
  // 一條 promise 鏈，保證同時間只有一個請求在飛
  let queue = Promise.resolve();

  async function run(url, { signal } = {}) {
    if (count >= maxRequests) throw new BudgetExceededError(maxRequests);
    const wait = lastAt === 0 ? 0 : Math.max(0, minGapMs - (now() - lastAt));
    if (wait > 0) await sleep(wait);
    if (lastAt !== 0) gaps.push(now() - lastAt);
    lastAt = now();
    count += 1;
    const res = await fetchImpl(url, {
      signal: signal ?? AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*' },
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
  }

  return {
    /** 排隊送出一個請求，回 Response。 */
    get(url, opts) {
      const task = queue.then(() => run(url, opts));
      // 這一個失敗不能讓整條佇列斷掉，但要把錯誤傳給呼叫端
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
    async getText(url, opts) { return (await this.get(url, opts)).text(); },
    async getJson(url, opts) { return JSON.parse(await this.getText(url, opts)); },
    stats() { return { count, gaps: [...gaps], remaining: Math.max(0, maxRequests - count) }; },
    /** 還剩幾次可以打。畫面用來決定要不要提示「分批」。 */
    remaining() { return Math.max(0, maxRequests - count); },
  };
}
