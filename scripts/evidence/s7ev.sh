#!/usr/bin/env bash
# 【本質一次性，保留供重做】S7 修正前（cb81089 的 gatepush）。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
# S7 三段證據：在暫存複本裡把閘門換成「修正前」或「改壞的」版本並 commit，用新驗法（gatetest.sh）跑。
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
git config user.name "$(git -C "$ROOT" config user.name)"; git config user.email "$(git -C "$ROOT" config user.email)"
BASE="$(git rev-parse HEAD)"
echo "複本 HEAD：$(git rev-parse --short HEAD)"
summ() { grep -E "^  ✗|種符合|驗法登記" "$1"; }

variant() {
  # variant <名稱>：前提是 scripts/gatepush.sh 已經改好；commit 之後跑驗法，印出被執行的閘門雜湊與結果
  local name="$1" want
  want="$(git hash-object scripts/gatepush.sh)"
  git add scripts/gatepush.sh; git commit -q -m "證據：$name" || { echo "commit 失敗"; exit 1; }
  mkdir -p .logs; printf 'scripts/gatepush.sh 舊的登記\n' > .logs/gate-verified.txt
  [ -s .logs/gate-verified.txt ] || { echo "舊登記沒放成"; exit 1; }
  rm -f "$T/o.txt"; bash scripts/gatetest.sh > "$T/o.txt" 2>&1; local code=$?
  local ran; ran="$(grep -E '^被執行的閘門檔案雜湊' "$T/o.txt")"
  echo; echo "【$name】gatetest 回傳 $code"
  [ "${ran##*：}" = "$want" ] && echo "  被執行的閘門＝改過的那一份（${want:0:7}）" || echo "  ✗ 被執行的閘門不是改過的那一份：$ran／$want"
  summ "$T/o.txt"
  if [ -f .logs/gate-verified.txt ]; then echo "  登記檔：還在"; else echo "  登記檔：先放了一份舊的，驗法沒全過之後它被刪掉了"; fi
  git reset -q --hard "$BASE"
}

# 修正前：$OLDREV 的閘門（沒有第零關）
git -C "$ROOT" show $OLDREV:scripts/gatepush.sh > scripts/gatepush.sh || exit 1
grep -q "第零關" scripts/gatepush.sh && { echo "取到的修正前已經有第零關"; exit 1; }
[ "$(git hash-object scripts/gatepush.sh)" != "$(git rev-parse HEAD:scripts/gatepush.sh)" ] || { echo "新舊同一份"; exit 1; }
variant "修正前：$OLDREV 的閘門（$(git -C "$ROOT" rev-parse --short $OLDREV)，沒有第零關）"

# 突變一：拿掉整個第零關
node "$SP/patch.mjs" scripts/gatepush.sh 'if [ -s "$REG" ]; then' 'if false; then' || exit 1
node "$SP/patch.mjs" scripts/gatepush.sh '  echo "【第零關擋下】沒有驗法登記' '  : echo "【第零關擋下】沒有驗法登記' || exit 1
node "$SP/patch.mjs" scripts/gatepush.sh '先跑 bash scripts/gatetest.sh"
  exit 4
fi

LOCAL=' '先跑 bash scripts/gatetest.sh"
fi

LOCAL=' || exit 1
variant "突變一：拿掉整個第零關"

# 突變二：只看登記檔在不在、不比雜湊
node "$SP/patch.mjs" scripts/gatepush.sh '  if [ -n "$REG_BAD" ]; then' '  if false; then' || exit 1
variant "突變二：只看登記檔在不在、不比雜湊"

echo; echo "【對照：沒改的閘門】"
rm -f "$T/o.txt"; bash scripts/gatetest.sh > "$T/o.txt" 2>&1; echo "  gatetest 回傳 $?"; summ "$T/o.txt"
