// 三支 build 的寫檔前關卡（npm run buildtest；在 npm test 鏈裡）。
//
// 為什麼（STATUS「S8：三支 build 的盤點」）：資料變少時三支都照樣寫檔，build-dividends 會寫出「0 檔」的輸出。
// 修法在 scripts/buildguard.mjs：動手寫檔之前先確認每一份來源、每一組都有、不是空的、欄位對得上、
// 沒有比上一次成功的少一半以上；有任何一項不過就全部停、一個檔都不寫。
//
// 怎麼測：在暫存目錄放一份 scripts／js／data 的複本，從**真實入口**（node scripts/build-*.mjs）跑，
// fetch 換成 scripts/testfetch.mjs（不打網路）。每一種情境都看四件事：
//   · 回傳值
//   · **擋下的理由落在錯誤訊息的位置**：「不寫檔：」後面那串「  · 」問題清單裡有那一條——只數「有沒有出現」
//     會誤判（進度輸出裡也可能出現同一個名字，例如「twseCompanies：用快取」）
//   · 輸出檔的雜湊沒變（一個檔都沒寫）
//   · data/ 裡沒有留下暫存檔
// 母體涵蓋**每一支、每一份來源**（build-stocks 的六份逐一造空的、逐一拿掉），不挑一支代表。
// 每一支都先跑對照：正常的輸入要寫檔、回 0（不然「什麼都擋」的關卡也會讓下面全過）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtest-'));
const SCRIPTS = ['build-calendar.mjs', 'build-dividends.mjs', 'build-stocks.mjs', 'buildguard.mjs', 'testfetch.mjs'];
fs.mkdirSync(path.join(W, 'scripts'));
for (const f of SCRIPTS) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(W, 'scripts', f));
fs.cpSync(path.join(REPO, 'js'), path.join(W, 'js'), { recursive: true });
fs.cpSync(path.join(REPO, 'data'), path.join(W, 'data'), { recursive: true });
const IN = path.join(W, 'in');
fs.mkdirSync(IN);

const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : null);
const put = (name, data) => { const f = path.join(IN, name); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };
const leftovers = () => fs.readdirSync(path.join(W, 'data')).filter((f) => /\.tmp-/.test(f));
/** 「不寫檔：」後面那串問題清單（只取「  · 」開頭的行）。擋下的理由必須落在這裡。 */
const reasonsOf = (out) => {
  const i = out.indexOf('不寫檔：');
  if (i < 0) return [];
  return out.slice(i).split('\n').filter((l) => l.startsWith('  · ')).map((l) => l.slice(4));
};
// 擷取理由的程式本身的對照（§5.11 第二層）：已知的輸出要抓到該抓的，進度輸出裡的同名字不能算
{
  const sample = '  twseCompanies：用快取（1 KB）\nError: build-stocks 不寫檔：寫檔前的檢查沒過\n  · tpexCompanies：來源 0 筆\n  · 上櫃的檔數：少了一半以上\n    at main';
  const got = reasonsOf(sample);
  ok(got.length === 2 && got[0] === 'tpexCompanies：來源 0 筆' && !got.some((r) => r.includes('用快取')) && reasonsOf('twseCompanies：用快取').length === 0,
    '（對照）擷取擋下理由的程式：只取「不寫檔：」後面的問題清單，進度輸出裡的同名字不算', JSON.stringify(got));
}

function run(script, args, { env = {}, outFile }) {
  const target = path.join(W, 'data', outFile);
  const before = sha(target);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(W, 'scripts', 'testfetch.mjs')).href,
    path.join(W, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, changed: sha(target) !== before, leftovers: leftovers() };
}
/** 一種會擋的情境：回傳非 0、理由落在錯誤訊息裡、輸出檔沒變、沒有暫存檔。label 是固定標籤（突變的 expect 用）。 */
function blocks(label, r, reason) {
  const reasons = reasonsOf(r.out);
  const hit = reason ? reasons.some((x) => x.startsWith(reason)) : true;
  ok(r.code !== 0 && hit && !r.changed && r.leftovers.length === 0, label,
    `回傳 ${r.code}；輸出檔${r.changed ? '被改寫了' : '沒變'}；暫存檔 ${r.leftovers.length} 個；要有以「${reason}」開頭的理由，實際理由：${JSON.stringify(reasons).slice(0, 300)}；輸出末段：${r.out.slice(-200)}`);
}
/** 對照（正常輸入）：回 0、寫了檔、沒有暫存檔。 */
function writes(label, r) {
  ok(r.code === 0 && r.changed && r.leftovers.length === 0, label, `回傳 ${r.code}；輸出檔${r.changed ? '改寫了' : '沒變'}；輸出末段：${r.out.slice(-300)}`);
}
const snapshot = {};
for (const f of ['calendar.json', 'dividends.json', 'stocks.json']) snapshot[f] = fs.readFileSync(path.join(W, 'data', f));
const restore = (f) => fs.writeFileSync(path.join(W, 'data', f), snapshot[f]);

try {
  // ======================= build-calendar =======================
  section('build-calendar（--from 本機檔、--year 2026；錄好的 holiday-schedule-115.json）');
  const hol = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/holiday-schedule-115.json'), 'utf8'));
  const cal = (label, input, want, year = '2026') => {
    restore('calendar.json');
    const r = run('build-calendar.mjs', ['--year', year, '--from', typeof input === 'string' && input.startsWith('@') ? path.join(IN, input.slice(1)) : put(`${label}.json`, input)], { outFile: 'calendar.json' });
    return r;
  };
  ok(hol.length > 20, `（前提）錄好的休市日公告有 ${hol.length} 筆`);
  writes('build-calendar 對照：錄好的原樣要寫檔', cal('ok', hol));
  blocks('build-calendar 空的：0 筆要擋', cal('empty', []), '休市日公告（holidaySchedule）：來源 0 筆');
  blocks('build-calendar 不是陣列：要擋', cal('obj', {}), '休市日公告（holidaySchedule）：來源不是陣列');
  blocks('build-calendar 缺檔：要擋', cal('missing', '@no-such.json'), null);
  blocks('build-calendar 欄位對不上：Date 改名要擋', cal('renamed', hol.map(({ Date: d, ...rest }) => ({ ...rest, 日期: d }))), '休市日公告（holidaySchedule）：欄位對不上');
  blocks('build-calendar 資料變少：只給 5% 要擋', cal('5pct', hol.slice(0, 1)), '2026 年的平日休市天數');
  blocks('build-calendar 沒有這一年：2027 要擋', cal('2027', hol, null, '2027'), '2027 年：公告裡沒有這一年');
  // 新的一年沒有同年的舊資料：拿最近一年（2026）來比。合成的 2027 公告只有元旦 1 天
  blocks('build-calendar 新的一年變少：2027 只有 1 天平日休市要擋', cal('2027-thin', [{ Name: '中華民國開國紀念日', Date: '1160101', Weekday: '五', Description: '依規定放假1日。' }], null, '2027'), '2027 年的平日休市天數（對照 2026 年');
  restore('calendar.json');

  // ======================= build-dividends =======================
  section('build-dividends（fetch 換成送合成回應；檔數跟上一次成功的一樣多）');
  const prevCodes = Object.keys(JSON.parse(snapshot['dividends.json']).codes);
  ok(prevCodes.length > 100, `（前提）上一次成功的 dividends.json 有 ${prevCodes.length} 檔`);
  const divRow = (code) => ({
    出表日期: '1150924', 公司代號: code, 股利年度: '114', '股利所屬年(季)度': '114年年度', 股利所屬期間: '1140101~1141231',
    '股東配發-盈餘分配之現金股利(元/股)': '1.5', '股東配發-法定盈餘公積發放之現金(元/股)': '0', '股東配發-資本公積發放之現金(元/股)': '0',
    '股東配發-盈餘轉增資配股(元/股)': '0', '股東配發-法定盈餘公積轉增資配股(元/股)': '0', '股東配發-資本公積轉增資配股(元/股)': '0',
    '決議（擬議）進度': '股東會決議',
  });
  const rowsAll = prevCodes.map(divRow);
  const div = (label, body, status) => {
    restore('dividends.json');
    return run('build-dividends.mjs', [], { outFile: 'dividends.json', env: { TESTFETCH_BODY: put(`div-${label}.json`, body), ...(status ? { TESTFETCH_STATUS: status } : {}) } });
  };
  writes('build-dividends 對照：跟上一次一樣多的合成資料要寫檔', div('ok', rowsAll));
  blocks('build-dividends 空的：0 筆要擋', div('empty', []), '股利分派情形（t187ap45_L）：來源 0 筆');
  blocks('build-dividends 不是陣列：要擋', div('obj', {}), '股利分派情形（t187ap45_L）：來源不是陣列');
  blocks('build-dividends 取不到：來源回 500 要擋', div('500', rowsAll, '500'), null);
  blocks('build-dividends 欄位對不上：第一筆就改名要擋', div('renamed', rowsAll.map(({ 公司代號: c, ...r }) => ({ ...r, 代號: c }))), '股利分派情形（t187ap45_L）：欄位對不上');
  blocks('build-dividends 欄位對不上：只有後面幾筆改名也要擋', div('renamed-late', rowsAll.map((r, i) => (i < 5 ? r : (({ 股利年度: y, ...rest }) => ({ ...rest, 年度: y }))(r)))), '股利分派情形（t187ap45_L）：欄位對不上');
  blocks('build-dividends 收進來 0 檔：代號全不合格式要擋', div('badcode', rowsAll.map((r) => ({ ...r, 公司代號: 'X' }))), '股利分派情形（t187ap45_L）：收進來 0 檔');
  blocks('build-dividends 收進來 0 檔：現金股利全空要擋', div('nocash', rowsAll.map((r) => ({ ...r, '股東配發-盈餘分配之現金股利(元/股)': '' }))), '股利分派情形（t187ap45_L）：收進來 0 檔');
  blocks('build-dividends 資料變少：只給 5% 要擋', div('5pct', rowsAll.slice(0, Math.ceil(rowsAll.length * 0.05))), '股利分派情形（t187ap45_L）收進來的檔數');
  // 上一次的輸出壞掉：不能當成「第一次產」而跳過比對
  fs.writeFileSync(path.join(W, 'data', 'dividends.json'), '{ 壞掉的');
  const corrupt = run('build-dividends.mjs', [], { outFile: 'dividends.json', env: { TESTFETCH_BODY: put('div-corrupt.json', rowsAll.slice(0, 3)) } });
  ok(corrupt.code !== 0 && !corrupt.changed && /JSON/.test(corrupt.out), 'build-dividends 上一次的輸出壞掉：要擋、不能當成第一次產', `回傳 ${corrupt.code}；輸出檔${corrupt.changed ? '被改寫了' : '沒變'}；${corrupt.out.slice(-200)}`);
  restore('dividends.json');

  // ======================= build-stocks =======================
  section('build-stocks（--cache 放合成的六份來源；任何網路請求都直接失敗）');
  const SOURCES = ['twseCompanies', 'tpexCompanies', 'stockDayAll', 'isinListed', 'isinOtc', 'isinEmerging'];
  const src = fs.readFileSync(path.join(REPO, 'scripts/build-stocks.mjs'), 'utf8');
  const declared = [...src.slice(src.indexOf('const SOURCES = {'), src.indexOf('};', src.indexOf('const SOURCES = {'))).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  eq(declared, SOURCES, '（前提）這裡逐一測的六份來源＝build-stocks 的 SOURCES（多一份、少一份都會紅）');
  // 合成的來源：25 個產業別（上市 1101–1125）＋2330、上櫃 6488、興櫃 7777、ETF 0050；ISIN 表用 ASCII（Big5 解碼後不變）
  const ind = Array.from({ length: 25 }, (_, i) => ({ code: String(1101 + i), ic: String(i + 1).padStart(2, '0'), name: `IND${i + 1}` }));
  const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const isin = (rows) => `<table>${tr(['STOCK'])}${rows.map((r) => tr([`${r[0]} ${r[1]}`, 'TW000', '2000/01/01', '', r[2], 'ESVUFR'])).join('')}${tr(['ETF'])}${tr(['0050 ETF50', 'TW000', '2003/06/30', '', '', 'CEOGEU'])}</table>`;
  const good = {
    twseCompanies: JSON.stringify([...ind.map((x) => ({ 公司代號: x.code, 產業別: x.ic })), { 公司代號: '2330', 產業別: '24' }]),
    tpexCompanies: JSON.stringify([{ SecuritiesCompanyCode: '6488', SecuritiesIndustryCode: '24' }]),
    stockDayAll: fs.readFileSync(path.join(REPO, 'scripts/fixtures/stock-day-all.csv'), 'utf8'),
    isinListed: isin([...ind.map((x) => [x.code, `C${x.code}`, x.name]), ['2330', 'TSMC', 'IND24']]),
    isinOtc: `<table>${tr(['STOCK'])}${tr(['6488 GW', 'TW000', '2000/01/01', '', 'IND24', 'ESVUFR'])}</table>`,
    isinEmerging: `<table>${tr(['STOCK'])}${tr(['7777 EMG', 'TW000', '2020/01/01', '', '', 'ESVUFR'])}</table>`,
  };
  const empty = { twseCompanies: '[]', tpexCompanies: '[]', stockDayAll: '', isinListed: '<table></table>', isinOtc: '<table></table>', isinEmerging: '<table></table>' };
  // 「上一次成功的」也是合成的：跟上面這份來源產出來的一樣多（上市 44、上櫃 1、興櫃 1）
  const prevStocks = (byMarket) => JSON.stringify({ counts: { byMarket }, stocks: {} });
  const PREV_OK = { 上市: 44, 上櫃: 1, 興櫃: 1 };
  const stk = (label, override = {}, prev = PREV_OK) => {
    const dir = path.join(IN, `stk-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SOURCES) {
      const v = name in override ? override[name] : good[name];
      if (v !== null) fs.writeFileSync(path.join(dir, `${name}.bin`), v);
    }
    fs.writeFileSync(path.join(W, 'data', 'stocks.json'), prevStocks(prev));
    return run('build-stocks.mjs', ['--cache', dir], { outFile: 'stocks.json' });
  };
  const ctl = stk('ok');
  writes('build-stocks 對照：合成的六份來源要寫檔', ctl);
  const written = ctl.code === 0 ? JSON.parse(fs.readFileSync(path.join(W, 'data', 'stocks.json'), 'utf8')).counts.byMarket : {};
  eq(written, PREV_OK, '（前提）對照產出的各市場檔數＝合成的「上一次成功」（下面的「變少」才是只少那一份）');
  for (const name of SOURCES) {
    blocks(`build-stocks 空的：${name} 是空的要擋、點名它`, stk(`empty-${name}`, { [name]: empty[name] }), `${name}：`);
    blocks(`build-stocks 缺檔：${name} 取不到要擋、點名它`, stk(`missing-${name}`, { [name]: null }), `${name}：取不到`);
  }
  blocks('build-stocks 欄位對不上：twseCompanies 的公司代號改名要擋', stk('renamed-twse', { twseCompanies: JSON.stringify([{ 代號: '1101', 產業別: '01' }]) }), 'twseCompanies：欄位對不上');
  blocks('build-stocks 欄位對不上：tpexCompanies 的代號欄改名要擋', stk('renamed-tpex', { tpexCompanies: JSON.stringify([{ Code: '6488', SecuritiesIndustryCode: '24' }]) }), 'tpexCompanies：欄位對不上');
  blocks('build-stocks 解析不了：twseCompanies 不是 JSON 要擋', stk('badjson', { twseCompanies: 'not json' }), 'twseCompanies：解析不了');
  blocks('build-stocks 解析出 0 檔：stockDayAll 只有標題列要擋', stk('sda-header', { stockDayAll: good.stockDayAll.split('\n')[0] + '\n' }), 'stockDayAll：解析出 0 檔');
  blocks('build-stocks 資料變少：上櫃比上一次少一半以上要擋', stk('shrink', {}, { ...PREV_OK, 上櫃: 20 }), '上櫃的檔數');
} finally {
  fs.rmSync(W, { recursive: true, force: true });
}

done('buildtest');
