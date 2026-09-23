#!/usr/bin/env bash
# 推送閘門：公開前自查（四類 scripts/precheck.mjs ＋ 第五類 scripts/piiscan.mjs）兩支都回傳 0，才執行後面的推送指令。
#
#   bash scripts/gatepush.sh git push -q origin main
#
# 為什麼要這支（2026-09-23）：以前推送那一行是 `node precheck.mjs HEAD | tail -1 && git push …`，
# 管線的回傳值是最後一個指令（tail）的，自查的失敗被吞掉 —— 擋的是人眼，不是程式。
# 統籌者、JLPT_App、本 App 各自獨立踩到同一個洞：為了讓輸出好看而加的管線，把閘門廢掉。
# 所以這裡**不接任何管線**：輸出先寫到檔案，兩支的回傳值各自存下來再判斷。
#
# 2026-09-23 從 Session 的暫存目錄搬進 repo：防線不該跟著 Session 生死（Session 會被刪、撞額度、被換掉）。
# 黑名單資料不在這裡，在 .private/pii-blacklist.txt（gitignore）；見 docs/STATUS.md「推送閘門」。
#
# 驗閘門本身時可以換檢查器：PRECHECK=<檔> PIISCAN=<檔> bash scripts/gatepush.sh …（例如故意弄壞對照組的複本）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PRECHECK="${PRECHECK:-$HERE/precheck.mjs}"
PIISCAN="${PIISCAN:-$HERE/piiscan.mjs}"
mkdir -p "$ROOT/.logs"
OUT="$ROOT/.logs/gatepush-last.log"

if [ "$#" -eq 0 ]; then echo "用法：bash scripts/gatepush.sh <推送指令…>"; exit 2; fi

node "$PRECHECK" HEAD > "$OUT" 2>&1
A=$?
node "$PIISCAN" >> "$OUT" 2>&1
B=$?
cat "$OUT"

if [ "$A" -ne 0 ] || [ "$B" -ne 0 ]; then
  echo "【擋下】公開前自查沒過（四類 precheck=$A、第五類 piiscan=$B），不執行：$*"
  exit 1
fi
echo "【放行】公開前自查通過，執行：$*"
"$@"
