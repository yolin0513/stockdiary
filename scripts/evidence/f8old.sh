#!/usr/bin/env bash
# 【本質一次性，保留供重做】用途：F8 三支 build 的舊版矩陣數字｜比較：77b026d／3cf33ae／04b205e（修正前）vs 矩陣版 buildtest｜數字在：docs/EVIDENCE_檢查器修補.md「**F8：三支 build 資料變少照樣寫檔」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
# F8 的「修正前」：矩陣版 buildtest 配舊版的三支 build（明確的 commit），先證明是舊版。
# 用法：bash f8old.sh <commit> <舊版必有的字串（檔名:字串）>...
set -u
SP="$(cd "$(dirname "$0")" && pwd)"   # 輔助腳本跟這支放在一起
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"; REV="$1"; shift
D="${NEWDIR:-$ROOT}"   # 修正後的那一份（當時是開發複本；重做時預設用 repo 本身）
T="$(mktemp -d)"
cleanup() { [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || exit 1
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || exit 1
cd "$T/w" || exit 1
cp "$D/scripts/buildtest.mjs" "$D/scripts/testfetch.mjs" scripts/
# buildguard.mjs：那個 commit 有就用它自己的（舊的 build 要配舊的寫檔函式，量出來才是當時的行為）；沒有（77b026d）就放新版，舊的 build 不會 import 它
if git -C "$ROOT" cat-file -e "$REV:scripts/buildguard.mjs" 2> /dev/null; then git -C "$ROOT" show "$REV:scripts/buildguard.mjs" > scripts/buildguard.mjs; echo "buildguard.mjs 取自 $REV"; else cp "$D/scripts/buildguard.mjs" scripts/; echo "$REV 沒有 buildguard.mjs"; fi
for f in build-calendar build-dividends build-stocks; do
  git -C "$ROOT" show "$REV:scripts/$f.mjs" > "scripts/$f.mjs" || { echo "取不到 $REV 的 $f"; exit 1; }
  [ "$(git hash-object "scripts/$f.mjs")" != "$(git hash-object "$D/scripts/$f.mjs")" ] || { echo "$f 與修正後同一份"; exit 1; }
done
for spec in "$@"; do
  f="${spec%%:*}"; s="${spec#*:}"
  grep -qF -- "$s" "scripts/$f" || { echo "$REV 的 $f 裡沒有「$s」——取到的不是預期的舊版"; exit 1; }
done
echo "三支 build 取自 $REV：雜湊都與修正後不同，含舊寫法（$*）"
rm -f "$T/o.txt"; node scripts/buildtest.mjs > "$T/o.txt" 2>&1; echo "buildtest：exit=$?"
grep -E "矩陣共|^  · +(碰巧擋下|沒擋)：" "$T/o.txt"; grep -E "^buildtest：" "$T/o.txt"
