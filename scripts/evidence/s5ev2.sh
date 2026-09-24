#!/usr/bin/env bash
# 【本質一次性，保留供重做】用途：S5 修正前（taptest 在稽核下的那一段）｜比較：cb81089 vs e8245a3｜數字在：docs/EVIDENCE_檢查器修補.md「**S5 兩份清單的孤兒檢查」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
# S5 三段證據，在暫存複本（commit 之後）從真實入口跑。
set -u
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
OLDREV="${OLDREV:-cb81089}"   # 修正前（當時寫 origin/main，指的就是這個 commit；證據檔寫的明確雜湊）
SP="$(cd "$(dirname "$0")" && pwd)"   # 輔助腳本跟這支放在一起
T="$(mktemp -d)"
cleanup() { [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || exit 1
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || exit 1
cd "$T/w" || exit 1
echo "複本 HEAD：$(git rev-parse --short HEAD)"
for f in assertaudit auditjudge gatescan taptest; do
  git -C "$ROOT" show "$OLDREV:scripts/$f.mjs" > "scripts/$f-old.mjs" || { echo "取不到 $f 修正前"; exit 1; }
  [ "$(git hash-object scripts/$f-old.mjs)" != "$(git hash-object scripts/$f.mjs)" ] || { echo "$f 新舊同一份"; exit 1; }
done
grep -q "ORPHAN_SKIP" scripts/gatescan-old.mjs && { echo "gatescan 修正前已經有 S5"; exit 1; }
grep -q "auditOrphans" scripts/assertaudit-old.mjs && { echo "assertaudit 修正前已經有 S5"; exit 1; }
grep -q "SD_AUDIT: ''" scripts/taptest-old.mjs && { echo "taptest 修正前已經有 S5"; exit 1; }
node "$SP/patch.mjs" scripts/assertaudit-old.mjs "from './auditjudge.mjs'" "from './auditjudge-old.mjs'" || exit 1
grep -q "auditOrphans" scripts/auditjudge-old.mjs && { echo "auditjudge 修正前已經有 S5"; exit 1; }
echo "修正前取自 $OLDREV（$(git -C "$ROOT" rev-parse --short $OLDREV)），三支都驗過雜湊不同、舊版沒有 S5 的寫法"
OUT="$T/o.txt"
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e 'scripts/*-old.mjs'; }

echo; echo "【gatescan：丟一支沒登記、帶 | tail -1 的推送腳本 scripts/ship.sh（v9 盤點的原樣）】"
reset
printf '#!/usr/bin/env bash\nnode scripts/precheck.mjs HEAD | tail -1 && git push -q origin main\n' > scripts/ship.sh
[ -f scripts/ship.sh ] && grep -q "tail -1" scripts/ship.sh || { echo "情境沒造成"; exit 1; }
rm -f "$OUT"; node scripts/gatescan-old.mjs > "$OUT" 2>&1; echo "  修正前：exit=$?"; grep -E "ship|gatescan：" "$OUT"
mv scripts/gatescan-old.mjs "$T/gatescan-old.mjs"   # 它自己的檔名就像閘門，留在 scripts/ 會被新版的孤兒檢查挑到
rm -f "$OUT"; node scripts/gatescan.mjs > "$OUT" 2>&1; echo "  修正後：exit=$?"; grep -E -A1 "✗" "$OUT"; grep "gatescan：" "$OUT"
echo "  突變：把孤兒的判定拿掉（orphans 恆為空）"
node "$SP/patch.mjs" scripts/gatescan.mjs "    orphans: cand.filter((rel) => !registered.includes(rel) && !(rel in skip))," "    orphans: []," || exit 1
rm -f "$OUT"; node scripts/gatescan.mjs > "$OUT" 2>&1; echo "  exit=$?"; grep -E "✗|gatescan：" "$OUT"

echo; echo "【assertaudit：npm test 鏈上多一支新測試 zzqtest，清單沒收】"
reset
cp scripts/fmttest.mjs scripts/zzqtest.mjs
node "$SP/patch.mjs" scripts/zzqtest.mjs "done('fmttest');" "done('zzqtest');" || exit 1
node "$SP/patch.mjs" package.json "node scripts/fmttest.mjs && " "node scripts/fmttest.mjs && node scripts/zzqtest.mjs && " || exit 1
grep -q "node scripts/zzqtest.mjs" package.json || { echo "情境沒造成"; exit 1; }
rm -f "$OUT"; node scripts/assertaudit-old.mjs fmt > "$OUT" 2>&1; echo "  修正前（assertaudit fmt）：exit=$?"; grep -E "zzqtest|來自|不完整" "$OUT"
rm -f "$OUT"; node scripts/assertaudit.mjs fmt > "$OUT" 2>&1; echo "  修正後（assertaudit fmt）：exit=$?"; grep -E "zzqtest|清單|停下" "$OUT"
rm -f "$OUT"; node scripts/controltest.mjs > "$OUT" 2>&1; echo "  修正後（controltest，每版跑）：exit=$?"; grep -E -A1 "✗" "$OUT"

echo; echo "【擴大清單沒有少挑：舊清單與新清單的差異】"
reset
node "$SP/listdiff.mjs" || exit 1

echo; echo "【taptest 探針不再把資料寫進稽核報告（assertaudit taptest）】"
reset
cp scripts/taptest-old.mjs scripts/taptest.mjs; grep -q "SD_AUDIT: ''" scripts/taptest.mjs && { echo "沒換成舊版"; exit 1; }
rm -f "$OUT"; node scripts/assertaudit.mjs taptest > "$OUT" 2>&1; echo "  修正前的 taptest：exit=$?"; grep -E "來自|n=0" "$OUT" | head -3
reset
rm -f "$OUT"; node scripts/assertaudit.mjs taptest > "$OUT" 2>&1; echo "  修正後的 taptest：exit=$?"; grep -E "來自|n=0|（沒有）" "$OUT" | head -3
rm -f scripts/gatescan-old.mjs
for t in controltest gatescan; do rm -f "$OUT"; node scripts/assertaudit.mjs $t > "$OUT" 2>&1; echo "  assertaudit $t：exit=$?"; grep -E "✓ $t|✗|來自" "$OUT" | head -3; done
reset
