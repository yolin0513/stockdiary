#!/usr/bin/env bash
# 推送閘門的驗法（共用慣例 §2.5）：用實際推送的那一整行，分別製造每一關的失敗。**不碰 GitHub。**
#
#   bash scripts/gatetest.sh
#
# 做法：在暫存目錄建一個 bare repo 當假遠端，把本 repo **已 commit 的內容**複製一份過去跑閘門
# （所以改過閘門要先在本機 commit、再跑這支）。
#   · 推送被拒          → 假遠端放一個回傳 1 的 pre-receive
#   · 推了卻沒更新      → 假遠端放一個把 main 退回舊值的 post-receive
#   · 自查命中          → 在複本裡 commit 一個當場組出來的合成樣本
#   · 對照組壞掉        → 把檢查器的對照樣本換掉的複本（放在複本 repo 底下，檢查器靠自己的位置推算根目錄）
# 黑名單用一個**合成字面**的檔（真的黑名單是個資，不複製過去）。
# 每一種都檢查兩件事：閘門的回傳值、假遠端的 main 有沒有被動到。
# 全部符合才回傳 0。改過 scripts/gatepush.sh、precheck.mjs、piiscan.mjs 就重跑。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

git init -q --bare "$T/remote.git"
git clone -q --no-local "$ROOT" "$T/work" || { echo "複製失敗"; exit 1; }
cd "$T/work" || exit 1
git remote set-url origin "$T/remote.git"
# 複本沒有本 repo 的作者設定，commit 會失敗 —— 沿用本 repo 的（noreply）。而且 commit 失敗就中止，
# 不要帶著沒做成的 commit 往下驗（第一版就是這樣：commit 沒做成，情境 1 靠別的理由「剛好」回傳 1）
git config user.name "$(git -C "$ROOT" config user.name)"
git config user.email "$(git -C "$ROOT" config user.email)"
git push -q origin main || { echo "假遠端初始化失敗"; exit 1; }
mkdir -p .private .logs
# 合成字面拆開寫：原樣寫在這支檔裡的話，第五類掃描會在複本裡掃到這一行，每一種情境都被它擋下
printf '# 驗法用的合成黑名單（不是真的個資）\n%s%s\n' '7,6-5' ',4-3 合成字面' > .private/pii-blacklist.txt

remote_sha() { git --git-dir="$T/remote.git" rev-parse main; }
reset_to_remote() { git reset -q --hard "$(remote_sha)"; }
die() { echo "  ✗ 驗法本身出錯：$1"; exit 1; }
clean_commit() { printf '%s\n' "$1" >> gatetest-note.md; git add gatetest-note.md; git commit -q -m "gatetest：$1" || die "commit 失敗（$1）"; }

OK=0
BAD=0
run() {
  # run <情境> <預期回傳值> <假遠端應該：沒動|等於本機> <輸出裡必須出現的字（證明是「對的那一關、對的那一支」擋下）> [環境變數…]
  # 只看回傳值不夠：第一版情境 1 回傳了 1，但擋下它的是第五類、不是該抓 token 的四類自查。
  local name="$1" want="$2" remote_should="$3" must="$4"; shift 4
  local before after code
  before="$(remote_sha)"
  env "$@" bash scripts/gatepush.sh > "$T/out.txt" 2>&1
  code=$?
  after="$(remote_sha)"
  local moved="沒動"
  [ "$before" != "$after" ] && moved="被動到了"
  local good=1
  [ "$code" -ne "$want" ] && good=0
  if [ "$remote_should" = "沒動" ] && [ "$before" != "$after" ]; then good=0; fi
  if [ "$remote_should" = "等於本機" ] && [ "$after" != "$(git rev-parse HEAD)" ]; then good=0; fi
  grep -qF -- "$must" "$T/out.txt" || good=0
  local verdict
  verdict="$(grep -E '^【' "$T/out.txt")"
  if [ "$good" -eq 1 ]; then OK=$((OK + 1)); echo "  ✓ $name：回傳 $code（預期 $want），假遠端$moved｜$verdict"
  else BAD=$((BAD + 1)); echo "  ✗ $name：回傳 $code（預期 $want），假遠端$moved（應該$remote_should），輸出裡要有「$must」｜$verdict"; fi
}

echo "推送閘門驗法：假遠端 ＝ 暫存目錄裡的 bare repo，閘門＝ $(git log --oneline -1 -- scripts/gatepush.sh)"

# 1. 自查命中：HEAD 帶一個合成 token（拆開拼，這支檔自己才不會被自查抓到）
TOK="gh""p_A1b2C3d4E5f6G7h8I9j0KLMN"
printf 'const k = "%s";\n' "$TOK" > gatetest-fake.js; git add gatetest-fake.js; git commit -q -m "gatetest：合成 token" || die "commit 失敗（合成 token）"
run "1. 自查命中（HEAD 帶合成 token）" 1 沒動 "(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1"
# 1b. 命中在較早的 commit、HEAD 是乾淨的 —— 以前只掃 HEAD 會漏掉這種
clean_commit "命中之後又疊一個乾淨的"
run "1b. 命中在較早的 commit（HEAD 乾淨）" 1 沒動 "(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1"
reset_to_remote

# 2. 對照組壞掉（乾淨的 commit，讓對照組成為唯一的失敗原因）
clean_commit "對照組壞掉"
node -e "
const fs=require('fs');
const a=fs.readFileSync('scripts/precheck.mjs','utf8');const x=\"a: ['+' + 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0KLMN'],\";
if(a.split(x).length!==2)process.exit(9);fs.writeFileSync('.logs/precheck-broken.mjs',a.split(x).join(\"a: ['+not-a-token'],\"));
const b=fs.readFileSync('scripts/piiscan.mjs','utf8');const y='const ctrlLit = literalHits(';
if(b.split(y).length!==2)process.exit(9);fs.writeFileSync('.logs/piiscan-broken.mjs',b.split(y).join('const ctrlLit = 0 * literalHits('));" \
  || { echo "  ✗ 造不出壞掉的複本（錨點對不上）"; BAD=$((BAD + 1)); }
run "2a. 四類自查的對照組壞掉" 1 沒動 "(a) 金鑰／token：對照組命中 0 ✘" PRECHECK=.logs/precheck-broken.mjs
run "2b. 第五類的對照組壞掉" 1 沒動 "判準 (1) 黑名單：對照組 正例 0" PIISCAN=.logs/piiscan-broken.mjs
mv .private/pii-blacklist.txt .private/pii-blacklist.moved
run "2c. 黑名單檔不見" 1 沒動 "找不到黑名單檔"
mv .private/pii-blacklist.moved .private/pii-blacklist.txt
reset_to_remote

# 3. 推送被拒
printf '#!/bin/sh\nexit 1\n' > "$T/remote.git/hooks/pre-receive"; chmod +x "$T/remote.git/hooks/pre-receive"
clean_commit "推送被拒"
run "3. 推送被拒（pre-receive 回 1）" 2 沒動 "【第二關擋下】"
rm -f "$T/remote.git/hooks/pre-receive"
reset_to_remote

# 4. 推送回報成功、遠端卻沒更新
printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/main "$old"; done\n' > "$T/remote.git/hooks/post-receive"
chmod +x "$T/remote.git/hooks/post-receive"
clean_commit "推了卻沒更新"
run "4. 推了卻沒更新（post-receive 退回舊值）" 3 沒動 "【第三關擋下】"
rm -f "$T/remote.git/hooks/post-receive"
reset_to_remote

# 5. 全部正常
clean_commit "全部正常"
run "5. 全部正常" 0 等於本機 "【放行】三關都過"

echo "推送閘門驗法：$OK 種符合、$BAD 種不符合"
[ "$BAD" -eq 0 ]
