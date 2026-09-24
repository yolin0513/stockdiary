// 【本質一次性，保留供重做】用途：共用：比兩份清單（擴大母體沒有少挑）｜比較：不適用（共用的小工具，被同目錄的量測腳本呼叫）｜數字在：docs/EVIDENCE_檢查器修補.md「## 盤點：哪些有常設情境守著」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// 在目前目錄比 assertaudit 舊清單（scripts/assertaudit-old.mjs 的 TESTS）與新清單（auditjudge.mjs 的 AUDIT_TESTS）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const old = fs.readFileSync('scripts/assertaudit-old.mjs', 'utf8');
const i = old.indexOf('const TESTS = [');
if (i < 0) { console.error('舊版找不到 TESTS'); process.exit(1); }
const body = old.slice(i, old.indexOf('];', i));
const oldList = [...body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
const { AUDIT_TESTS } = await import(pathToFileURL(path.resolve('scripts/auditjudge.mjs')).href);
console.log(`  舊 ${oldList.length} 支、新 ${AUDIT_TESTS.length} 支`);
console.log(`  少掉的：${oldList.filter((t) => !AUDIT_TESTS.includes(t)).join('、') || '（沒有）'}`);
console.log(`  多出的：${AUDIT_TESTS.filter((t) => !oldList.includes(t)).join('、') || '（沒有）'}`);
