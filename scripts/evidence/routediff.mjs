// 【本質一次性，保留供重做】用途：範圍外第 3、4 件：新舊路由清單比對｜比較：77b026d 的 sweep 清單 vs scripts/routes.mjs｜數字在：docs/EVIDENCE_檢查器修補.md「**第 3、4 件已做**」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// cwd＝暫存複本。舊 sweep 寫死的清單 vs 新的 routes.mjs；舊 upgradecheck 換版後看的頁 vs 新的逐頁清單。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { ROUTES } = await import(pathToFileURL(path.resolve('scripts/routes.mjs')).href);
const oldSweep = fs.readFileSync('scripts/sweep-old.mjs', 'utf8');
const i = oldSweep.indexOf('const ROUTES = [');
const block = oldSweep.slice(i, oldSweep.indexOf('];', i));
const oldList = [...block.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => `${m[1]}｜${m[2]}`);
const newList = ROUTES.map(([r, t]) => `${r}｜${t}`);
if (oldList.length === 0) { console.error('舊清單擷取到 0 條'); process.exit(1); }
console.log(`  sweep：舊清單 ${oldList.length} 條、新清單 ${newList.length} 條；少掉的：${oldList.filter((x) => !newList.includes(x)).join('、') || '（沒有）'}；多出的：${newList.filter((x) => !oldList.includes(x)).join('、') || '（沒有）'}`);
// 舊 upgradecheck 換版之後看的頁：openApp 的主畫面（#view .card）、tapManagePlans 的 #/holdings → #/plans
const oldUc = fs.readFileSync('scripts/upgradecheck-old.mjs', 'utf8');
const oldPages = ['/', ...[...oldUc.matchAll(/#(\/[a-z]+)/g)].map((m) => m[1])].filter((v, k, a) => a.indexOf(v) === k);
const newPages = ROUTES.map(([r]) => r);
console.log(`  upgradecheck：舊版換版後看的頁 ${oldPages.join('、')}；新的逐頁清單 ${newPages.length} 頁；舊的有、新的沒有：${oldPages.filter((p) => !newPages.includes(p)).join('、') || '（沒有）'}；新增：${newPages.filter((p) => !oldPages.includes(p)).join('、')}`);
