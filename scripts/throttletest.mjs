// 請求節流（npm run throttletest）。
//
// 這裡**真的量時間**，不是讀程式碼確認有寫 setTimeout。
// 被 TWSE 封 IP 的後果是「這個使用者接下來一段時間完全打不開 App」，
// 所以這條要用實際間隔證明。

import { ok, eq, section, done, everyOf, noneOf } from './tap.mjs';
import { createClient, MIN_GAP_MS, MAX_REQUESTS, BudgetExceededError } from '../js/twseclient.js';
import { URL_DAY_ALL, urlStockDay, monthOf } from '../js/prices.js';

section('正式設定');
eq(MIN_GAP_MS, 2000, '最小間隔是 2 秒（FEASIBILITY §1.2：3 次／5 秒會被封 IP）');
eq(MAX_REQUESTS, 30, '一次開頁最多 30 個請求（PLAN §2.3）');

// 用縮小的間隔量真實時間 —— 行為一樣，測試不用跑一分鐘。
const GAP = 120;
function fakeFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push({ url, at: Date.now() });
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  return { impl, calls };
}

section(`連續請求的實際間隔 >= ${GAP} ms`);
{
  const f = fakeFetch();
  const client = createClient({ fetchImpl: f.impl, minGapMs: GAP });
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) await client.getText(`https://example.test/${i}`);
  const total = Date.now() - t0;

  eq(f.calls.length, 5, '五個請求都送出去了');
  const measured = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
  everyOf(measured, (g) => g >= GAP - 5, `每一段間隔都 >= ${GAP} ms（實測 ${measured.join('、')} ms）`);
  noneOf(measured, (g) => g < GAP - 5, '沒有任何一段偷跑');
  ok(total >= GAP * 4 - 20, `五個請求至少花了 ${GAP * 4} ms（實測 ${total} ms）`);
  eq(client.stats().count, 5, '計數正確');
}

section('同時發出的請求也要排隊，不能一起衝出去');
{
  const f = fakeFetch();
  const client = createClient({ fetchImpl: f.impl, minGapMs: GAP });
  // 五個 await 都不加，全部同時丟出去
  await Promise.all([0, 1, 2, 3, 4].map((i) => client.getText(`https://example.test/p${i}`)));
  const measured = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
  eq(f.calls.length, 5, '五個都送出去了');
  everyOf(measured, (g) => g >= GAP - 5,
    `同時發出時每一段間隔還是 >= ${GAP} ms（實測 ${measured.join('、')} ms）`);
}

section('第一個請求不必等');
{
  const f = fakeFetch();
  const client = createClient({ fetchImpl: f.impl, minGapMs: 5000 });
  const t0 = Date.now();
  await client.getText('https://example.test/first');
  ok(Date.now() - t0 < 200, `第一個請求馬上送出（花了 ${Date.now() - t0} ms）`);
}

section('單次開頁上限');
{
  const f = fakeFetch();
  const client = createClient({ fetchImpl: f.impl, minGapMs: 0, maxRequests: 3 });
  await client.getText('https://example.test/1');
  await client.getText('https://example.test/2');
  await client.getText('https://example.test/3');
  eq(client.remaining(), 0, '額度用完');
  let err = null;
  try { await client.getText('https://example.test/4'); } catch (e) { err = e; }
  ok(err instanceof BudgetExceededError, '超過上限時丟 BudgetExceededError');
  ok(/稍後再開一次/.test(String(err.message)), `訊息告訴使用者接下來會怎樣：「${err.message}」`);
  eq(f.calls.length, 3, '第四個請求真的沒有送出去');
}

section('一個請求失敗不會卡住整條佇列');
{
  const calls = [];
  let n = 0;
  const impl = async (url) => {
    calls.push(url);
    n += 1;
    if (n === 2) throw new Error('boom');
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const client = createClient({ fetchImpl: impl, minGapMs: 0 });
  await client.getText('a');
  let caught = null;
  try { await client.getText('b'); } catch (e) { caught = e; }
  await client.getText('c');
  eq(caught?.message, 'boom', '失敗的那個把錯誤丟給呼叫端');
  eq(calls, ['a', 'b', 'c'], '後面的請求照樣送得出去');
}

section('HTTP 錯誤要丟出來，不能當成空資料');
{
  const impl = async () => ({ ok: false, status: 503, text: async () => '' });
  const client = createClient({ fetchImpl: impl, minGapMs: 0 });
  let err = null;
  try { await client.getText('https://example.test/x'); } catch (e) { err = e; }
  ok(err && /HTTP 503/.test(err.message), `503 丟錯：「${err?.message}」`);
}

section('網址組法');
eq(URL_DAY_ALL, 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json', '全市場當日收盤');
eq(urlStockDay('2330', '2026-06-01'),
  'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260601&stockNo=2330',
  '個股當月逐日');
eq(monthOf('2026-09-11'), '2026-09', '月份鍵');
ok(urlStockDay('2330', '2026-06-11').includes('date=20260611'), '日期用西元 yyyymmdd，不是民國');

done('throttletest');
