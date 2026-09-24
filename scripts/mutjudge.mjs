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
 *   'extra-red'   紅在含 expect 的那一條，**但別組也一起紅了**（extra 列出多紅的那幾條）——
 *                 保證不了「只紅對應的那一種」。這條突變若本來就該連帶紅別組（例如整道關卡失效），
 *                 要在突變上用 alsoRed 明列那幾組的固定標籤，並在 why 講清楚為什麼。
 * 沒帶 expect 的突變照舊：只看 exit code。
 *
 * 2026-09-24 以前只要「有一條」對上 expect 就判 red，不看別組有沒有一起紅（統籌者驗收指出）：
 * 負責判斷「過了沒」的這一層，自己不夠嚴。
 */
export function judge({ code, out }, expect, alsoRed = []) {
  if (code === 0) return { verdict: 'not-red', failed: [], extra: [] };
  const failed = failedAssertions(out);
  if (!expect) return { verdict: 'red', failed, extra: [] };
  if (!failed.some((f) => f.includes(expect))) return { verdict: 'wrong-place', failed, extra: [] };
  const extra = failed.filter((f) => !f.includes(expect) && !alsoRed.some((a) => f.includes(a)));
  return { verdict: extra.length ? 'extra-red' : 'red', failed, extra };
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
  const probs = testSrc.includes(mut.expect) ? [] : [`expect「${mut.expect}」在 scripts/${mut.test}.mjs 裡找不到`];
  // alsoRed 同理：每一條都要是測試原始碼裡的字面，而且不能是空字串（空字串會讓每一條都算「宣告過」）
  if (mut.alsoRed != null) {
    // 連帶紅要講得出為什麼：沒有理由的 alsoRed，等於把「只紅對應」的檢查關掉
    if (typeof mut.alsoRedWhy !== 'string' || mut.alsoRedWhy.trim().length < 6) probs.push('有 alsoRed 就要寫 alsoRedWhy（為什麼會連帶紅別組）');
    if (!Array.isArray(mut.alsoRed) || mut.alsoRed.length === 0) probs.push('alsoRed 要是非空的陣列');
    else {
      for (const a of mut.alsoRed) {
        if (typeof a !== 'string' || a.trim() === '') probs.push('alsoRed 裡有空的一條');
        else if (!testSrc.includes(a)) probs.push(`alsoRed「${a}」在 scripts/${mut.test}.mjs 裡找不到`);
      }
    }
  }
  return probs;
}

/**
 * 一條突變還有沒有效（不跑任何測試）：find 在目標檔裡**剛好出現一次**、改了真的有差、測試檔存在。
 * mutationtest 本來就會在 find 找不到時判過期 —— 但那要等到跑到那一條（整套一個半小時）才看得到。
 * 實例：條狀圖寬度那條從 v0.7.22 起過期，直到 2026-09-21 全面檢測才被發現。
 */
export function findProblems(mut, read) {
  const probs = [];
  const body = read(mut.file);
  if (body == null) probs.push(`要改的檔 ${mut.file} 不存在`);
  else {
    const n = countOf(body, mut.find);
    if (n !== 1) probs.push(`find 在 ${mut.file} 出現 ${n} 次（需要剛好 1 次）`);
  }
  if (mut.find === mut.replace) probs.push('find 與 replace 一模一樣，改了等於沒改');
  if (read(`scripts/${mut.test}.mjs`) == null) probs.push(`指定的測試 scripts/${mut.test}.mjs 不存在`);
  return probs;
}

/** 原始碼裡標記「以下新增的一律要帶 expect」的那一行；它之前有幾條突變。 */
export const EXPECT_MARKER = '// ──── EXPECT_REQUIRED_BELOW ────';
export function legacyCount(src) {
  const at = src.indexOf(EXPECT_MARKER);
  if (at < 0) return null;
  return (src.slice(src.indexOf('const MUTATIONS = ['), at).match(/^\s+find:/gm) || []).length;
}
