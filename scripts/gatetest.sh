#!/usr/bin/env bash
# 推送閘門的驗法（共用慣例 §2.5）：用實際推送的那一整行，分別製造每一關的失敗。**不碰 GitHub。**
#
#   bash scripts/gatetest.sh
#   GATETEST_ORDER="5 11 10 9 …" bash scripts/gatetest.sh     （換順序跑；每一種的結論要一樣）
#
# 做法：在暫存目錄建一個 bare repo 當假遠端，把本 repo **已 commit 的內容**複製一份過去跑閘門
# （所以改過閘門要先在本機 commit、再跑這支）。
#   · 推送被拒          → 假遠端放一個回傳 1 的 pre-receive
#   · 推了卻沒更新      → 假遠端放一個把 main 退回舊值的 post-receive
#   · 自查命中          → 在複本裡 commit 一個當場組出來的合成樣本
#   · 對照組壞掉        → 把檢查器的對照樣本換掉的複本（放在複本 repo 底下，檢查器靠自己的位置推算根目錄）
#   · 改過沒重跑驗法    → 在複本裡改閘門一行並 commit（登記對不上）；或拿掉登記檔
# 黑名單用一個**合成字面**的檔（真的黑名單是個資，不複製過去）。
# 每一種都檢查三件事：閘門的回傳值、假遠端的 main 有沒有被動到、輸出裡講的是不是對的那一關。
#
# **驗法登記（閘門第零關，2026-09-24，SPEC_檢查器修補 S7）**：一開跑就刪掉本 repo 的 .logs/gate-verified.txt；
# 全部符合，才把六支檔案**已 commit 版本**（＝複本裡驗的那一份）的雜湊寫回去。沒全過、中途出錯，登記就不在，閘門回 4。
#
# 每一種情境是獨立的函式，開頭一律還原（假遠端的 hook、黑名單檔、登記、本機分支），所以順序可以換；
# 以前情境 1b 疊在情境 1 的 commit 上、2a 與 2b 共用同一份壞掉的複本，換順序結論就會變。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REG_ROOT="$ROOT/.logs/gate-verified.txt"
mkdir -p "$ROOT/.logs"
rm -f "$REG_ROOT"   # 這一次沒全過，就不能留著上一次的登記
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

# 驗的是複本裡這六支（＝本 repo 已 commit 的版本）。先把雜湊記下來：全部符合時登記的就是這一份。
GATE_FILES="scripts/gatepush.sh scripts/precheck.mjs scripts/piiscan.mjs scripts/gatetest.sh scripts/gatereason.mjs scripts/buildverify.mjs"
REG_CONTENT=""
for f in $GATE_FILES; do
  h="$(git hash-object "$f")" || { echo "算不出 $f 的雜湊"; exit 1; }
  REG_CONTENT="${REG_CONTENT}${f} ${h}"$'\n'
done
register_work() { printf '%s' "$REG_CONTENT" > .logs/gate-verified.txt; }

remote_sha() { git --git-dir="$T/remote.git" rev-parse main; }
reset_to_remote() { git reset -q --hard "$(remote_sha)"; }
die() { echo "  ✗ 驗法本身出錯：$1"; exit 1; }
clean_commit() { printf '%s\n' "$1" >> gatetest-note.md; git add gatetest-note.md; git commit -q -m "gatetest：$1" || die "commit 失敗（$1）"; }
# 每一種情境開頭都跑這個：拿掉假遠端的 hook、黑名單放回原位、重新登記、本機分支對齊假遠端、清掉上一種留下的檔
prep() {
  rm -f "$T/remote.git/hooks/pre-receive" "$T/remote.git/hooks/post-receive"
  if [ -f .private/pii-blacklist.moved ]; then mv .private/pii-blacklist.moved .private/pii-blacklist.txt; fi
  reset_to_remote
  git clean -fdq -e .private -e .logs
  rm -f .logs/precheck-broken.mjs .logs/piiscan-broken.mjs .logs/build-verified.txt
  register_work
}

OK=0
BAD=0
# 比對「是誰、為什麼擋的」—— 只在錯誤訊息的位置比（scripts/gatereason.mjs；2026-09-24，補充說明（四）第 1 點）：
# 以前在整份輸出裡找一句話；自查會把命中內容原樣印出來、每一類都印標頭，「出現過」不等於「是理由」。
# 規格兩種：hit|<類別>|<來源>|<內容>（那一類的標頭寫著目標命中 ✘，底下的命中行有這一行）、head|<開頭>（從行首起）。
# 它自己要有對照組（§5.11 第二層），兩個方向：只出現在別處 → 不算；出現在錯誤訊息的位置 → 算。
reason() { node scripts/gatereason.mjs "$1" "$2"; }
node scripts/gatereason.mjs --selftest || { echo "  ✗ （對照）比對擋下理由的程式壞了 —— 後面每一種情境的「是誰擋的」都不可信"; exit 1; }

NOT=""   # 設了的話：輸出裡**不能**出現這一句（run 用完就清掉）
run() {
  # run <情境> <預期回傳值> <假遠端應該：沒動|等於本機> <理由的規格（證明是「對的那一關、對的那一類」擋下；見 gatereason.mjs）> [環境變數…]
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
  reason "$T/out.txt" "$must" || good=0
  local extra=""
  if [ -n "$NOT" ] && reason "$T/out.txt" "$NOT"; then good=0; extra="，輸出裡不該有「$NOT」卻有"; fi
  NOT=""
  local verdict
  verdict="$(grep -E '^【' "$T/out.txt")"
  if [ "$good" -eq 1 ]; then OK=$((OK + 1)); echo "  ✓ $name：回傳 $code（預期 $want），假遠端$moved｜$verdict"
  else BAD=$((BAD + 1)); echo "  ✗ $name：回傳 $code（預期 $want），假遠端$moved（應該$remote_should），輸出裡要有「$must」$extra｜$verdict"; fi
}

TOK="gh""p_A1b2C3d4E5f6G7h8I9j0KLMN"
token_commit() { printf 'const k = "%s";\n' "$TOK" > "$1"; git add "$1"; git commit -q -m "gatetest：合成 token（$1）" || die "commit 失敗（$1）"; }

# 1. 自查命中：HEAD 帶一個合成 token（拆開拼，這支檔自己才不會被自查抓到）
sc_1() {
  token_commit gatetest-fake.js
  run "1. 自查命中（HEAD 帶合成 token）" 1 沒動 "hit|(a) 金鑰／token|新增行|const k ="
}
# 1b. 命中在較早的 commit、HEAD 是乾淨的 —— 以前只掃 HEAD 會漏掉這種
sc_1b() {
  token_commit gatetest-fake.js
  clean_commit "命中之後又疊一個乾淨的"
  run "1b. 命中在較早的 commit（HEAD 乾淨）" 1 沒動 "hit|(a) 金鑰／token|新增行|const k ="
}
# 2. 對照組壞掉（乾淨的 commit，讓對照組成為唯一的失敗原因）
make_broken() {
  node -e "
const fs=require('fs');
const a=fs.readFileSync('scripts/precheck.mjs','utf8');const x=\"a: ['+' + 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0KLMN'],\";
if(a.split(x).length!==2)process.exit(9);fs.writeFileSync('.logs/precheck-broken.mjs',a.split(x).join(\"a: ['+not-a-token'],\"));
const b=fs.readFileSync('scripts/piiscan.mjs','utf8');const y='const ctrlLit = literalHits(';
if(b.split(y).length!==2)process.exit(9);fs.writeFileSync('.logs/piiscan-broken.mjs',b.split(y).join('const ctrlLit = 0 * literalHits('));" \
    || die "造不出壞掉的複本（錨點對不上）"
}
sc_2a() {
  clean_commit "對照組壞掉"; make_broken
  run "2a. 四類自查的對照組壞掉" 1 沒動 "head|(a) 金鑰／token：對照組命中 0 ✘" PRECHECK=.logs/precheck-broken.mjs
}
sc_2b() {
  clean_commit "對照組壞掉"; make_broken
  run "2b. 第五類的對照組壞掉" 1 沒動 "head|判準 (1) 黑名單：對照組 正例 0" PIISCAN=.logs/piiscan-broken.mjs
}
sc_2c() {
  clean_commit "黑名單檔拿走"
  [ -s .private/pii-blacklist.txt ] || die "情境 2c：黑名單檔原本就不在，前提沒造成"
  mv .private/pii-blacklist.txt .private/pii-blacklist.moved
  run "2c. 黑名單檔不見" 1 沒動 "head|第五類：找不到黑名單檔"
}
# 3. 推送被拒
sc_3() {
  printf '#!/bin/sh\nexit 1\n' > "$T/remote.git/hooks/pre-receive"; chmod +x "$T/remote.git/hooks/pre-receive"
  clean_commit "推送被拒"
  run "3. 推送被拒（pre-receive 回 1）" 2 沒動 "head|【第二關擋下】"
}
# 4. 推送回報成功、遠端卻沒更新
sc_4() {
  printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/main "$old"; done\n' > "$T/remote.git/hooks/post-receive"
  chmod +x "$T/remote.git/hooks/post-receive"
  clean_commit "推了卻沒更新"
  run "4. 推了卻沒更新（post-receive 退回舊值）" 3 沒動 "head|【第三關擋下】"
}
# 5. 全部正常
sc_5() {
  clean_commit "全部正常"
  run "5. 全部正常" 0 等於本機 "head|【放行】三關都過"
}
# 6. 本機以為已經推上去、遠端其實沒有（共用慣例 v8 §2.5「自查的範圍要照遠端的實際狀態算」）
# 因果：第三關攔到「推了沒更新」之後，本機的追蹤分支與 FETCH_HEAD 都已經指著那個 commit；
# 自查範圍若照本機的認定算，那個 commit 落在範圍外，下一次推送就不經檢查被帶出去。
# 本閘門用推送前當場 fetch 的 FETCH_HEAD 算範圍，只撥本機追蹤分支造不出前提，所以照工單的造法：
# 帶命中的 commit 繞過閘門直接推上假遠端、抓回來，再把假遠端倒退。
sc_6() {
  local base hit
  base="$(remote_sha)"
  token_commit gatetest-fake6.js
  hit="$(git rev-parse HEAD)"
  git push -q origin main || die "情境 6：繞過閘門推上假遠端失敗"
  git fetch -q origin main || die "情境 6：抓回來失敗"
  git --git-dir="$T/remote.git" update-ref refs/heads/main "$base" || die "情境 6：把假遠端倒退失敗"
  [ "$(remote_sha)" = "$base" ] || die "情境 6：假遠端沒有退回原本的 main"
  [ "$(git rev-parse FETCH_HEAD)" = "$hit" ] || die "情境 6：本機的 FETCH_HEAD 沒有指著帶命中的 commit，前提沒造成"
  clean_commit "本機以為已推上去，再疊一個乾淨的"
  run "6. 本機以為已推上去、遠端其實沒有（帶命中的在前、HEAD 乾淨）" 1 沒動 "hit|(a) 金鑰／token|新增行|const k ="
  if git --git-dir="$T/remote.git" merge-base --is-ancestor "$hit" main 2> /dev/null; then
    echo "    · 帶命中的 commit 已經在假遠端上（閘門放行了它）"
  else
    echo "    · 帶命中的 commit 不在假遠端上"
  fi
}
# 7. 命中只出現在 commit 訊息（沒有任何新增行）—— 2026-09-24 以前自查只掃新增行，這種會放行（v8 §2.5「自查的範圍」）
sc_7() {
  git commit -q --allow-empty -m "gatetest：合成 token 只放在訊息裡 $TOK" || die "commit 失敗（情境 7）"
  run "7. 命中只出現在 commit 訊息" 1 沒動 "hit|(a) 金鑰／token|commit 訊息／作者|+gatetest：合成 token 只放在訊息裡"
}
# 7b. 命中只出現在作者信箱（真實信箱樣式、不是 noreply）；信箱拆開拼，這支檔自己才不會被自查抓到
sc_7b() {
  local fake_mail="someone""@""example.com"
  git -c user.email="$fake_mail" commit -q --allow-empty -m "gatetest：作者信箱不是 noreply" || die "commit 失敗（情境 7b）"
  run "7b. 命中只出現在作者信箱" 1 沒動 "hit|(b) email（noreply 不算）|commit 訊息／作者|+作者："
}
# 8. 內容以 `++` 開頭的命中行，而且先加、下一個 commit 又刪掉（2026-09-24）
# 以前抽新增行用「以 + 開頭、但不是 +++」：`++` 開頭的內容加上 diff 的 `+` 變成 `+++…`，被當成檔頭丟掉。
# 先加再刪：兩端比起來什麼都沒變，只有逐個 commit 掃新增行才抓得到。
sc_8() {
  printf '++ const k = "%s";\n' "$TOK" > gatetest-pp.txt; git add gatetest-pp.txt
  git commit -q -m "gatetest：++ 開頭的命中行" || die "commit 失敗（情境 8 加）"
  git rm -q gatetest-pp.txt; git commit -q -m "gatetest：又刪掉" || die "commit 失敗（情境 8 刪）"
  run "8. ++ 開頭的命中行（先加再刪）" 1 沒動 "hit|(a) 金鑰／token|新增行|+++ const k ="
}
# 9. 只刪不增的正常推送要放行（兩種數法都是 0 行；不能把「抽出 0 行」一律當失敗）
sc_9() {
  local last
  last="$(git ls-files | grep -m1 -E '^docs/.*\.md$')"
  [ -n "$last" ] || die "情境 9：找不到可以刪的檔"
  git rm -q "$last"; git commit -q -m "gatetest：只刪不增" || die "commit 失敗（情境 9）"
  # 前置不接管線：git show 失敗時 awk 照樣印 0，前置就會默默通過
  git show --numstat --format= HEAD > "$T/ns9.txt" || die "情境 9：讀不到 numstat"
  [ -s "$T/ns9.txt" ] && [ "$(awk '{s+=$1} END {print s+0}' "$T/ns9.txt")" = "0" ] || die "情境 9：這個 commit 不是只刪不增，前提沒造成"
  run "9. 只刪不增的正常推送" 0 等於本機 "head|四類自查：FETCH_HEAD..refs/heads/main，新增行 0 行"
}
# 10. 閘門改過一行、沒重跑驗法（登記對不上）→ 回 4，停在第零關：連 fetch 與自查都沒跑
sc_10() {
  printf '# gatetest：改過一行、沒重跑驗法\n' >> scripts/gatepush.sh
  git add scripts/gatepush.sh; git commit -q -m "gatetest：改閘門一行" || die "commit 失敗（情境 10）"
  [ "$(git hash-object scripts/gatepush.sh)" != "$(awk '$1 == "scripts/gatepush.sh" { print $2 }' .logs/gate-verified.txt)" ] \
    || die "情境 10：改完閘門，雜湊還跟登記一樣，前提沒造成"
  NOT="head|(a) 金鑰／token"
  run "10. 閘門改過、沒重跑驗法" 4 沒動 "head|【第零關擋下】改過之後還沒跑過驗法：scripts/gatepush.sh"
}
# 11. 沒有登記檔（新 clone、剛改完、或上次驗法沒全過）→ 回 4
sc_11() {
  clean_commit "沒有登記檔"
  [ -s .logs/gate-verified.txt ] || die "情境 11：登記檔原本就不在，前提沒造成"
  rm .logs/gate-verified.txt
  NOT="head|(a) 金鑰／token"
  run "11. 沒有登記檔" 4 沒動 "head|【第零關擋下】沒有驗法登記"
}

# 12 系列：F9 的 build 驗法登記（2026-09-24，統籌者新訂）。這次要推的 commit 動到 build 或它的驗法 → 要有對得上的登記，否則回 5。
# 登記直接照 buildverify.mjs 的格式寫（這裡驗的是閘門怎麼比對；登記怎麼寫由 scripts/buildverifytest.mjs 驗）。
BUILD_FILES="$(node --input-type=module -e "import { GUARDED } from './scripts/buildverify.mjs'; console.log(GUARDED.join(' '))")" \
  || { echo "讀不到 buildverify.mjs 的 GUARDED"; exit 1; }
[ -n "$BUILD_FILES" ] || { echo "buildverify.mjs 的 GUARDED 是空的"; exit 1; }
build_reg() {   # build_reg <commit>：把那一版被守的檔登記成驗過
  local c="$1" f h
  { echo "commit $c"; for f in $BUILD_FILES; do h="$(git rev-parse "$c:$f")" || die "算不出 $c:$f"; echo "$f $h"; done; } > .logs/build-verified.txt
}
touch_build() { printf '// gatetest：%s\n' "$1" >> scripts/buildguard.mjs; git add scripts/buildguard.mjs; git commit -q -m "gatetest：$1" || die "commit 失敗（$1）"; }
# 12. 動到 build、沒有登記 → 回 5，停在自查之前
sc_12() {
  [ ! -e .logs/build-verified.txt ] || die "情境 12：build 登記原本就在，前提沒造成"
  touch_build "改 build、沒有登記"
  NOT="head|(a) 金鑰／token"
  run "12. 動到 build、沒有 build 驗法登記" 5 沒動 "head|【F9 擋下】這次要推的 commit 動到 scripts/buildguard.mjs，但沒有 build 驗法登記"
}
# 12b. 前一個 commit 動到 build、最後一個乾淨，登記是改之前那一版 → 仍要擋（只看最後一個 commit 會漏；MealMate 補的）
sc_12b() {
  build_reg "$(git rev-parse HEAD)"
  touch_build "改 build"
  clean_commit "改 build 之後又疊一個乾淨的"
  [ -z "$(git diff --name-only HEAD~1 HEAD -- $BUILD_FILES)" ] || die "情境 12b：最後一個 commit 也動到 build，前提沒造成"
  NOT="head|(a) 金鑰／token"
  run "12b. 前一個 commit 動到 build、最後一個乾淨、登記是舊版" 5 沒動 "head|【F9 擋下】build 驗法登記跟要推的版本對不上：scripts/buildguard.mjs"
}
# 12c. 動到 build、登記對得上要推的版本 → 放行
sc_12c() {
  touch_build "改 build、有對得上的登記"
  build_reg "$(git rev-parse HEAD)"
  run "12c. 動到 build、登記對得上" 0 等於本機 "head|F9：這次要推的 commit 動到 scripts/buildguard.mjs，build 驗法登記相符"
}
# 12d. 沒動到 build、也沒有登記 → 不看登記，放行（不是每次推送都要跑 buildtest）
sc_12d() {
  [ ! -e .logs/build-verified.txt ] || die "情境 12d：build 登記原本就在，前提沒造成"
  clean_commit "沒動到 build"
  run "12d. 沒動到 build、沒有登記" 0 等於本機 "head|F9：這次要推的 1 個 commit 沒動到 build 與它的驗法，不看登記"
}

ALL="1 1b 2a 2b 2c 3 4 6 7 7b 8 9 10 11 12 12b 12c 12d 5"
ORDER="${GATETEST_ORDER:-$ALL}"
# 順序清單要恰好是每一種各一次：少一種就少驗一種，多一種就是打錯字
SORTED_ALL="$(printf '%s\n' $ALL | sort)"
SORTED_ORDER="$(printf '%s\n' $ORDER | sort)"
[ "$SORTED_ALL" = "$SORTED_ORDER" ] || { echo "驗法的順序清單不是恰好每一種各一次：$ORDER"; exit 1; }

echo "推送閘門驗法：假遠端 ＝ 暫存目錄裡的 bare repo，閘門＝ $(git log --oneline -1 -- scripts/gatepush.sh)；順序：$ORDER"
# 被執行的那一份閘門的內容雜湊（§5.11 第三層）：驗「改壞的閘門」時，拿它跟改壞的那一份比，
# 確認跑的真的是改壞的那一版，不是複本、分支或路徑弄錯而跑到好的那一版
echo "被執行的閘門檔案雜湊：$(git hash-object scripts/gatepush.sh)"
echo "被執行的四類自查雜湊：$(git hash-object scripts/precheck.mjs)"

for s in $ORDER; do prep; "sc_$s"; done

echo "推送閘門驗法：$OK 種符合、$BAD 種不符合"
set -- $ALL
if [ "$BAD" -eq 0 ] && [ "$OK" -eq "$#" ]; then
  printf '%s' "$REG_CONTENT" > "$REG_ROOT" || { echo "寫不進驗法登記"; exit 1; }
  echo "驗法登記：已寫入 .logs/gate-verified.txt（六支檔案已 commit 版本的雜湊）"
  exit 0
fi
echo "驗法登記：沒有寫入（沒全部符合）——閘門第零關會擋下推送"
exit 1
