// 三支 build 的寫檔前關卡（npm run buildtest；在 npm test 鏈裡）——F8 的四家統一驗法。
//
// 為什麼（STATUS「S8：三支 build 的盤點」；2026-09-24 立成 F8，優先度同 P0）：資料變少時三支都照樣寫檔，
// build-dividends 一筆都收不進來時照樣寫出「0 檔」的輸出。修法在 scripts/buildguard.mjs：動手寫檔之前
// 先確認每一個單位都在、有效筆數達到下限、沒有比上一次成功的少一半以上；缺任何一個就一個檔都不寫。
//
// 驗法（F8 四家統一）：母體是「**每一個單位 × 每一種情境**」寫成迴圈、不挑代表。每一格三件事都要成立：
//   1. 回傳值非 0
//   2. 擋下的理由**點名這個單位、這一種狀況**，而且落在錯誤訊息的位置（「不寫檔：」後面那串「  · 」問題清單）——
//      被別的規則碰巧擋下（理由裡沒有這個單位）一律算「沒擋」
//   3. **輸出目錄（data/）的雜湊前後相同**（一個檔都沒寫、也沒留下暫存檔）
//   4. 沒有吐堆疊（設計好的停下只印訊息；補充說明（四）第 5 點）
// 分三類記（照 MealMate 的形狀）：擋／碰巧擋下（回非 0、輸出沒變，但沒點名這個單位或吐了堆疊）／沒擋。
// 寫檔那一步出事的三種（暫存檔的位置被佔住、換不上去、清理也失敗）另成一張表，三支各三格。
// 每一支另跑一格「正常輸入要寫檔、回 0」的對照（不然「什麼都擋」的關卡也會讓矩陣全過）。
// 在暫存目錄放 scripts／js／data 的複本，從真實入口（node scripts/build-*.mjs）跑，fetch 換成 scripts/testfetch.mjs（不打網路）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtest-'));
const SCRIPTS = ['build-calendar.mjs', 'build-dividends.mjs', 'build-stocks.mjs', 'buildguard.mjs', 'testfetch.mjs'];
fs.mkdirSync(path.join(W, 'scripts'));
for (const f of SCRIPTS) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(W, 'scripts', f));
fs.cpSync(path.join(REPO, 'js'), path.join(W, 'js'), { recursive: true });
fs.cpSync(path.join(REPO, 'data'), path.join(W, 'data'), { recursive: true });
const DATA = path.join(W, 'data');
const IN = path.join(W, 'in');
fs.mkdirSync(IN);

/** 輸出目錄的雜湊：每一個檔的相對路徑＋內容（多一個檔、少一個檔、改一個字都會變）。 */
function dirHash(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(dir, p)); h.update('\0'); h.update(fs.readFileSync(p)); h.update('\0'); }
    }
  };
  walk(dir);
  return h.digest('hex');
}
const put = (name, data) => { const f = path.join(IN, name); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };
/**
 * 「不寫檔：」或「寫檔失敗：」後面那串問題清單（只取「  · 」開頭的行）。擋下的理由必須落在這裡——
 * 不數整份輸出有沒有出現那個字（補充說明（四）第 1 點：正常的進度輸出裡本來就會印出同一個名字）。
 */
const reasonsOf = (out) => {
  const i = [out.indexOf('不寫檔：'), out.indexOf('寫檔失敗：')].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  if (i == null) return [];
  return out.slice(i).split('\n').filter((l) => l.startsWith('  · ')).map((l) => l.slice(4));
};
/**
 * 理由裡有沒有這個狀況字眼——**對邊界**：「0 筆」不能被「10 筆」湊到（數字開頭的字眼，前一個字不能也是數字）。
 * 單位名稱的邊界由「單位：」的全形冒號保證（isinOtc 湊不到 isinOtcX）。
 */
function hasWord(x, k) {
  for (let i = x.indexOf(k); i >= 0; i = x.indexOf(k, i + 1)) {
    if (!(/^\d/.test(k) && /\d/.test(x[i - 1] ?? ''))) return true;
  }
  return false;
}
/** 吐了堆疊（設計好的停下只印訊息；堆疊代表沒接住）。 */
const hasStack = (out) => out.split('\n').some((l) => /^\s+at .+:\d+:\d+\)?\s*$/.test(l));

// 對照（§5.11 第二層）：擷取理由的程式、目錄雜湊、堆疊的判斷，各自兩個方向
{
  const sample = '  twseCompanies：用快取（1 KB）\nError: build-stocks 不寫檔：寫檔前的檢查沒過\n  · tpexCompanies：來源 0 筆\n  · 上櫃：檔數少了一半以上';
  const got = reasonsOf(sample);
  ok(got.length === 2 && got[0] === 'tpexCompanies：來源 0 筆' && reasonsOf('twseCompanies：用快取').length === 0
    && reasonsOf('  · tpexCompanies：來源 0 筆（沒有「不寫檔：」開頭，只是別處印的一行）').length === 0,
    '（對照）擷取擋下理由的程式：只取「不寫檔：」後面的問題清單，進度輸出裡的同名字、別處印的同一行都不算', JSON.stringify(got));
  const wf = reasonsOf('✗ 寫檔失敗：輸出維持上一次成功的內容\n  · 輸出檔（x.json）：換不上去（EPERM）');
  ok(wf.length === 1 && wf[0].startsWith('輸出檔（x.json）：'), '（對照）擷取擋下理由的程式：「寫檔失敗：」後面的清單也抓得到', JSON.stringify(wf));
  ok(hasWord('twseCompanies：來源 0 筆', '0 筆') && !hasWord('twseCompanies：來源 10 筆', '0 筆') && hasWord('上櫃：檔數少了一半以上', '少了一半以上'),
    '（對照）狀況字眼對邊界：「0 筆」抓得到，「10 筆」湊不到');
  ok(hasStack('Error: x\n    at main (file:///a/b.mjs:12:5)\n    at run (node:internal/x:3:1)') && !hasStack('✗ 寫檔失敗：…\n  · 輸出檔（x.json）：換不上去（EPERM）'),
    '（對照）堆疊的判斷：有「    at …:行:欄」就算吐了堆疊，設計好的訊息不算');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dirhash-'));
  fs.writeFileSync(path.join(d, 'a.json'), '1');
  const h0 = dirHash(d);
  fs.writeFileSync(path.join(d, 'a.json.tmp-1'), '');
  const h1 = dirHash(d);
  fs.rmSync(path.join(d, 'a.json.tmp-1'));
  fs.writeFileSync(path.join(d, 'a.json'), '2');
  const h2 = dirHash(d);
  fs.writeFileSync(path.join(d, 'a.json'), '1');
  ok(h0 !== h1 && h0 !== h2 && dirHash(d) === h0, '（對照）目錄雜湊：多一個暫存檔、改一個字都會變，改回原樣就相同');
  // 2026-09-25（補充說明（十一）第 3 點：每個分支都要有自己的樣本）——子目錄那個分支以前沒有樣本
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'b.json'), '1');
  const h3 = dirHash(d);
  fs.writeFileSync(path.join(d, 'sub', 'b.json'), '2');
  ok(dirHash(d) !== h3, '（對照）目錄雜湊：子目錄裡改一個字也會變');
  fs.rmSync(d, { recursive: true, force: true });
  // 模組頂層崩掉時，堆疊那一行不帶括號（`    at file:///…:行:欄`）——以前樣本只有帶括號的
  ok(hasStack('TypeError: x\n    at file:///a/b.mjs:3:7'), '（對照）堆疊的判斷：不帶括號的那一種（模組頂層崩掉）也算吐了堆疊');
}

const run = (script, args, env = {}) => {
  const before = dirHash(DATA);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(W, 'scripts', 'testfetch.mjs')).href,
    path.join(W, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, changed: dirHash(DATA) !== before };
};
/**
 * 一格：回傳非 0、理由點名單位與狀況（落在錯誤訊息位置）、data/ 雜湊不變、沒有吐堆疊。label 是固定標籤。
 * 另外照 MealMate 的形狀分三類記下來：擋（全部成立）／碰巧擋下（回非 0、輸出沒變，但理由沒點名這個單位、或吐了堆疊）／沒擋。
 */
const tally = { 擋: 0, 碰巧擋下: 0, 沒擋: 0 };
const notBlocked = [];
function cell(label, r, unit, kind, { allowChanged = false } = {}) {
  const reasons = reasonsOf(r.out);
  const hit = reasons.some((x) => x.startsWith(`${unit}：`) && kind.some((k) => hasWord(x, k)));
  const stack = hasStack(r.out);
  const kept = allowChanged || !r.changed;
  const verdict = r.code !== 0 && kept ? (hit && !stack ? '擋' : '碰巧擋下') : '沒擋';
  tally[verdict] += 1;
  if (verdict !== '擋') notBlocked.push(`${verdict}：${label}`);
  ok(verdict === '擋', label,
    `回傳 ${r.code}；data/ ${r.changed ? '變了' : '沒變'}；${stack ? '吐了堆疊；' : ''}要有以「${unit}：」開頭、含「${kind.join('／')}」的理由；實際理由：${JSON.stringify(reasons).slice(0, 300)}；輸出末段：${r.out.slice(-200)}`);
}
function writes(label, r) {
  ok(r.code === 0 && r.changed, label, `回傳 ${r.code}；data/ ${r.changed ? '變了' : '沒變'}；輸出末段：${r.out.slice(-300)}`);
}
const snapshot = new Map();
for (const f of fs.readdirSync(DATA)) snapshot.set(f, fs.readFileSync(path.join(DATA, f)));
const restoreData = () => {
  for (const f of fs.readdirSync(DATA)) if (!snapshot.has(f)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
  // 寫檔失敗的格子會把輸出檔換成資料夾：先整個拿掉再寫回
  for (const [f, b] of snapshot) {
    try { fs.chmodSync(path.join(DATA, f), 0o666); } catch { /* 檔案不在就沒有權限可改；下一行照樣整個拿掉再寫回 */ }
    fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
    fs.writeFileSync(path.join(DATA, f), b);
  }
};
// ---- 母體：每一個單位 × 每一種情境（F8 四家統一驗法）----
// 每一格的標籤**逐字寫在這裡**：它就是母體清單，也讓突變的 expect 對得到「剛好那一格」（樣板字串對不到）。
// 下面有一條前置斷言：這張表＝單位 × 情境，多一格、少一格都會紅。
const KINDS = ['empty', 'missing', 'renamed', 'unparsable'];
const MATRIX = {
  'build-calendar': {
    '休市日公告（holidaySchedule）': {
      empty: 'build-calendar 矩陣：holidaySchedule × empty',
      missing: 'build-calendar 矩陣：holidaySchedule × missing',
      renamed: 'build-calendar 矩陣：holidaySchedule × renamed',
      unparsable: 'build-calendar 矩陣：holidaySchedule × unparsable',
      shrink: 'build-calendar 矩陣：holidaySchedule × shrink',
    },
  },
  'build-dividends': {
    '股利分派情形（t187ap45_L）': {
      empty: 'build-dividends 矩陣：t187ap45_L × empty',
      missing: 'build-dividends 矩陣：t187ap45_L × missing',
      renamed: 'build-dividends 矩陣：t187ap45_L × renamed',
      unparsable: 'build-dividends 矩陣：t187ap45_L × unparsable',
      shrink: 'build-dividends 矩陣：t187ap45_L × shrink',
    },
  },
  'build-stocks': {
    twseCompanies: {
      empty: 'build-stocks 矩陣：twseCompanies × empty',
      missing: 'build-stocks 矩陣：twseCompanies × missing',
      renamed: 'build-stocks 矩陣：twseCompanies × renamed',
      unparsable: 'build-stocks 矩陣：twseCompanies × unparsable',
    },
    tpexCompanies: {
      empty: 'build-stocks 矩陣：tpexCompanies × empty',
      missing: 'build-stocks 矩陣：tpexCompanies × missing',
      renamed: 'build-stocks 矩陣：tpexCompanies × renamed',
      unparsable: 'build-stocks 矩陣：tpexCompanies × unparsable',
    },
    stockDayAll: {
      empty: 'build-stocks 矩陣：stockDayAll × empty',
      missing: 'build-stocks 矩陣：stockDayAll × missing',
      renamed: 'build-stocks 矩陣：stockDayAll × renamed',
      unparsable: 'build-stocks 矩陣：stockDayAll × unparsable',
    },
    isinListed: {
      empty: 'build-stocks 矩陣：isinListed × empty',
      missing: 'build-stocks 矩陣：isinListed × missing',
      renamed: 'build-stocks 矩陣：isinListed × renamed',
      unparsable: 'build-stocks 矩陣：isinListed × unparsable',
    },
    isinOtc: {
      empty: 'build-stocks 矩陣：isinOtc × empty',
      missing: 'build-stocks 矩陣：isinOtc × missing',
      renamed: 'build-stocks 矩陣：isinOtc × renamed',
      unparsable: 'build-stocks 矩陣：isinOtc × unparsable',
    },
    isinEmerging: {
      empty: 'build-stocks 矩陣：isinEmerging × empty',
      missing: 'build-stocks 矩陣：isinEmerging × missing',
      renamed: 'build-stocks 矩陣：isinEmerging × renamed',
      unparsable: 'build-stocks 矩陣：isinEmerging × unparsable',
    },
    上市: { shrink: 'build-stocks 矩陣：上市 × shrink' },
    上櫃: { shrink: 'build-stocks 矩陣：上櫃 × shrink' },
    興櫃: { shrink: 'build-stocks 矩陣：興櫃 × shrink' },
  },
};
// 另一個單位：上一次成功的輸出檔。三支各一格——壞掉時不能當成「第一次產」而跳過「變少」的比對
// 寫檔那一步出事（補充說明（四）第 5 點），三支各三格
const WRITEFAIL = {
  'build-calendar': {
    tmpDir: 'build-calendar 寫檔失敗：暫存檔的位置被資料夾佔住',
    readonly: 'build-calendar 寫檔失敗：輸出檔換不上去',
    cleanup: 'build-calendar 寫檔失敗：清理也失敗',
  },
  'build-dividends': {
    tmpDir: 'build-dividends 寫檔失敗：暫存檔的位置被資料夾佔住',
    readonly: 'build-dividends 寫檔失敗：輸出檔換不上去',
    cleanup: 'build-dividends 寫檔失敗：清理也失敗',
  },
  'build-stocks': {
    tmpDir: 'build-stocks 寫檔失敗：暫存檔的位置被資料夾佔住',
    readonly: 'build-stocks 寫檔失敗：輸出檔換不上去',
    cleanup: 'build-stocks 寫檔失敗：清理也失敗',
  },
};
const CORRUPT = {
  'build-calendar': 'build-calendar 上一次的輸出壞掉：要擋、點名它',
  'build-dividends': 'build-dividends 上一次的輸出壞掉：要擋、點名它',
  'build-stocks': 'build-stocks 上一次的輸出壞掉：要擋、點名它',
};

// 情境的關鍵字（理由裡要有其中一個）
const K = {
  empty: ['0 筆', '0 列', '0 檔'],
  missing: ['取不到'],
  renamed: ['欄位對不上'],
  unparsable: ['解析不了'],
  shrink: ['少了一半以上'],
};
// ISIN 表是 HTML：「欄位對不上」「解析不了」都只會表現成解析出 0 列（它沒有別的訊號）；STOCK_DAY_ALL 的標題改名是解析器拋錯
const kindWords = (unit, kind) => {
  if (unit.startsWith('isin') && (kind === 'renamed' || kind === 'unparsable')) return ['0 列'];
  if (unit === 'stockDayAll' && kind === 'renamed') return K.unparsable;
  return K[kind];
};

section('（前提）母體：矩陣＝每一個單位 × 每一種情境');
{
  const src = fs.readFileSync(path.join(REPO, 'scripts/build-stocks.mjs'), 'utf8');
  const declared = [...src.slice(src.indexOf('const SOURCES = {'), src.indexOf('};', src.indexOf('const SOURCES = {'))).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  const stockSources = Object.keys(MATRIX['build-stocks']).filter((u) => !['上市', '上櫃', '興櫃'].includes(u));
  eq(stockSources, declared, '（前提）build-stocks 的來源單位＝腳本裡的 SOURCES（多一份、少一份都會紅）');
  const shape = [];
  for (const [script, units] of Object.entries(MATRIX)) {
    for (const [unit, cells] of Object.entries(units)) {
      const want = ['上市', '上櫃', '興櫃'].includes(unit) ? ['shrink'] : (script === 'build-stocks' ? KINDS : [...KINDS, 'shrink']);
      if (Object.keys(cells).join() !== want.join()) shape.push(`${script}／${unit}：${Object.keys(cells).join()}（要 ${want.join()}）`);
    }
  }
  eq(shape, [], '（前提）每一個單位都有全部的情境（一格都不挑掉）');
  eq(Object.keys(CORRUPT), Object.keys(MATRIX), '（前提）「上一次的輸出壞掉」三支各一格');
  eq(Object.entries(WRITEFAIL).map(([k, v]) => `${k}:${Object.keys(v).join()}`), Object.keys(MATRIX).map((k) => `${k}:tmpDir,readonly,cleanup`), '（前提）「寫檔失敗」三支各三格');
}

try {
  // ======================= build-calendar =======================
  section('build-calendar（--from 本機檔、--year 2026；錄好的 holiday-schedule-115.json）');
  const hol = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/holiday-schedule-115.json'), 'utf8'));
  ok(hol.length > 20, `（前提）錄好的休市日公告有 ${hol.length} 筆`);
  const cal = (file, year = '2026') => { restoreData(); return run('build-calendar.mjs', ['--year', year, '--from', file]); };
  writes('build-calendar 對照：錄好的原樣要寫檔', cal(put('hol-ok.json', hol)));
  const CAL = {
    empty: () => cal(put('hol-empty.json', [])),
    missing: () => cal(path.join(IN, 'no-such.json')),
    renamed: () => cal(put('hol-renamed.json', hol.map(({ Date: d, ...rest }) => ({ ...rest, 日期: d })))),
    unparsable: () => cal(put('hol-bad.json', '{ 不是 JSON')),
    shrink: () => cal(put('hol-5pct.json', hol.slice(0, 1))),
  };
  for (const [unit, cells] of Object.entries(MATRIX['build-calendar'])) {
    for (const [kind, label] of Object.entries(cells)) cell(label, CAL[kind](), unit, kindWords(unit, kind));
  }
  cell('build-calendar 沒有這一年：2027 要擋', cal(put('hol-2027.json', hol), '2027'), '休市日公告（holidaySchedule）', ['沒有這一年']);
  cell('build-calendar 新的一年變少：2027 只有 1 天平日休市要擋',
    cal(put('hol-2027-thin.json', [{ Name: '中華民國開國紀念日', Date: '1160101', Weekday: '五', Description: '依規定放假1日。' }]), '2027'),
    '休市日公告（holidaySchedule）', K.shrink);

  // ======================= build-dividends =======================
  section('build-dividends（fetch 換成送合成回應；檔數跟上一次成功的一樣多）');
  const prevCodes = Object.keys(JSON.parse(snapshot.get('dividends.json')).codes);
  ok(prevCodes.length > 100, `（前提）上一次成功的 dividends.json 有 ${prevCodes.length} 檔`);
  const divRow = (code) => ({
    出表日期: '1150924', 公司代號: code, 股利年度: '114', '股利所屬年(季)度': '114年年度', 股利所屬期間: '1140101~1141231',
    '股東配發-盈餘分配之現金股利(元/股)': '1.5', '股東配發-法定盈餘公積發放之現金(元/股)': '0', '股東配發-資本公積發放之現金(元/股)': '0',
    '股東配發-盈餘轉增資配股(元/股)': '0', '股東配發-法定盈餘公積轉增資配股(元/股)': '0', '股東配發-資本公積轉增資配股(元/股)': '0',
    '決議（擬議）進度': '股東會決議',
  });
  const rowsAll = prevCodes.map(divRow);
  let n = 0;
  const div = (body, env = {}) => { restoreData(); n += 1; return run('build-dividends.mjs', [], { TESTFETCH_BODY: put(`div-${n}.json`, body), ...env }); };
  writes('build-dividends 對照：跟上一次一樣多的合成資料要寫檔', div(rowsAll));
  const DIV = {
    empty: () => div([]),
    missing: () => div(rowsAll, { TESTFETCH_STATUS: '500' }),
    renamed: () => div(rowsAll.map(({ 公司代號: c, ...r }) => ({ ...r, 代號: c }))),
    unparsable: () => div('{ 不是 JSON'),
    shrink: () => div(rowsAll.slice(0, Math.ceil(rowsAll.length * 0.05))),
  };
  for (const [unit, cells] of Object.entries(MATRIX['build-dividends'])) {
    for (const [kind, label] of Object.entries(cells)) cell(label, DIV[kind](), unit, kindWords(unit, kind));
  }
  cell('build-dividends 欄位對不上：只有後面幾筆改名也要擋', div(rowsAll.map((r, i) => (i < 5 ? r : (({ 股利年度: y, ...rest }) => ({ ...rest, 年度: y }))(r)))), '股利分派情形（t187ap45_L）', K.renamed);
  cell('build-dividends 收進來 0 檔：代號全不合格式要擋', div(rowsAll.map((r) => ({ ...r, 公司代號: 'X' }))), '股利分派情形（t187ap45_L）', ['收進來 0 檔']);
  cell('build-dividends 收進來 0 檔：現金股利全空要擋', div(rowsAll.map((r) => ({ ...r, '股東配發-盈餘分配之現金股利(元/股)': '' }))), '股利分派情形（t187ap45_L）', ['收進來 0 檔']);

  // ======================= build-stocks =======================
  section('build-stocks（--cache 放合成的來源；任何網路請求都直接失敗）');
  const SOURCES = Object.keys(MATRIX['build-stocks']).filter((u) => !['上市', '上櫃', '興櫃'].includes(u));
  const ind = Array.from({ length: 25 }, (_, i) => ({ code: String(1101 + i), ic: String(i + 1).padStart(2, '0'), name: `IND${i + 1}` }));
  const tr = (cs) => `<tr>${cs.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const isin = (rows) => `<table>${tr(['STOCK'])}${rows.map((r) => tr([`${r[0]} ${r[1]}`, 'TW000', '2000/01/01', '', r[2], 'ESVUFR'])).join('')}${tr(['ETF'])}${tr(['0050 ETF50', 'TW000', '2003/06/30', '', '', 'CEOGEU'])}</table>`;
  const sdaText = fs.readFileSync(path.join(REPO, 'scripts/fixtures/stock-day-all.csv'), 'utf8');
  const good = {
    twseCompanies: JSON.stringify([...ind.map((x) => ({ 公司代號: x.code, 產業別: x.ic })), { 公司代號: '2330', 產業別: '24' }]),
    tpexCompanies: JSON.stringify([{ SecuritiesCompanyCode: '6488', SecuritiesIndustryCode: '24' }]),
    stockDayAll: sdaText,
    isinListed: isin([...ind.map((x) => [x.code, `C${x.code}`, x.name]), ['2330', 'TSMC', 'IND24']]),
    isinOtc: `<table>${tr(['STOCK'])}${tr(['6488 GW', 'TW000', '2000/01/01', '', 'IND24', 'ESVUFR'])}</table>`,
    isinEmerging: `<table>${tr(['STOCK'])}${tr(['7777 EMG', 'TW000', '2020/01/01', '', '', 'ESVUFR'])}</table>`,
  };
  const BAD = {
    twseCompanies: { empty: '[]', renamed: JSON.stringify([{ 代號: '1101', 產業別: '01' }]), unparsable: 'not json' },
    tpexCompanies: { empty: '[]', renamed: JSON.stringify([{ Code: '6488', SecuritiesIndustryCode: '24' }]), unparsable: 'not json' },
    stockDayAll: { empty: `${sdaText.split('\n')[0]}\n`, renamed: sdaText.split('證券代號').join('代號'), unparsable: 'not a csv' },
    isinListed: { empty: '<table></table>', renamed: '<table><tr><td>a</td><td>b</td></tr></table>', unparsable: 'not html' },
    isinOtc: { empty: '<table></table>', renamed: '<table><tr><td>a</td><td>b</td></tr></table>', unparsable: 'not html' },
    isinEmerging: { empty: '<table></table>', renamed: '<table><tr><td>a</td><td>b</td></tr></table>', unparsable: 'not html' },
  };
  const PREV_OK = { 上市: 44, 上櫃: 1, 興櫃: 1 };
  let k = 0;
  const stk = (override = {}, prev = JSON.stringify({ counts: { byMarket: PREV_OK }, stocks: {} })) => {
    restoreData();
    k += 1;
    const dir = path.join(IN, `stk-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SOURCES) {
      const v = name in override ? override[name] : good[name];
      if (v !== null) fs.writeFileSync(path.join(dir, `${name}.bin`), v);
    }
    fs.writeFileSync(path.join(DATA, 'stocks.json'), prev);
    return run('build-stocks.mjs', ['--cache', dir]);
  };
  const ctl = stk();
  writes('build-stocks 對照：合成的六份來源要寫檔', ctl);
  eq(ctl.code === 0 ? JSON.parse(fs.readFileSync(path.join(DATA, 'stocks.json'), 'utf8')).counts.byMarket : {}, PREV_OK,
    '（前提）對照產出的各市場檔數＝合成的「上一次成功」（下面的「變少」才是只少那一個市場）');
  for (const [unit, cells] of Object.entries(MATRIX['build-stocks'])) {
    for (const [kind, label] of Object.entries(cells)) {
      const r = kind === 'shrink'
        ? stk({}, JSON.stringify({ counts: { byMarket: { ...PREV_OK, [unit]: PREV_OK[unit] * 3 } }, stocks: {} }))
        : stk({ [unit]: kind === 'missing' ? null : BAD[unit][kind] });
      cell(label, r, unit, kindWords(unit, kind));
    }
  }

  // ======================= 上一次的輸出壞掉（三支各一格）=======================
  section('上一次成功的輸出檔壞掉：三支都要停、點名它，不能當成第一次產');
  const corruptRun = {
    'build-calendar': () => { restoreData(); fs.writeFileSync(path.join(DATA, 'calendar.json'), '{ 壞掉的'); return run('build-calendar.mjs', ['--year', '2026', '--from', put('hol-ok2.json', hol)]); },
    'build-dividends': () => { restoreData(); fs.writeFileSync(path.join(DATA, 'dividends.json'), '{ 壞掉的'); return run('build-dividends.mjs', [], { TESTFETCH_BODY: put('div-c.json', rowsAll) }); },
    'build-stocks': () => stk({}, '{ 壞掉的'),
  };
  const OUT_NAME = { 'build-calendar': 'calendar.json', 'build-dividends': 'dividends.json', 'build-stocks': 'stocks.json' };
  for (const [script, label] of Object.entries(CORRUPT)) cell(label, corruptRun[script](), `上一次的輸出（${OUT_NAME[script]}）`, K.unparsable);

  // ======================= 寫檔失敗（三支 × 三種；補充說明（四）第 5 點）=======================
  // 輸入都是正常的（寫檔前關卡會過），只有寫檔那一步出事：
  //   tmpDir   暫存檔的位置（<輸出檔>.tmp）先放一個同名資料夾 → 寫不進去；那個資料夾不能被動到
  //   readonly 輸出檔設成唯讀 → 暫存檔寫好了卻換不上去（Windows 上 EPERM）；要清掉自己寫出的暫存檔
  //   cleanup  換不上去，而且清理也失敗（預載模組讓刪 .tmp 丟 EPERM）→ 要點名留下的暫存檔、不中斷、不吐堆疊
  section('寫檔失敗：三支 × 三種（暫存檔的位置被佔住、換不上去、清理也失敗）');
  const valid = {
    'build-calendar': (env) => run('build-calendar.mjs', ['--year', '2026', '--from', put('hol-ok3.json', hol)], env),
    'build-dividends': (env) => run('build-dividends.mjs', [], { TESTFETCH_BODY: put('div-ok3.json', rowsAll), ...env }),
    'build-stocks': (env) => {
      const dir = path.join(IN, 'stk-write');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const name of SOURCES) fs.writeFileSync(path.join(dir, `${name}.bin`), good[name]);
      return run('build-stocks.mjs', ['--cache', dir], env);
    },
  };
  const prepStocksPrev = () => fs.writeFileSync(path.join(DATA, 'stocks.json'), JSON.stringify({ counts: { byMarket: PREV_OK }, stocks: {} }));
  for (const [script, labels] of Object.entries(WRITEFAIL)) {
    const out = path.join(DATA, OUT_NAME[script]);
    const unit = `輸出檔（${OUT_NAME[script]}）`;
    // tmpDir
    restoreData(); if (script === 'build-stocks') prepStocksPrev();
    fs.mkdirSync(`${out}.tmp`); fs.writeFileSync(path.join(`${out}.tmp`, '別人的檔.txt'), '不能被刪');
    const a = valid[script]({});
    cell(labels.tmpDir, a, unit, ['暫存檔寫不進去']);
    ok(fs.existsSync(path.join(`${out}.tmp`, '別人的檔.txt')), `${labels.tmpDir}（佔位的資料夾與裡面的檔都還在）`);
    // readonly
    restoreData(); if (script === 'build-stocks') prepStocksPrev();
    fs.chmodSync(out, 0o444);
    const b = valid[script]({});
    cell(labels.readonly, b, unit, ['換不上去']);
    ok(reasonsOf(b.out).some((x) => x.startsWith(`${unit}：已清掉這次寫出的暫存檔`)) && !fs.existsSync(`${out}.tmp`),
      `${labels.readonly}（清掉了自己寫出的暫存檔，而且講出來）`, JSON.stringify(reasonsOf(b.out)));
    // cleanup：暫存檔會留下（這一格 data/ 本來就會多一個檔），其他三件照樣要成立，而且要點名留下的檔
    restoreData(); if (script === 'build-stocks') prepStocksPrev();
    fs.chmodSync(out, 0o444);
    const outBefore = fs.readFileSync(out);
    const c = valid[script]({ TESTFS_RM_FAIL: '1' });
    cell(labels.cleanup, c, unit, ['清理也失敗'], { allowChanged: true });
    ok(fs.readFileSync(out).equals(outBefore) && fs.existsSync(`${out}.tmp`) && reasonsOf(c.out).some((x) => x.includes(`${path.basename(out)}.tmp 刪不掉`)),
      `${labels.cleanup}（輸出檔沒被蓋掉；留下的暫存檔有點名）`, JSON.stringify(reasonsOf(c.out)));
  }
  restoreData();

  section('總計（照 MealMate 的形狀：擋／碰巧擋下／沒擋）');
  note(`矩陣共 ${tally.擋 + tally.碰巧擋下 + tally.沒擋} 格：擋 ${tally.擋}、碰巧擋下 ${tally.碰巧擋下}、沒擋 ${tally.沒擋}`);
  for (const x of notBlocked) note(`  ${x}`);
} finally {
  fs.rmSync(W, { recursive: true, force: true });
}

done('buildtest');
