// 觀察 TWSE 當日收盤資料實際公布時間（M0，STATUS.md 驗收項目一）
//
// 在交易日盤後每隔數分鐘各打一次：
//   1) rwd/zh/afterTrading/STOCK_DAY_ALL?response=json  （全市場當日收盤，回 CSV）
//   2) exchangeReport/STOCK_DAY?date=<今天>&stockNo=2330（個股當月逐日，回 JSON）
// 記錄「第一次出現今天日期」的時刻，用來決定 settings 的「今日資料公布門檻」。
//
// 兩個端點的日期格式不同，必須分開處理：
//   STOCK_DAY_ALL  → "1150910"   （民國年 + 月 + 日，無分隔）
//   STOCK_DAY      → "115/09/10" （民國年/月/日）
//
// 每輪內兩個請求間隔 >= 2 秒（FEASIBILITY §1.2：社群共識 3 次／5 秒會被封 IP）。
//
// 用法：
//   node scripts/observe-twse-publish-time.mjs --out <jsonl 路徑> [--from 13:25] [--to 16:00] [--every 5]
//   node scripts/observe-twse-publish-time.mjs --once   （立刻打一輪，印出結果就結束）

import fs from 'node:fs';
import path from 'node:path';

const SDA_URL = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json';
const SD_URL = (yyyymmdd, stockNo) =>
  `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymmdd}&stockNo=${stockNo}`;
const STOCK_NO = '2330';
const GAP_MS = 3000; // 同一輪內兩個請求的間隔，> 2 秒
const TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseHhmm(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** 本地時區的今天，回傳兩個端點各自的日期字串與 yyyymmdd。 */
export function rocDateStrings(d) {
  const y = d.getFullYear() - 1911;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    yyyymmdd: `${d.getFullYear()}${mm}${dd}`,
    sdaDate: `${y}${mm}${dd}`, // STOCK_DAY_ALL
    sdDate: `${y}/${mm}/${dd}`, // STOCK_DAY
  };
}

/** 從 STOCK_DAY_ALL 的 CSV 取第一筆資料列的日期欄。 */
export function firstDateOfStockDayAllCsv(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('"')) continue; // 標題列沒有引號
    const m = /^"(\d{7})"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** 從 STOCK_DAY 的 JSON 取最後一筆（最新）交易日。 */
export function lastDateOfStockDayJson(json) {
  const rows = json && Array.isArray(json.data) ? json.data : [];
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return Array.isArray(last) ? String(last[0]) : null;
}

async function getText(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: '*/*' },
    });
    const text = await res.text();
    return { ok: true, status: res.status, ms: Date.now() - started, text };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(err && err.message ? err.message : err) };
  }
}

async function pollOnce(now) {
  const { yyyymmdd, sdaDate, sdDate } = rocDateStrings(now);

  const a = await getText(SDA_URL);
  const sdaFirstDate = a.ok ? firstDateOfStockDayAllCsv(a.text) : null;

  await new Promise((r) => setTimeout(r, GAP_MS));

  const b = await getText(SD_URL(yyyymmdd, STOCK_NO));
  let sdLastDate = null;
  let sdStat = null;
  if (b.ok) {
    try {
      const json = JSON.parse(b.text);
      sdStat = json.stat ?? null;
      sdLastDate = lastDateOfStockDayJson(json);
    } catch {
      sdStat = 'PARSE_ERROR';
    }
  }

  return {
    at: new Date().toISOString(),
    localTime: now.toTimeString().slice(0, 8),
    expected: { stockDayAll: sdaDate, stockDay: sdDate },
    stockDayAll: {
      http: a.status,
      ms: a.ms,
      bytes: a.ok ? a.text.length : 0,
      firstDate: sdaFirstDate,
      hasToday: sdaFirstDate === sdaDate,
      error: a.error ?? null,
    },
    stockDay: {
      http: b.status,
      ms: b.ms,
      stat: sdStat,
      lastDate: sdLastDate,
      hasToday: sdLastDate === sdDate,
      error: b.error ?? null,
    },
  };
}

function fmt(rec) {
  const A = rec.stockDayAll;
  const S = rec.stockDay;
  return `${rec.localTime}  STOCK_DAY_ALL http=${A.http} first=${A.firstDate ?? '-'} today=${A.hasToday ? 'YES' : 'no'}` +
    `  |  STOCK_DAY http=${S.http} last=${S.lastDate ?? '-'} today=${S.hasToday ? 'YES' : 'no'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = typeof args.out === 'string'
    ? args.out
    : path.join(process.cwd(), 'docs', 'measurements', `twse-publish-${new Date().toISOString().slice(0, 10)}.jsonl`);

  if (args.once) {
    const rec = await pollOnce(new Date());
    console.log(fmt(rec));
    console.log(JSON.stringify(rec));
    return;
  }

  const from = parseHhmm(args.from, { h: 13, m: 25 });
  const to = parseHhmm(args.to, { h: 16, m: 0 });
  const everyMin = Number(args.every ?? 5);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const start = new Date();
  start.setHours(from.h, from.m, 0, 0);
  const end = new Date();
  end.setHours(to.h, to.m, 0, 0);

  const log = (line) => {
    const stamped = `[${new Date().toTimeString().slice(0, 8)}] ${line}`;
    console.log(stamped);
    fs.appendFileSync(outPath.replace(/\.jsonl$/, '.log'), `${stamped}\n`, 'utf8');
  };

  log(`觀察開始：${from.h}:${String(from.m).padStart(2, '0')} – ${to.h}:${String(to.m).padStart(2, '0')}，每 ${everyMin} 分鐘一輪`);
  log(`輸出：${outPath}`);

  const waitMs = start.getTime() - Date.now();
  if (waitMs > 0) {
    log(`等待 ${Math.round(waitMs / 60000)} 分鐘後開始`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  let firstSdaHit = null;
  let firstSdHit = null;

  while (Date.now() <= end.getTime()) {
    const rec = await pollOnce(new Date());
    fs.appendFileSync(outPath, `${JSON.stringify(rec)}\n`, 'utf8');
    log(fmt(rec));

    if (!firstSdaHit && rec.stockDayAll.hasToday) {
      firstSdaHit = rec.localTime;
      log(`*** STOCK_DAY_ALL 首次出現今天日期：${firstSdaHit}`);
    }
    if (!firstSdHit && rec.stockDay.hasToday) {
      firstSdHit = rec.localTime;
      log(`*** STOCK_DAY 首次出現今天日期：${firstSdHit}`);
    }

    const nextAt = Date.now() + everyMin * 60000;
    if (nextAt > end.getTime()) break;
    await new Promise((r) => setTimeout(r, Math.max(0, nextAt - Date.now())));
  }

  log(`觀察結束。STOCK_DAY_ALL 首見=${firstSdaHit ?? '未出現'}；STOCK_DAY 首見=${firstSdHit ?? '未出現'}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('observe-twse-publish-time.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
