#!/usr/bin/env bash
# 推送閘門（共用慣例 §2.5）：三關，每一關失敗都真的讓後面停下，而且回傳值分得出是哪一關。
#
#   bash scripts/gatepush.sh [遠端] [分支]        （預設 origin main）
#
#   回傳 0  推上去了，而且遠端的分支＝本機
#   回傳 1  第一關：公開前自查沒過（四類 scripts/precheck.mjs 或第五類 scripts/piiscan.mjs；
#           有命中、對照組壞了、黑名單檔不見、或取不到遠端狀態算不出要掃哪些 commit）
#   回傳 2  第二關：推送本身失敗（被拒、連不上……）
#   回傳 3  第三關：推送回報成功，但遠端的分支≠本機（「推了但沒成功」）
#
# 為什麼長這樣（2026-09-23）：
#   · 以前推送那一行是 `node precheck.mjs HEAD | tail -1 && git push …`：管線的回傳值是最後一個指令的，
#     自查的失敗被吞掉 —— 擋的是人眼，不是程式。所以這裡**不接任何管線**：輸出寫到檔案，回傳值各自存下來再判斷。
#   · 以前只掃 HEAD 一個 commit：一次推好幾個 commit 時前面的沒被掃到。現在掃「遠端分支..本機」的全部 commit。
#   · 以前沒有第三關：推送失敗被吞掉時，後面的線上確認會對著舊版驗、看起來還是綠的（TripQuest 被咬過）。
#   · 放在 repo、不放 Session 暫存目錄：防線不跟著 Session 生死。黑名單資料在 .private/（gitignore），見 STATUS「推送閘門」。
#
# 改過這支就重跑驗法：bash scripts/gatetest.sh（用本機假遠端製造每一關的失敗，不碰 GitHub）。
# 驗閘門時可以換檢查器：PRECHECK=<檔> PIISCAN=<檔> bash scripts/gatepush.sh …
set -u
REMOTE="${1:-origin}"
BRANCH="${2:-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PRECHECK="${PRECHECK:-$HERE/precheck.mjs}"
PIISCAN="${PIISCAN:-$HERE/piiscan.mjs}"
mkdir -p "$ROOT/.logs"
OUT="$ROOT/.logs/gatepush-last.log"
: > "$OUT"

LOCAL="$(git -C "$ROOT" rev-parse --verify -q "refs/heads/$BRANCH")"
if [ -z "$LOCAL" ]; then echo "【第一關擋下】本機沒有分支 $BRANCH"; exit 1; fi

# ---- 第一關：公開前自查（範圍＝這次要推的全部 commit）----
git -C "$ROOT" fetch -q "$REMOTE" "$BRANCH" >> "$OUT" 2>&1
F=$?
if [ "$F" -ne 0 ]; then
  cat "$OUT"
  echo "【第一關擋下】取不到 $REMOTE/$BRANCH 的狀態（fetch 回傳 $F），算不出這次要推哪些 commit，不推"
  exit 1
fi
RANGE="FETCH_HEAD..refs/heads/$BRANCH"
node "$PRECHECK" "$RANGE" >> "$OUT" 2>&1
A=$?
node "$PIISCAN" >> "$OUT" 2>&1
B=$?
cat "$OUT"
if [ "$A" -ne 0 ] || [ "$B" -ne 0 ]; then
  echo "【第一關擋下】公開前自查沒過（四類 precheck=$A、第五類 piiscan=$B），不推"
  exit 1
fi

# ---- 第二關：推送本身 ----
git -C "$ROOT" push -q "$REMOTE" "$BRANCH" > "$OUT.push" 2>&1
P=$?
cat "$OUT.push"
if [ "$P" -ne 0 ]; then
  echo "【第二關擋下】推送失敗（git push 回傳 $P）。後面的線上確認與巡檢都不要跑 —— 遠端還是舊版"
  exit 2
fi

# ---- 第三關：遠端的分支＝本機，才算推上去 ----
git -C "$ROOT" ls-remote "$REMOTE" "refs/heads/$BRANCH" > "$OUT.remote" 2> /dev/null
REMOTE_LINE="$(cat "$OUT.remote")"
REMOTE_SHA="${REMOTE_LINE%%[[:space:]]*}"
if [ "$REMOTE_SHA" != "$LOCAL" ]; then
  echo "【第三關擋下】推送回報成功，但 $REMOTE/$BRANCH 是 ${REMOTE_SHA:-（讀不到）}，本機是 $LOCAL。後面的線上確認與巡檢都不要跑"
  exit 3
fi
echo "【放行】三關都過：$REMOTE/$BRANCH ＝ 本機 ${LOCAL:0:7}"
exit 0
