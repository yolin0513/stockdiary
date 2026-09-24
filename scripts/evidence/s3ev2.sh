#!/usr/bin/env bash
# 【本質一次性，保留供重做】用途：S3 修正前（兩支測試、一支崩掉的版本）｜比較：84e3999 vs 4e74c86｜數字在：docs/EVIDENCE_檢查器修補.md「**S3 `assertaudit` 判斷邏輯的必敗對照組」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
# S3 三段證據：從真實入口（node scripts/assertaudit.mjs fmt）在暫存複本（commit 之後）裡跑。
# 盲點樣本：assertaudit 的判斷邏輯被改壞（三種），看它有沒有發現。
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
# 修正前：本機 repo 的 GitHub 追蹤分支（84e3999，還沒有 S3）
git -C "$ROOT" show $OLDREV:scripts/assertaudit.mjs > scripts/assertaudit-old.mjs || { echo "取不到修正前"; exit 1; }
HOLD=$(git hash-object scripts/assertaudit-old.mjs); HNEW=$(git hash-object scripts/assertaudit.mjs)
[ "$HOLD" != "$HNEW" ] || { echo "新舊同一份"; exit 1; }
grep -q "auditjudge" scripts/assertaudit-old.mjs && { echo "取到的修正前已經有 S3"; exit 1; }
grep -q "r.n <= 2);" scripts/assertaudit-old.mjs || { echo "修正前沒有舊的篩選寫法"; exit 1; }
echo "修正前 ${HOLD:0:7}（沒有對照組、篩選寫在本檔）／修正後 ${HNEW:0:7}"
OUT="$T/o.txt"
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e scripts/assertaudit-old.mjs; }
# patch <檔> <原文> <改成>：錨點必須剛好一次，改完驗新字串在、雜湊變了
patch() { node "$T/p.mjs" "$@"; }
run() { rm -f "$OUT"; node "scripts/$1" fmt > "$OUT" 2>&1; CODE=$?; }

cat > "$T/p.mjs" <<'JS'
import fs from 'node:fs';
const [f, a, b] = process.argv.slice(2);
const s = fs.readFileSync(f, 'utf8');
if (s.split(a).length !== 2) { console.error(`錨點對不上：${f}`); process.exit(1); }
const t = s.split(a).join(b);
if (t === s || !t.includes(b)) { console.error('沒改到'); process.exit(1); }
fs.writeFileSync(f, t);
JS

# 三種壞法：[名稱, 舊版原文, 舊版改成, 新版檔, 新版原文, 新版改成]
case_tiny() {
  echo; echo "【壞法一：「母體 ≤ 2」的篩選改成什麼都挑不到】"
  reset; patch scripts/assertaudit-old.mjs "r.n != null && r.n <= 2);" "r.n != null && r.n < 0);" || exit 1
  run assertaudit-old.mjs; echo "  修正前：exit=$CODE"; grep -E "對照|【1】|（沒有）" "$OUT" | head -3
  reset; patch scripts/auditjudge.mjs "r.n != null && r.n <= 2);" "r.n != null && r.n < 0);" || exit 1
  run assertaudit.mjs; echo "  修正後：exit=$CODE"; grep -E "✗|對照組沒過|【1】" "$OUT" | head -4
  # 突變：把修上去的判斷（對照組沒過就停）拿掉，同一個壞法
  patch scripts/assertaudit.mjs "if (ctrl.some((c) => !c.ok)) {" "if (false) {" || exit 1
  run assertaudit.mjs; echo "  拿掉「對照組沒過就停」：exit=$CODE"; grep -E "對照組沒過|【1】" "$OUT" | head -2
}
case_crash() {
  echo; echo "【壞法二：崩掉的測試不再判成「沒收到任何資料」】"
  reset; patch scripts/assertaudit-old.mjs "  if (n === 0) {" "  if (false) {" || exit 1
  printf 'throw new Error("在 done() 之前就崩了");\n' > scripts/fmttest.mjs
  run assertaudit-old.mjs; echo "  修正前：exit=$CODE"; grep -E "fmttest|不完整|來自" "$OUT" | head -3
  reset; patch scripts/auditjudge.mjs "  if (rows.length === 0) return 'no-data';" "  if (false) return 'no-data';" || exit 1
  printf 'throw new Error("在 done() 之前就崩了");\n' > scripts/fmttest.mjs
  run assertaudit.mjs; echo "  修正後：exit=$CODE"; grep -E "✗|對照組沒過" "$OUT" | head -4
}
case_fail() {
  echo; echo "【壞法三：紅了的測試被判成通過】"
  reset; patch scripts/assertaudit-old.mjs "process.stdout.write(passed ? " "process.stdout.write(true ? " || exit 1
  node "$T/p.mjs" scripts/fmttest.mjs "done('fmttest');" "ok(false, '驗收用：故意紅一條');
done('fmttest');" || exit 1
  run assertaudit-old.mjs; echo "  修正前：exit=$CODE"; grep -E "fmttest" "$OUT" | head -2
  reset; patch scripts/auditjudge.mjs "  return passed ? 'ok' : 'red-with-data';" "  return true ? 'ok' : 'red-with-data';" || exit 1
  node "$T/p.mjs" scripts/fmttest.mjs "done('fmttest');" "ok(false, '驗收用：故意紅一條');
done('fmttest');" || exit 1
  run assertaudit.mjs; echo "  修正後：exit=$CODE"; grep -E "✗|對照組沒過" "$OUT" | head -4
}
run2() { rm -f "$OUT"; node "scripts/$1" calc > "$OUT" 2>&1; CODE=$?; }
echo; echo "【壞法二（兩支：calctest 崩、calcviewtest 正常）】"
reset; patch scripts/assertaudit-old.mjs "  if (n === 0) {" "  if (false) {" || exit 1
printf 'throw new Error("在 done() 之前就崩了");
' > scripts/calctest.mjs; grep -q "done() 之前就崩了" scripts/calctest.mjs || exit 1
run2 assertaudit-old.mjs; echo "  修正前：exit=$CODE"; grep -E "calctest|calcviewtest|不完整|來自" "$OUT" | head -4
reset; patch scripts/auditjudge.mjs "  if (rows.length === 0) return 'no-data';" "  if (false) return 'no-data';" || exit 1
printf 'throw new Error("在 done() 之前就崩了");
' > scripts/calctest.mjs
run2 assertaudit.mjs; echo "  修正後：exit=$CODE"; grep -E "✗|對照組沒過" "$OUT" | head -4
reset
