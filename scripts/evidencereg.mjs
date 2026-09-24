// scripts/evidence/ 的登記（2026-09-24，Dispatch：量舊版數字的腳本收進 repo，列進孤兒檢查的登記）。
//
// 那一批是量「修正前」的一次性腳本：對明確的舊 commit 量一次，數字寫進證據檔。**不在任何測試鏈裡、也不必每版跑**——
// 舊版不會再變；新版的行為由常設的測試與突變守著（證據檔「盤點」一節逐項列了由誰守）。收進 repo 是為了「做法可以重做」。
//
// 每一支都要在下面登記：用途、比哪兩個版本、數字寫在證據檔哪一段（那一段的開頭字面，doctest 會確認它真的在證據檔裡）。
// 檔頭那一行由登記產生（headerOf），doctest 比對檔頭＝登記；目錄裡多一支沒登記的、登記了卻不在的，都報。

export const EVIDENCE_DOC = 'docs/EVIDENCE_檢查器修補.md';
export const WHY_UNGUARDED = '不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）';

const helper = (what) => ({ what, compare: '不適用（共用的小工具，被同目錄的量測腳本呼叫）', section: '## 盤點：哪些有常設情境守著' });
export const EVIDENCE_SCRIPTS = {
  'f8old.sh': { what: 'F8 三支 build 的舊版矩陣數字', compare: '77b026d／3cf33ae／04b205e（修正前）vs 矩陣版 buildtest', section: '**F8：三支 build 資料變少照樣寫檔' },
  'b5old.sh': { what: '範圍外第 5 件（後來的 F8）第一版的修正前', compare: '77b026d vs 3cf33ae', section: '**第 5 件已做**' },
  'p1ev.mjs': { what: '補充說明（四）第 1 點的修正前（理由在整份輸出裡找）', compare: '3e7b009 的 gatetest.sh vs 新驗法', section: '**補充說明（四）第 1 點' },
  'collate.mjs': { what: '判定改嚴時「多紅了別組」的逐條清單（27 條）', compare: '舊判定（只要一條對上 expect）vs 新判定（只紅對應的那一種）', section: '**判定器：突變要「只紅對應的那一種」' },
  's3ev.sh': { what: 'S3 assertaudit 的修正前', compare: '84e3999 vs 4e74c86', section: '**S3 `assertaudit` 判斷邏輯的必敗對照組' },
  's3ev2.sh': { what: 'S3 修正前（兩支測試、一支崩掉的版本）', compare: '84e3999 vs 4e74c86', section: '**S3 `assertaudit` 判斷邏輯的必敗對照組' },
  's4ev.sh': { what: 'S4 sweep 的修正前', compare: '84e3999 vs cb81089', section: '**S4 `sweep` 的合成對照組' },
  's4each.mjs': { what: 'S4 逐條突變紅了哪幾組（s4ev.sh 呼叫）', compare: 'cb81089 上逐條套突變', section: '**S4 `sweep` 的合成對照組' },
  's5ev.sh': { what: 'S5 gatescan／assertaudit 孤兒檢查的修正前', compare: 'cb81089 vs e8245a3', section: '**S5 兩份清單的孤兒檢查' },
  's5ev2.sh': { what: 'S5 修正前（taptest 在稽核下的那一段）', compare: 'cb81089 vs e8245a3', section: '**S5 兩份清單的孤兒檢查' },
  's6ev.sh': { what: 'S6 livecheck 的修正前', compare: 'cb81089 vs 6734a22', section: '**S6 `livecheck` 用錄好的回應當合成對照' },
  's6ev.mjs': { what: 'S6 本機假證交所（s6ev.sh 呼叫）', compare: 'cb81089 vs 6734a22', section: '**S6 `livecheck` 用錄好的回應當合成對照' },
  's7ev.sh': { what: 'S7 閘門第零關的修正前', compare: 'cb81089 vs 31cb4a9', section: '**S7 閘門第零關（驗法登記）與驗法可換順序' },
  'f1ev.mjs': { what: '範圍外第 1 件：三個 commit 對本機假證交所各跑一次', compare: '77b026d／3e77de1／1d0ba37', section: '**第 1 件已做**' },
  'f2ev.sh': { what: '範圍外第 2 件的修正前（livecheck 沒打 FMTQIK）', compare: '77b026d vs c0bc4db', section: '**第 2 件已做**' },
  'f3ev.sh': { what: '範圍外第 3 件的修正前（upgradecheck 只看兩頁）', compare: '77b026d vs 2b4aa09', section: '**第 3、4 件已做**' },
  'f3evB.sh': { what: '範圍外第 3 件：§5.12 只拿掉其中一道', compare: '2b4aa09 上改壞一道', section: '**第 3、4 件已做**' },
  'f3evC.sh': { what: '範圍外第 3 件：§5.12 兩道一起拿掉', compare: '2b4aa09 上改壞兩道', section: '**第 3、4 件已做**' },
  'f34ev.sh': { what: '範圍外第 3、4 件：sweep 不看新路由', compare: '77b026d vs 2b4aa09', section: '**第 3、4 件已做**' },
  'patch.mjs': helper('共用：改一處（錨點要剛好一次）'),
  'each.mjs': helper('共用：逐條套突變、看紅了哪幾組'),
  'listdiff.mjs': helper('共用：比兩份清單（擴大母體沒有少挑）'),
  'epdiff.mjs': { what: '範圍外第 2 件：新舊兩種端點擷取樣式各跑一次', compare: 'S9 盤點用的樣式 vs livejudge 的樣式', section: '**第 2 件已做**' },
  'routediff.mjs': { what: '範圍外第 3、4 件：新舊路由清單比對', compare: '77b026d 的 sweep 清單 vs scripts/routes.mjs', section: '**第 3、4 件已做**' },
};

/** 檔頭那一行（.sh 放在 shebang 下一行，其他放第一行）。 */
export function headerOf(file, e) {
  const body = `【本質一次性，保留供重做】用途：${e.what}｜比較：${e.compare}｜數字在：${EVIDENCE_DOC}「${e.section}」｜${WHY_UNGUARDED}`;
  return file.endsWith('.sh') ? `# ${body}` : `// ${body}`;
}
/** 取出檔頭那一行：.sh 的第二行（第一行是 shebang 時），其他的第一行。 */
export function headerLineOf(file, text) {
  const lines = String(text).split('\n');
  return (file.endsWith('.sh') && lines[0].startsWith('#!') ? lines[1] : lines[0]) ?? '';
}

/**
 * 找問題（純函式）：files＝目錄裡實際的檔名；texts＝{檔名: 內容}；doc＝證據檔全文。
 * 回傳每一條問題的字串；空陣列＝沒問題。
 */
export function evidenceProblems({ files, texts, doc, registry = EVIDENCE_SCRIPTS }) {
  const out = [];
  for (const f of files) if (!(f in registry)) out.push(`沒登記：scripts/evidence/${f}`);
  for (const f of Object.keys(registry)) if (!files.includes(f)) out.push(`登記了卻不在：scripts/evidence/${f}`);
  for (const f of files.filter((x) => x in registry)) {
    const want = headerOf(f, registry[f]);
    if (headerLineOf(f, texts[f]) !== want) out.push(`檔頭跟登記不一樣：scripts/evidence/${f}`);
    if (!doc.includes(registry[f].section)) out.push(`證據檔裡找不到那一段：scripts/evidence/${f}「${registry[f].section}」`);
  }
  return out;
}
