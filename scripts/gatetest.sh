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
# 比對「輸出裡有沒有這一句」—— 每一種情境都靠它判斷是誰擋的，所以它自己也要有對照組（§5.11 第二層）：
# 它若抓空，「比對是誰擋的」就默默退化成只剩回傳值。
has() { grep -qF -- "$2" "$1"; }
printf '%s\n' '(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1 ✘' '【第一關擋下】公開前自查沒過（四類 precheck=1、第五類 piiscan=0），不推' > "$T/ctrl.txt"
if has "$T/ctrl.txt" "(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1" && has "$T/ctrl.txt" "【第一關擋下】" \
   && ! has "$T/ctrl.txt" "【第三關擋下】" && ! has "$T/ctrl.txt" "找不到黑名單檔"; then
  echo "  ✓ （對照）比對擋下原因的那段程式：已知的輸出抓得到該抓的兩句，也不會把沒出現的句子當成有"
else
  echo "  ✗ （對照）比對擋下原因的那段程式壞了 —— 後面每一種情境的「是誰擋的」都不可信"; exit 1
fi

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
  has "$T/out.txt" "$must" || good=0
  local verdict
  verdict="$(grep -E '^【' "$T/out.txt")"
  if [ "$good" -eq 1 ]; then OK=$((OK + 1)); echo "  ✓ $name：回傳 $code（預期 $want），假遠端$moved｜$verdict"
  else BAD=$((BAD + 1)); echo "  ✗ $name：回傳 $code（預期 $want），假遠端$moved（應該$remote_should），輸出裡要有「$must」｜$verdict"; fi
}

echo "推送閘門驗法：假遠端 ＝ 暫存目錄裡的 bare repo，閘門＝ $(git log --oneline -1 -- scripts/gatepush.sh)"
# 被執行的那一份閘門的內容雜湊（§5.11 第三層）：驗「改壞的閘門」時，拿它跟改壞的那一份比，
# 確認跑的真的是改壞的那一版，不是複本、分支或路徑弄錯而跑到好的那一版
echo "被執行的閘門檔案雜湊：$(git hash-object scripts/gatepush.sh)"
echo "被執行的四類自查雜湊：$(git hash-object scripts/precheck.mjs)"

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

# 6. 本機以為已經推上去、遠端其實沒有（共用慣例 v8 §2.5「自查的範圍要照遠端的實際狀態算」）
# 因果：第三關攔到「推了沒更新」之後，本機的追蹤分支與 FETCH_HEAD 都已經指著那個 commit；
# 自查範圍若照本機的認定算，那個 commit 落在範圍外，下一次推送就不經檢查被帶出去。
# 本閘門用推送前當場 fetch 的 FETCH_HEAD 算範圍，只撥本機追蹤分支造不出前提，所以照工單的造法：
# 帶命中的 commit 繞過閘門直接推上假遠端、抓回來，再把假遠端倒退。
BASE="$(remote_sha)"
printf 'const k = "%s";\n' "$TOK" > gatetest-fake6.js; git add gatetest-fake6.js
git commit -q -m "gatetest：合成 token（本機以為已推上去）" || die "commit 失敗（情境 6 的合成 token）"
HIT6="$(git rev-parse HEAD)"
git push -q origin main || die "情境 6：繞過閘門推上假遠端失敗"
git fetch -q origin main || die "情境 6：抓回來失敗"
git --git-dir="$T/remote.git" update-ref refs/heads/main "$BASE" || die "情境 6：把假遠端倒退失敗"
[ "$(remote_sha)" = "$BASE" ] || die "情境 6：假遠端沒有退回 BASE"
[ "$(git rev-parse FETCH_HEAD)" = "$HIT6" ] || die "情境 6：本機的 FETCH_HEAD 沒有指著帶命中的 commit，前提沒造成"
clean_commit "本機以為已推上去，再疊一個乾淨的"
run "6. 本機以為已推上去、遠端其實沒有（帶命中的在前、HEAD 乾淨）" 1 沒動 "(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1"
if git --git-dir="$T/remote.git" merge-base --is-ancestor "$HIT6" main 2> /dev/null; then
  echo "    · 帶命中的 commit 已經在假遠端上（閘門放行了它）"
else
  echo "    · 帶命中的 commit 不在假遠端上"
fi
reset_to_remote

# 7. 命中只出現在 commit 訊息（沒有任何新增行）—— 2026-09-24 以前自查只掃新增行，這種會放行（v8 §2.5「自查的範圍」）
git commit -q --allow-empty -m "gatetest：合成 token 只放在訊息裡 $TOK" || die "commit 失敗（情境 7）"
run "7. 命中只出現在 commit 訊息" 1 沒動 "[commit 訊息／作者] +gatetest：合成 token 只放在訊息裡"
reset_to_remote
# 7b. 命中只出現在作者信箱（真實信箱樣式、不是 noreply）；信箱拆開拼，這支檔自己才不會被自查抓到
FAKE_MAIL="someone""@""example.com"
git -c user.email="$FAKE_MAIL" commit -q --allow-empty -m "gatetest：作者信箱不是 noreply" || die "commit 失敗（情境 7b）"
run "7b. 命中只出現在作者信箱" 1 沒動 "[commit 訊息／作者] +作者："
reset_to_remote

# 8. 內容以 `++` 開頭的命中行，而且先加、下一個 commit 又刪掉（2026-09-24）
# 以前抽新增行用「以 + 開頭、但不是 +++」：`++` 開頭的內容加上 diff 的 `+` 變成 `+++…`，被當成檔頭丟掉。
# 先加再刪：兩端比起來什麼都沒變，只有逐個 commit 掃新增行才抓得到。
printf '++ const k = "%s";\n' "$TOK" > gatetest-pp.txt; git add gatetest-pp.txt
git commit -q -m "gatetest：++ 開頭的命中行" || die "commit 失敗（情境 8 加）"
git rm -q gatetest-pp.txt; git commit -q -m "gatetest：又刪掉" || die "commit 失敗（情境 8 刪）"
run "8. ++ 開頭的命中行（先加再刪）" 1 沒動 "[新增行] +++ const k ="
reset_to_remote
# 9. 只刪不增的正常推送要放行（兩種數法都是 0 行；不能把「抽出 0 行」一律當失敗）
LAST="$(git ls-files | grep -m1 -E '^docs/.*\.md$')"
[ -n "$LAST" ] || die "情境 9：找不到可以刪的檔"
git rm -q "$LAST"; git commit -q -m "gatetest：只刪不增" || die "commit 失敗（情境 9）"
# 前置不接管線：git show 失敗時 awk 照樣印 0，前置就會默默通過
git show --numstat --format= HEAD > "$T/ns9.txt" || die "情境 9：讀不到 numstat"
[ -s "$T/ns9.txt" ] && [ "$(awk '{s+=$1} END {print s+0}' "$T/ns9.txt")" = "0" ] || die "情境 9：這個 commit 不是只刪不增，前提沒造成"
run "9. 只刪不增的正常推送" 0 等於本機 "新增行 0 行"
reset_to_remote

# 5. 全部正常
clean_commit "全部正常"
run "5. 全部正常" 0 等於本機 "【放行】三關都過"

echo "推送閘門驗法：$OK 種符合、$BAD 種不符合"
[ "$BAD" -eq 0 ]
