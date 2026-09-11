// TWSE 回應解析器（npm run parsetest）。固定樣本全部取自實際回應，見 scripts/fixtures/。
//
// 這裡守的是整個 App 最容易出事的兩件事：
//   · 沒成交／沒公布的價格必須是 null，不能是 0
//   · 除權息日 TWSE 回 "X0.00"，那個 0 不是「持平」

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, near, throws, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { num, parseCsv, parseStockDayAll, parseStockDay, parseFmtqik, stockNoOfStockDay } from '../js/twse.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

section('num()：拿不到的數字是 null，不是 0');
eq(num('2450.00'), 2450, '一般小數');
eq(num('28,931,697'), 28931697, '千分位逗號');
eq(num(' 0.00'), 0, '前面有空白的零，確實是零');
eq(num('+25.00'), 25, '正號');
eq(num('-15.0000'), -15, '負號');
everyOf(['', '   ', '--', '---', 'X0.00', 'abc', null, undefined, '1.2.3'],
  (x) => num(x) === null, '非數字一律 null');
ok(num('--') !== 0, '"--" 不能變成 0', `實際 ${num('--')}`);
ok(num('') !== 0, '空字串不能變成 0', `實際 ${num('')}`);

section('CSV 解析：引號、逗號、跳脫、CRLF');
eq(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']], '最單純的情況');
eq(parseCsv('"1150910","富邦上証+R",""\n'), [['1150910', '富邦上証+R', '']], '欄位有引號、名稱有加號、有空欄');
eq(parseCsv('"a,b","c"\n'), [['a,b', 'c']], '引號內的逗號不是分隔符');
eq(parseCsv('"他說""好""","x"\n'), [['他說"好"', 'x']], '兩個引號代表一個引號');
eq(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF 換行');

section('STOCK_DAY_ALL（全市場當日收盤）');
// 樣本是真實回應的節錄（2026-09-11 抓的 1379 檔）。挑法不是隨機：
// **當天 12 檔沒成交的全部收進來**，再加幾檔有成交的（含漲的與跌的）。
// 以前只留 1 檔沒成交，於是「沒成交的列裡沒有任何一個 0」只檢查了 1 列 ——
// 那條契約幾乎沒有鑑別力（assertaudit 掃出來的）。
const sda = parseStockDayAll(read('stock-day-all.csv'));
eq(sda.date, '2026-09-11', '資料日期由民國 7 碼轉出來');
eq(sda.rows.length, 20, '樣本有 20 檔');

const tsmc = sda.rows.find((r) => r.code === '2330');
eq(tsmc.name, '台積電', '2330 名稱');
eq(tsmc.close, 2410, '2330 收盤價');
eq(tsmc.change, -40, '2330 漲跌（負號）');
eq(tsmc.open, 2430, '2330 開盤價');
eq(tsmc.traded, true, '2330 有成交');

// 沒有正號的漲跌價差：TWSE 對正數不寫 "+"，只寫 "0.1800"。
// 解成 0 或解成負的都是錯的。
const upRow = sda.rows.find((r) => r.code === '00632R');
eq(upRow.change, 0.18, '沒有正號的漲跌價差，值是正的');
ok(upRow.change > 0, '不是 0 也不是負的', `實際 ${upRow.change}`);
// 全樣本對照：直接從原始 CSV 取「漲跌價差沒有負號」的那些代號，再回頭看解出來的值。
// （不能用解完的欄位去反推有沒有負號 —— 那會變成拿結論驗結論。）
const rawNoMinus = read('stock-day-all.csv').split('\n').slice(1).filter(Boolean)
  .map((l) => l.split(',').map((c) => c.replace(/"/g, '')))
  .filter((c) => c[9] && !c[9].startsWith('-'))
  .map((c) => c[1]);
everyOf(sda.rows.filter((r) => rawNoMinus.includes(r.code) && r.traded),
  (r) => r.change >= 0,
  '（全樣本）原始欄位沒有負號的，解出來都不是負的');

const etf = sda.rows.find((r) => r.code === '0050');
eq(etf.name, '元大台灣50', 'ETF 也在同一份表裡');
eq(etf.close, 107.7, 'ETF 收盤價');

// 真正持平的有成交證券：change 是 0，**不是 null**。
// 這條跟下一段的「沒成交 → null」互為對照 —— 少了它，一個把所有 0.0000 都解成
// null 的壞解析器也會全過。
const flat = sda.rows.find((r) => r.code === '00625K');
eq(flat.traded, true, '00625K 當天有成交（一筆、一萬股）');
eq(flat.close, 8.55, '有成交就有收盤價');
eq(flat.change, 0, '真正的持平解成 0，不是 null');

section('當日沒成交的證券：價格是 null，絕不是 0');
const quiet = sda.rows.find((r) => r.code === '01010T');
eq(quiet.traded, false, '01010T 當天沒有成交');
eq(quiet.close, null, '收盤價是 null');
eq(quiet.open, null, '開盤價是 null');
// TWSE 對沒成交的證券把漲跌價差寫成 "0.0000"。那不是「沒漲沒跌」，是「沒有這個數字」。
eq(quiet.change, null, '漲跌是 null —— 原始回應寫 "0.0000"，照抄的話畫面會出現一筆假的持平');
ok(read('stock-day-all.csv').includes('"01010T","京城樂富R1","","","","","","","0.0000"'),
  '（對照）原始樣本確實把沒成交的漲跌寫成 0.0000');
eq(sda.untraded, 12, '沒成交的檔數有被數出來');
everyOf(sda.rows.filter((r) => !r.traded), (r) => r.close === null && r.open === null && r.change === null,
  '**12 檔沒成交的，價格與漲跌全部是 null**');
noneOf(sda.rows.filter((r) => !r.traded), (r) => r.close === 0 || r.change === 0,
  '沒成交的列裡沒有任何一個 0');
// 有幾檔（1472、2024、2891B）有成交股數與成交筆數，但價格欄位是空的。
// 判準是**有沒有收盤價**，不是有沒有成交股數 —— 用後者會讓這幾檔冒出 null 價格卻被當成有成交。
const partial = sda.rows.filter((r) => r.shares > 0 && r.close === null);
everyOf(partial, (r) => r.traded === false,
  '有成交股數但沒有收盤價的，一律算沒成交');
everyOf(sda.rows.filter((r) => r.traded), (r) => typeof r.close === 'number' && r.close > 0,
  '有成交的列都有正的收盤價');
// 對照：兩邊都要有母體，不然上面兩條可能只是因為其中一邊是空的
ok(sda.rows.filter((r) => r.traded).length >= 5 && sda.rows.filter((r) => !r.traded).length >= 5,
  `（對照）有成交 ${sda.rows.filter((r) => r.traded).length} 檔、沒成交 ${sda.untraded} 檔，兩邊母體都夠大`);

section('欄位順序變了就整份拒收，不要解出錯位的數字');
throws(() => parseStockDayAll('日期,證券名稱,證券代號,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n'),
  /欄位與預期不同.*第 2 欄/, '代號與名稱對調 → 丟錯');
throws(() => parseStockDayAll('"1150910","2330","台積電"\n'), /找不到標題列/, '沒有標題列 → 丟錯');

section('STOCK_DAY（個股當月逐日）');
const junJson = JSON.parse(read('stock-day-2330-202606.json'));
const jun = parseStockDay(junJson);
eq(jun.ok, true, '正常回應');
eq(stockNoOfStockDay(junJson), '2330', '從 title 取得股票代號');
ok(jun.rows.length > 15, `115 年 6 月有 ${jun.rows.length} 個交易日`);
eq(jun.rows[0].date, '2026-06-01', '第一筆日期');
eq(jun.rows[0].close, 2355, '第一筆收盤價');
eq(jun.rows[0].change, 0, '"  0.00" 是真的持平，解成 0');
eq(jun.rows[1].change, 25, '"+25.00" 解成 +25');
eq(jun.rows[1].shares, 41532527, '千分位的成交股數');

section('除權息日：TWSE 回 "X0.00"，不能當成持平');
const exRows = jun.rows.filter((r) => r.exMark);
eq(exRows.length, 1, '這個月有一天除權息');
eq(exRows[0].date, '2026-06-11', '2330 在 115/06/11 除息');
eq(exRows[0].close, 2250, '當天收盤 2250');
// 前一交易日收 2255。若把 "X0.00" 解成 0，畫面會顯示「今天沒漲沒跌」；
// 若拿 2250-2255 當當日損益，又會少算股利。兩種都錯 —— 所以 change 給 null，
// 逼上層去拿除權息參考價（M2）。
eq(exRows[0].change, null, '除權息日的漲跌是 null，強迫上層改用參考價');
const before = jun.rows[jun.rows.findIndex((r) => r.exMark) - 1];
eq(before.close, 2255, '（對照）前一交易日收 2255，差 -5 —— 直接相減會少算掉股利');
detects(
  (raw) => /X/i.test(raw),
  { shouldHit: ['X0.00', 'X1.50'], shouldMiss: [' 0.00', '+25.00', '-50.00', '0.0500'] },
  '除權息標記的判斷有對照組'
);
noneOf(jun.rows.filter((r) => r.exMark), (r) => r.change === 0,
  '被標記除權息的列沒有任何一個 change 是 0');
everyOf(jun.rows.filter((r) => !r.exMark), (r) => typeof r.change === 'number',
  '沒有除權息標記的列都解得出漲跌');

section('查無資料：要能分辨，而且不能生出空的價格');
const empty = parseStockDay(JSON.parse(read('stock-day-empty.json')));
eq(empty.ok, false, '日期太早的查詢回 ok=false');
eq(empty.rows, [], '沒有任何資料列');
ok(empty.message.length > 0, `而且帶得出原因：「${empty.message}」`);

// TWSE 對上櫃代號回的東西跟「代號不存在」一模一樣 —— 這就是 data/stocks.json 必須存在的理由。
const otc = parseStockDay(JSON.parse(read('stock-day-otc-6488.json')));
eq(otc.ok, false, '上櫃代號 6488 在 TWSE 查不到');
eq(otc.message, '很抱歉，沒有符合條件的資料!', '訊息與「代號不存在」完全相同，分不出來');
eq(otc.rows, [], '而且一筆資料都沒有 —— 任何畫面都不該從這裡生出價格');

section('STOCK_DAY 欄位順序變了也要拒收');
throws(() => parseStockDay({ stat: 'OK', fields: ['日期', '收盤價'], data: [] }),
  /欄位與預期不同/, '欄位少了 → 丟錯');

section('FMTQIK：大盤指數（今日觀察的提示內容要用）');
// 樣本是真實回應（115 年 9 月整月）。這支端點 date 參數**真的有作用**
// （TWT48U／TWT49U 的沒有），一個請求回一整個月。
const fq = parseFmtqik(JSON.parse(read('fmtqik-115-09.json')));
eq(fq.ok, true, '整月市場成交資訊解得開');
ok(fq.rows.length >= 9, `9 月到 9/11 有 ${fq.rows.length} 個交易日`);
everyOf(fq.rows, (r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date), '每一列的日期都轉成西元 ISO');

const d911 = fq.rows.find((r) => r.date === '2026-09-11');
eq(d911.index, 46184.85, '9/11 收 46,184.85（逗號要吃掉）');
eq(d911.changePoints, -755.64, '漲跌點數自己帶負號');
// 這個 -1.61 不是抄上游的：FMTQIK 沒有百分比欄位，是用「點數 ÷ 前一日指數」算出來的。
// 對照組是 MI_INDEX 同一天自己公布的漲跌百分比 -1.61 —— 兩邊實測對得起來。
eq(d911.changePct, -1.61, '漲跌％由點數與前一日指數算出來');
const prev = fq.rows.find((r) => r.date === '2026-09-10');
near(d911.index - d911.changePoints, prev.index, 1e-6,
  '（對照）當日指數減掉點數，剛好等於前一個交易日的指數');

const up = fq.rows.find((r) => r.changePoints > 0);
ok(up && up.changePct > 0, `漲的那幾天算出來是正的（${up?.date} ${up?.changePct}%）`);
noneOf(fq.rows, (r) => (r.changePoints > 0 && r.changePct <= 0) || (r.changePoints < 0 && r.changePct >= 0),
  '每一列的百分比方向都跟點數一致');
ok(fq.rows.filter((r) => r.changePoints > 0).length >= 2
  && fq.rows.filter((r) => r.changePoints < 0).length >= 2,
  `（對照）樣本裡漲 ${fq.rows.filter((r) => r.changePoints > 0).length} 天、跌 ${fq.rows.filter((r) => r.changePoints < 0).length} 天，兩個方向都驗得到`);

// 拿不到就是 null。**回 0 的話「今日觀察」會把「沒公布」講成「大盤持平」。**
eq(parseFmtqik({ stat: '很抱歉，沒有符合條件的資料!' }), { ok: false, message: '很抱歉，沒有符合條件的資料!', rows: [] },
  '查無資料 → ok=false，一筆都沒有');
const blank = parseFmtqik({ stat: 'OK', fields: ['日期', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌點數'],
  data: [['115/09/11', '--', '--', '--', '--', '--']] });
eq(blank.rows[0].index, null, '指數是 "--" 時解成 null');
eq(blank.rows[0].changePct, null, '算不出百分比時是 null，不是 0');
throws(() => parseFmtqik({ stat: 'OK', fields: ['日期', '收盤指數'], data: [] }),
  /FMTQIK 欄位與預期不同/, '欄位順序變了就整份拒收');

section('數值精度');
near(parseStockDayAll(read('stock-day-all.csv')).rows.find((r) => r.code === '00632R').close, 9.91, 1e-9,
  '個位數價格保留兩位小數');

done('parsetest');
