// 測試用的小工具。
//
// 設計上要擋掉兩種「假斷言」：
//
//   1. 「應該一筆都沒有」的斷言，如果母體本來就是空的，它永遠會過。
//      → noneOf() 強制同時斷言母體非空，忘不掉。
//
//   2. 「檢查器有抓到壞東西」的斷言，如果檢查器壞掉變成「什麼都抓」，它也會過。
//      → detects() 強制同時給正例與反例（該抓的抓到、不該抓的沒抓）。
//
// 另外：註解不是斷言，訊息裡要寫出實際看到的值，失敗時才知道發生什麼事。

let pass = 0;
let fail = 0;

export function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; console.log('  ✓ ' + msg); }
  else { fail += 1; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
  return !!cond;
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return ok(a === e, msg, `實際 ${a}，預期 ${e}`);
}

export function near(actual, expected, tol, msg) {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  return ok(good, msg, `實際 ${actual}，預期 ${expected} ±${tol}`);
}

export function throws(fn, rx, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) return ok(false, msg, '沒有丟出例外');
  return ok(rx.test(String(err.message || err)), msg, `例外訊息是「${String(err.message || err)}」，預期符合 ${rx}`);
}

/** 母體非空，而且裡面沒有任何一個符合 pred。兩件事一起斷言。 */
export function noneOf(list, pred, msg) {
  const arr = [...list];
  if (arr.length === 0) return ok(false, msg, '母體是空的 —— 這條斷言沒有檢查到任何東西');
  const hits = arr.filter((x, i) => pred(x, i, arr));
  return ok(hits.length === 0, `${msg}（檢查了 ${arr.length} 項）`,
    hits.length ? `命中 ${hits.length} 項，例如 ${JSON.stringify(hits[0]).slice(0, 200)}` : '');
}

/** 母體非空，而且每一個都符合 pred。 */
export function everyOf(list, pred, msg) {
  const arr = [...list];
  if (arr.length === 0) return ok(false, msg, '母體是空的 —— 這條斷言沒有檢查到任何東西');
  const bad = arr.filter((x, i) => !pred(x, i, arr));
  return ok(bad.length === 0, `${msg}（檢查了 ${arr.length} 項）`,
    bad.length ? `不符合 ${bad.length} 項，例如 ${JSON.stringify(bad[0]).slice(0, 200)}` : '');
}

/**
 * 檢查器對照組：正例（shouldHit）每個都要被抓到，反例（shouldMiss）每個都不能被抓到。
 * 只測正例的話，一個「永遠回 true」的壞檢查器也會全過。
 */
export function detects(fn, { shouldHit, shouldMiss }, msg) {
  const missed = shouldHit.filter((x) => !fn(x));
  const falsePos = shouldMiss.filter((x) => fn(x));
  const good = shouldHit.length > 0 && shouldMiss.length > 0 && missed.length === 0 && falsePos.length === 0;
  return ok(good, `${msg}（正例 ${shouldHit.length}、反例 ${shouldMiss.length}）`,
    [
      shouldHit.length === 0 ? '沒有給正例' : '',
      shouldMiss.length === 0 ? '沒有給反例' : '',
      missed.length ? `該抓沒抓到：${JSON.stringify(missed).slice(0, 200)}` : '',
      falsePos.length ? `不該抓卻抓了：${JSON.stringify(falsePos).slice(0, 200)}` : '',
    ].filter(Boolean).join('；'));
}

export function section(title) { console.log(`\n— ${title} —`); }

export function done(name) {
  console.log(`\n${name}：${pass} 項通過` + (fail ? `，${fail} 項失敗` : ''));
  if (fail) process.exit(1);
}
