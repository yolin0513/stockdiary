#!/usr/bin/env bash
# 【本質一次性，保留供重做】範圍外第 3 件：§5.12 只拿掉一道。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
# 第 3、4 件的證據（暫存複本、commit 之後）。舊版取明確的 77b026d。
set -u
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"; OLD=77b026d
SP="$(cd "$(dirname "$0")" && pwd)"   # 輔助腳本跟這支放在一起
T="$(mktemp -d)"
cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2> /dev/null; [ -d "$T/w/node_modules" ] && cmd //c rmdir "$(cygpath -w "$T/w/node_modules")" > /dev/null; rm -rf "$T"; }
trap cleanup EXIT
git clone -q --no-local "$ROOT" "$T/w" || exit 1
cmd //c mklink //J "$(cygpath -w "$T/w/node_modules")" "$(cygpath -w "$ROOT/node_modules")" > /dev/null || exit 1
cd "$T/w" || exit 1
echo "複本 HEAD：$(git rev-parse --short HEAD)"
for f in upgradecheck sweep; do
  git -C "$ROOT" show "$OLD:scripts/$f.mjs" > "scripts/$f-old.mjs" || { echo "取不到 $OLD 的 $f"; exit 1; }
  [ "$(git hash-object scripts/$f-old.mjs)" != "$(git hash-object scripts/$f.mjs)" ] || { echo "$f 新舊同一份"; exit 1; }
  grep -q "routes.mjs" "scripts/$f-old.mjs" && { echo "$f 取到的舊版已經用 routes.mjs"; exit 1; }
done
grep -q "^const ROUTES = \[" scripts/sweep-old.mjs || { echo "舊 sweep 沒有自己寫死的清單"; exit 1; }
grep -q "visitAll" scripts/upgradecheck-old.mjs && { echo "舊 upgradecheck 已經逐頁開"; exit 1; }
echo "舊版取自 $OLD：兩支都驗過雜湊不同、舊 sweep 還是自己寫死清單、舊 upgradecheck 沒有逐頁開"
OUT="$T/o.txt"
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e 'scripts/*-old.mjs'; }
patch() { node "$SP/patch.mjs" "$@" || { echo "  情境沒造成"; exit 1; }; }
run() { rm -f "$OUT"; "$@" > "$OUT" 2>&1; CODE=$?; }


echo; echo "【第 3 件（B）：股利頁設完標題才拋錯——只有錯誤卡抓得到的那一種】"
reset
patch js/views/dividends.js "  setTop({ title: '股利' });
" "  setTop({ title: '股利' });
  throw new Error('證據：股利頁一開就崩');
"
grep -q "證據：股利頁一開就崩" js/views/dividends.js || { echo "沒改到"; exit 1; }
run node scripts/upgradecheck-old.mjs; echo "  修正前（$OLD）：exit=$CODE"; grep -E "upgradecheck：|✗" "$OUT" | head -3
run node scripts/upgradecheck.mjs; echo "  修正後：exit=$CODE"; grep -E "✗" -A1 "$OUT"; grep "upgradecheck：" "$OUT"
echo "  突變：逐頁檢查不看錯誤卡（router 接住例外、畫了錯誤卡，標題與內容都在）"
patch scripts/upgradecheck.mjs "const pageOk = (x) => x.landed && x.text > 20 && !x.errorCard && x.errs.length === 0;" "const pageOk = (x) => x.landed && x.text > 20 && x.errs.length === 0;"
run node scripts/upgradecheck.mjs; echo "  exit=$CODE"; grep -E "逐頁|upgradecheck：" -A1 "$OUT"

reset
