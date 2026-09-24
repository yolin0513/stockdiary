#!/usr/bin/env bash
# 【本質一次性，保留供重做】用途：S4 sweep 的修正前｜比較：84e3999 vs cb81089｜數字在：docs/EVIDENCE_檢查器修補.md「**S4 `sweep` 的合成對照組」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
# S4 三段證據：從真實入口（node scripts/sweep.mjs，打正式環境）在暫存複本（commit 之後）裡跑。
# 盲點樣本：sweep 的版本比對改成永遠成立。
set -u
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
OLDREV="${OLDREV:-84e3999}"   # 修正前（當時寫 origin/main，指的就是這個 commit；證據檔寫的明確雜湊）
T="$(mktemp -d)"
cleanup() { [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || { echo "複製失敗"; exit 1; }
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || { echo "junction 失敗"; exit 1; }
cd "$T/w" || exit 1
echo "複本 HEAD：$(git rev-parse --short HEAD)"
git -C "$ROOT" show $OLDREV:scripts/sweep.mjs > scripts/sweep-old.mjs || { echo "取不到修正前"; exit 1; }
HOLD=$(git hash-object scripts/sweep-old.mjs); HNEW=$(git hash-object scripts/sweep.mjs)
[ "$HOLD" != "$HNEW" ] || { echo "新舊同一份"; exit 1; }
grep -q "sweepjudge" scripts/sweep-old.mjs && { echo "取到的修正前已經有 S4"; exit 1; }
grep -q "eq(liveSw, LOCAL_VERSION," scripts/sweep-old.mjs || { echo "修正前沒有舊的版本比對"; exit 1; }
echo "修正前 ${HOLD:0:7}（沒有對照組、版本比對寫在本檔）／修正後 ${HNEW:0:7}"
cat > "$T/p.mjs" <<'JS'
import fs from 'node:fs';
const [f, a, b] = process.argv.slice(2);
const s = fs.readFileSync(f, 'utf8');
if (s.split(a).length !== 2) { console.error(`錨點對不上：${f}`); process.exit(1); }
const t = s.split(a).join(b);
if (t === s || !t.includes(b)) { console.error('沒改到'); process.exit(1); }
fs.writeFileSync(f, t);
JS
patch() { node "$T/p.mjs" "$@"; }
OUT="$T/o.txt"
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e scripts/sweep-old.mjs; }
run() { rm -f "$OUT"; node "scripts/$1" > "$OUT" 2>&1; CODE=$?; }

echo; echo "【修正前：版本比對改成永遠成立（sw.js 那一條）】"
reset; patch scripts/sweep-old.mjs "eq(liveSw, LOCAL_VERSION," "eq(LOCAL_VERSION, LOCAL_VERSION," || exit 1
run sweep-old.mjs; echo "  exit=$CODE"; grep -E "對照|sweep：|✗" "$OUT"

echo; echo "【修正後：同一種壞法打在 sweepjudge】"
reset; patch scripts/sweepjudge.mjs "  if (sw !== local) out.push({ where: 'sw.js', got: sw });" "  if (false) out.push({ where: 'sw.js', got: sw });" || exit 1
run sweep.mjs; echo "  exit=$CODE"; grep -E "✗|對照組沒過|sweep：" "$OUT"
grep -q "線上版本" "$OUT" && echo "  （有往下打網路）" || echo "  （停在對照組，沒有打網路）"

echo; echo "【突變：再把「對照組沒過就停」拿掉，同一種壞法】"
patch scripts/sweep.mjs "if (ctrl.some((c) => !c.ok)) {" "if (false) {" || exit 1
run sweep.mjs; echo "  exit=$CODE"; grep -E "對照組沒過|sweep：" "$OUT"

echo; echo "【每條 S4 突變打下去，controltest 紅了哪幾組】"
reset
node "$SP/s4each.mjs" || exit 1
echo; echo "【突變（commit 之後、在複本裡）：--only S4：】"
reset; git diff --quiet || { echo "複本不乾淨"; exit 1; }
rm -f "$T/m.txt"; node scripts/mutationtest.mjs --only 'S4：' > "$T/m.txt" 2>&1; echo "  exit=$?"; grep -E "S4：|mutationtest：" "$T/m.txt"
reset
