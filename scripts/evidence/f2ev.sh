#!/usr/bin/env bash
# 【本質一次性，保留供重做】範圍外第 2 件修正前（77b026d 的 livecheck 沒打 FMTQIK）。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
# 第 2 件的證據（暫存複本、commit 之後）。舊版取明確的 77b026d。
set -u
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"; OLD=77b026d
SP="$(cd "$(dirname "$0")" && pwd)"   # 輔助腳本跟這支放在一起
T="$(mktemp -d)"
cleanup() { [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || exit 1
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || exit 1
cd "$T/w" || exit 1
echo "複本 HEAD：$(git rev-parse --short HEAD)"
OUT="$T/o.txt"
git -C "$ROOT" show "$OLD:scripts/livecheck.mjs" > "$T/livecheck-old.mjs" || exit 1
[ "$(git hash-object "$T/livecheck-old.mjs")" != "$(git hash-object scripts/livecheck.mjs)" ] || { echo "新舊同一份"; exit 1; }
grep -q "FMTQIK" "$T/livecheck-old.mjs" && { echo "舊版已經打 FMTQIK"; exit 1; }
echo "舊 livecheck 取自 $OLD：雜湊不同、裡面沒有 FMTQIK"

echo; echo "【修正前：把 livecheck 換成 $OLD 的版本，跑新的 controltest（每版跑）】"
cp "$T/livecheck-old.mjs" scripts/livecheck.mjs
rm -f "$OUT"; node scripts/controltest.mjs > "$OUT" 2>&1; echo "  exit=$?"; grep -E "✗" -A1 "$OUT"
git checkout -q -- scripts/livecheck.mjs

echo; echo "【修正後：原樣】"
rm -f "$OUT"; node scripts/controltest.mjs > "$OUT" 2>&1; echo "  exit=$?"; grep -E "端點" "$OUT"

echo; echo "【擴大擷取沒有少挑：新的擷取樣式 vs S9 盤點時用的樣式，對同一批 app 檔】"
node "$SP/epdiff.mjs" || exit 1
