#!/usr/bin/env bash
# 【本質一次性，保留供重做】用途：範圍外第 5 件（後來的 F8）第一版的修正前｜比較：77b026d vs 3cf33ae｜數字在：docs/EVIDENCE_檢查器修補.md「**第 5 件已做**」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
# 第 5 件的「修正前」：暫存複本裡把三支 build 換成 77b026d 的版本，跑新的 buildtest。
set -u
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"; OLD=77b026d
T="$(mktemp -d)"
cleanup() { [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || exit 1
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || exit 1
cd "$T/w" || exit 1
cp "$ROOT/scripts/buildtest.mjs" "$ROOT/scripts/testfetch.mjs" "$ROOT/scripts/buildguard.mjs" scripts/
for f in build-calendar build-dividends build-stocks; do
  git -C "$ROOT" show "$OLD:scripts/$f.mjs" > "scripts/$f.mjs" || { echo "取不到 $OLD 的 $f"; exit 1; }
  [ "$(git hash-object "scripts/$f.mjs")" != "$(git -C "$ROOT" hash-object "$ROOT/scripts/$f.mjs")" ] || { echo "$f 新舊同一份"; exit 1; }
  grep -q "buildguard" "scripts/$f.mjs" && { echo "$f 取到的舊版已經有關卡"; exit 1; }
done
grep -q "來源回的不是陣列或是空的" scripts/build-dividends.mjs || { echo "舊版 build-dividends 沒有舊訊息"; exit 1; }
grep -q "if (bad.length) console.warn" scripts/build-calendar.mjs || { echo "舊版 build-calendar 沒有舊寫法"; exit 1; }
echo "三支都換成 $OLD 的版本（雜湊與新版不同、沒有 buildguard、含舊寫法）"
rm -f "$T/o.txt"; node scripts/buildtest.mjs > "$T/o.txt" 2>&1; echo "buildtest（舊 build）：exit=$?"
grep -E "^\s+✗" "$T/o.txt"; tail -1 "$T/o.txt"
