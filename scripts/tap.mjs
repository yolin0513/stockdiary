// 測試用的小工具。
//
// 設計上要擋掉三種「假斷言」：
//
//   1. 「應該一筆都沒有」的斷言，如果母體本來就是空的，它永遠會過。
//      → noneOf() 強制同時斷言母體非空，忘不掉。
//
//   2. 「檢查器有抓到壞東西」的斷言，如果檢查器壞掉變成「什麼都抓」，它也會過。
//      → detects() 強制同時給正例與反例（該抓的抓到、不該抓的沒抓）。
//
//   3. **說明行混進斷言數裡。** `ok(true, …)` 永遠會過，但它根本不是在檢查東西；
//      混進「N 項通過」之後，讀的人會以為驗了 N 件事。
//      → note() 專門放這種說明行，不計入通過數。
//
// 另外：註解不是斷言，訊息裡要寫出實際看到的值，失敗時才知道發生什麼事。
//
// `SD_AUDIT=1` 時會把每條斷言（含母體大小）寫進 JSONL，給 scripts/assertaudit.mjs
// 做全套的假斷言健檢 —— 一條一條人工看會漏，所以用機器掃。

import fs from 'node:fs';

let pass = 0;
let fail = 0;
let notes = 0;

const AUDIT = process.env.SD_AUDIT === '1';
const audit = [];
let currentSection = '';

function record(kind, msg, n = null) {
  if (AUDIT) audit.push({ kind, section: currentSection, msg: String(msg).slice(0, 140), n });
}

export function ok(cond, msg, extra = '') {
  record('ok', msg);
  if (cond) { pass += 1; console.log('  ✓ ' + msg); }
  else { fail += 1; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
  return !!cond;
}

/**
 * 說明行，**不是斷言**。
 *
 * 有些輸出是在講「這次觀察到什麼」而不是「這件事必須成立」（例如 livecheck 報告
 * 這次抓到幾筆樣本、sweep 說忽略了幾筆上游限速）。那些以前寫成 `ok(true, …)`，
 * 於是混進通過數裡。分開之後，「N 項通過」只算真的斷言。
 */
export function note(msg) {
  notes += 1;
  record('note', msg);
  console.log('  · ' + msg);
}

/**
 * JSON.stringify 不會序列化 BigInt（直接丟 TypeError）。
 * 這個 App 的金額全是 BigInt 微元，沒有這個 replacer 就沒辦法用 eq() 比對金額。
 */
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

export function eq(actual, expected, msg) {
  const a = show(actual);
  const e = show(expected);
  record('eq', msg);
  if (a === e) { pass += 1; console.log('  ✓ ' + msg); return true; }
  fail += 1;
  console.log(`  ✗ ${msg}\n      實際 ${a}，預期 ${e}`);
  return false;
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
  record('noneOf', msg, arr.length);
  if (arr.length === 0) {
    fail += 1;
    console.log(`  ✗ ${msg}\n      母體是空的 —— 這條斷言沒有檢查到任何東西`);
    return false;
  }
  const hits = arr.filter((x, i) => pred(x, i, arr));
  const good = hits.length === 0;
  if (good) { pass += 1; console.log(`  ✓ ${msg}（檢查了 ${arr.length} 項）`); return true; }
  fail += 1;
  console.log(`  ✗ ${msg}（檢查了 ${arr.length} 項）\n      命中 ${hits.length} 項，例如 ${show(hits[0]).slice(0, 200)}`);
  return false;
}

/** 母體非空，而且每一個都符合 pred。 */
export function everyOf(list, pred, msg) {
  const arr = [...list];
  record('everyOf', msg, arr.length);
  if (arr.length === 0) {
    fail += 1;
    console.log(`  ✗ ${msg}\n      母體是空的 —— 這條斷言沒有檢查到任何東西`);
    return false;
  }
  const bad = arr.filter((x, i) => !pred(x, i, arr));
  const good = bad.length === 0;
  if (good) { pass += 1; console.log(`  ✓ ${msg}（檢查了 ${arr.length} 項）`); return true; }
  fail += 1;
  console.log(`  ✗ ${msg}（檢查了 ${arr.length} 項）\n      不符合 ${bad.length} 項，例如 ${show(bad[0]).slice(0, 200)}`);
  return false;
}

/**
 * 檢查器對照組：正例（shouldHit）每個都要被抓到，反例（shouldMiss）每個都不能被抓到。
 * 只測正例的話，一個「永遠回 true」的壞檢查器也會全過。
 */
export function detects(fn, { shouldHit, shouldMiss }, msg) {
  record('detects', msg, Math.min(shouldHit.length, shouldMiss.length));
  const missed = shouldHit.filter((x) => !fn(x));
  const falsePos = shouldMiss.filter((x) => fn(x));
  const good = shouldHit.length > 0 && shouldMiss.length > 0 && missed.length === 0 && falsePos.length === 0;
  const label = `${msg}（正例 ${shouldHit.length}、反例 ${shouldMiss.length}）`;
  if (good) { pass += 1; console.log('  ✓ ' + label); return true; }
  fail += 1;
  console.log(`  ✗ ${label}\n      ` + [
    shouldHit.length === 0 ? '沒有給正例' : '',
    shouldMiss.length === 0 ? '沒有給反例' : '',
    missed.length ? `該抓沒抓到：${show(missed).slice(0, 200)}` : '',
    falsePos.length ? `不該抓卻抓了：${show(falsePos).slice(0, 200)}` : '',
  ].filter(Boolean).join('；'));
  return false;
}

export function section(title) {
  currentSection = String(title);
  record('section', title);
  console.log(`\n— ${title} —`);
}

export function done(name) {
  if (AUDIT) {
    const out = process.env.SD_AUDIT_OUT || 'assert-audit.jsonl';
    fs.appendFileSync(out, `${audit.map((a) => JSON.stringify({ test: name, ...a })).join('\n')}\n`, 'utf8');
  }
  console.log(`\n${name}：${pass} 項通過`
    + (notes ? `（另有 ${notes} 行說明，不算斷言）` : '')
    + (fail ? `，${fail} 項失敗` : ''));
  if (fail) process.exit(1);
}
