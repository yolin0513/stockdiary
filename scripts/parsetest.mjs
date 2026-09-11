// TWSE 回應解析器（npm run parsetest）。固定樣本全部取自實際回應，見 scripts/fixtures/。
//
// 這裡守的是整個 App 最容易出事的兩件事：
//   · 沒成交／沒公布的價格必須是 null，不能是 0
//   · 除權息日 TWSE 回 "X0.00"，那個 0 不是「持平」

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, near, throws, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { num, parseCsv, parseStockDayAll, parseStockDay, stockNoOfStockDay } from '../js/twse.js';

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
const sda = parseStockDayAll(read('stock-day-all.csv'));
eq(sda.date, '2026-09-10', '資料日期由民國 7 碼轉出來');
eq(sda.rows.length, 6, '樣本有 6 檔');

const tsmc = sda.rows.find((r) => r.code === '2330');
eq(tsmc.name, '台積電', '2330 名稱');
eq(tsmc.close, 2450, '2330 收盤價');
eq(tsmc.change, -15, '2330 漲跌（負號）');
eq(tsmc.open, 2445, '2330 開盤價');
eq(tsmc.traded, true, '2330 有成交');

const cement = sda.rows.find((r) => r.code === '1101');
eq(cement.change, 0.05, '1101 漲跌沒有正號，值是正的');
ok(cement.change > 0, '沒有正號的漲跌價差要解成正值，不是 0', `實際 ${cement.change}`);

const etf = sda.rows.find((r) => r.code === '0050');
eq(etf.name, '元大台灣50', 'ETF 也在同一份表裡');
eq(etf.close, 109.15, 'ETF 收盤價');

section('當日沒成交的證券：價格是 null，絕不是 0');
const quiet = sda.rows.find((r) => r.code === '00625K');
eq(quiet.traded, false, '00625K 當天沒有成交');
eq(quiet.close, null, '收盤價是 null');
eq(quiet.open, null, '開盤價是 null');
// TWSE 對沒成交的證券把漲跌價差寫成 "0.0000"。那不是「沒漲沒跌」，是「沒有這個數字」。
eq(quiet.change, null, '漲跌是 null —— 原始回應寫 "0.0000"，照抄的話畫面會出現一筆假的持平');
ok(read('stock-day-all.csv').includes('"00625K","富邦上証+R","","","","","","","0.0000"'),
  '（對照）原始樣本確實把沒成交的漲跌寫成 0.0000');
eq(sda.untraded, 1, '沒成交的檔數有被數出來');
noneOf(sda.rows.filter((r) => !r.traded), (r) => r.close === 0 || r.change === 0,
  '沒成交的列裡沒有任何一個 0');
everyOf(sda.rows.filter((r) => r.traded), (r) => typeof r.close === 'number' && r.close > 0,
  '有成交的列都有正的收盤價');

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

section('數值精度');
near(parseStockDayAll(read('stock-day-all.csv')).rows.find((r) => r.code === '00632R').close, 9.73, 1e-9,
  '個位數價格保留兩位小數');

done('parsetest');
