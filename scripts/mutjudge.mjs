// 突變的判定與清單載入 —— 純函式，給 mutationtest 與 checkmutations 共用。
//
// 為什麼抽出來：判定邏輯本身也要被測。「有 expect 的突變，紅錯地方要判不合格」
// 如果只寫在 mutationtest 的迴圈裡，唯一能驗它的方法是跑一次要一個半小時的整套；
// 抽成純函式之後，checkmutations 用假的測試輸出就能在一秒內驗完，而且突變得到它。

/**
 * 從一支測試的輸出取出「失敗的斷言訊息」。
 *
 * tap.mjs 印失敗的格式是兩格縮排加 `✗ `，後面接訊息；noneOf／everyOf 還會在訊息後面
 * 接「（檢查了 N 項）」。細節（實際值、例子）在下一行、六格縮排 —— 那不是斷言訊息，不收。
 * 測試直接丟例外（沒有任何 ✗ 行、exit code 非 0）時回空陣列：那是「壞了」，不是「紅在某條斷言」。
 */
export function failedAssertions(out) {
  const msgs = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^ {2}✗ (.+)$/.exec(line.replace(/\r$/, ''));
    if (m) msgs.push(m[1]);
  }
  return msgs;
}

/**
 * 一條突變的結果。
 *   'red'         測試紅了；有 expect 的話，而且至少一條失敗的斷言訊息含 expect
 *   'not-red'     測試還是綠的 —— 對應的斷言沒有在檢查這件事
 *   'wrong-place' 測試紅了，但沒有任何一條失敗的斷言含 expect —— 紅的是別條（或測試直接崩了），
 *                 不能證明它想守的那一條有效
 * 沒帶 expect 的突變照舊：只看 exit code。
 */
export function judge({ code, out }, expect) {
  if (code === 0) return { verdict: 'not-red', failed: [] };
  const failed = failedAssertions(out);
  if (!expect) return { verdict: 'red', failed };
  return { verdict: failed.some((f) => f.includes(expect)) ? 'red' : 'wrong-place', failed };
}

/** find 在內容裡出現幾次。突變只在「剛好 1 次」時才有意義。 */
export const countOf = (body, find) => (find ? body.split(find).length - 1 : 0);

/**
 * 套用突變。用 split/join，**不用** `String.replace(字串, 字串)`：
 * 後者會把替換字串裡的 `$$`、`$&`、`$'` 當特殊序列（STATUS 接手者第 40 條）。
 * 呼叫前已確認 find 剛好出現一次，所以 split/join 與「只換第一個」結果相同。
 */
export const applyMutation = (body, find, replace) => body.split(find).join(replace);

/**
 * 從 mutationtest.mjs 的原始碼取出 MUTATIONS 陣列（它是字面資料，只用到 APP_VERSION 這一個變數）。
 * 這樣 checkmutations 不必 import mutationtest.mjs —— import 它就會開始跑整套。
 */
export function loadMutations(src, appVersion) {
  const head = 'const MUTATIONS = [';
  const start = src.indexOf(head);
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('mutationtest.mjs 裡找不到 MUTATIONS 陣列');
  const literal = src.slice(start + head.length - 1, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function('APP_VERSION', `return ${literal};`)(appVersion);
}

/**
 * 一條突變的 expect 有沒有問題（不跑任何測試）。回傳問題清單，空陣列＝沒問題。
 *   read(rel)   讀檔，檔案不存在回 null
 * expect 要是測試原始碼裡的一段**字面** —— 打錯字的話它永遠不會命中，
 * 那條突變會永遠判成「紅錯地方」，而且要等到跑整套（一個半小時）才看得到。
 */
export function expectProblems(mut, read) {
  if (mut.expect == null) return [];
  if (typeof mut.expect !== 'string' || mut.expect.trim() === '') return ['expect 是空的'];
  const testSrc = read(`scripts/${mut.test}.mjs`);
  if (testSrc == null) return [`指定的測試 scripts/${mut.test}.mjs 不存在`];
  return testSrc.includes(mut.expect) ? [] : [`expect「${mut.expect}」在 scripts/${mut.test}.mjs 裡找不到`];
}

/** 原始碼裡標記「以下新增的一律要帶 expect」的那一行；它之前有幾條突變。 */
export const EXPECT_MARKER = '// ──── EXPECT_REQUIRED_BELOW ────';
export function legacyCount(src) {
  const at = src.indexOf(EXPECT_MARKER);
  if (at < 0) return null;
  return (src.slice(src.indexOf('const MUTATIONS = ['), at).match(/^\s+find:/gm) || []).length;
}
