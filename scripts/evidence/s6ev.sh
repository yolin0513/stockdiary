#!/usr/bin/env bash
# 【本質一次性，保留供重做】S6 修正前（cb81089 的 livecheck）。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
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
echo "複本 HEAD：$(git rev-parse --short HEAD)；修正前取自 $OLDREV（$(git -C "$ROOT" rev-parse --short $OLDREV)）"
git -C "$ROOT" show $OLDREV:scripts/livecheck.mjs > scripts/livecheck-old.mjs || exit 1
node "$SP/s6ev.mjs" || exit 1
echo; echo "【突變（commit 之後、在複本裡）：逐條看紅了哪幾組】"
git checkout -q -- . && git clean -fdq -e node_modules
node "$SP/each.mjs" 'S6：' 9
