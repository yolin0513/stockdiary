// 推送閘門驗法的「擋下理由」比對（gatetest.sh 用；2026-09-24，補充說明（四）第 1 點）。
//
// 為什麼：以前 gatetest 在閘門的**整份輸出**裡找一句話（grep -F）。自查會把命中的內容原樣印出來、
// 每一類都印一行標頭——那句話「出現過」不代表它就是擋下的理由：例如 token 被 (b) 類抓到時，命中行照樣會印出來，
// 只數有沒有出現，就驗不到「是 (a) 類擋的」。JLPT、統籌者的驗法都中過同一種。
// 現在只在兩種位置比對：
//   hit|<類別>|<來源>|<內容>   在「<類別>：…目標命中 N ✘」（N ≥ 1）那一行底下、縮排的命中行裡，
//                              要有一行是「    [<來源>] …<內容>…」
//   head|<開頭>                某一行**從行首起**就是 <開頭>（判決行【…】、對照組壞掉的標頭、第五類的錯誤訊息）
// 用法：node scripts/gatereason.mjs <輸出檔> <規格>   回 0＝對得上、1＝對不上、2＝規格寫錯
//       node scripts/gatereason.mjs --selftest         兩個方向的對照組，回 0＝全部符合

import fs from 'node:fs';

/** 一份輸出、一條規格 → true／false。規格寫錯拋錯。 */
export function reasonHolds(out, spec) {
  const lines = String(out).split('\n').map((l) => l.replace(/\r$/, ''));
  const parts = spec.split('|');
  if (parts[0] === 'head' && parts.length === 2 && parts[1]) {
    // 對邊界：開頭若以檔名、編號這類字元收尾，下一個字元不能還是同一類（scripts/gatepush.sh 不能被 scripts/gatepush.sh.orig 湊到）
    const p = parts[1];
    const idTail = /[\w.-]$/.test(p);
    return lines.some((l) => l.startsWith(p) && !(idTail && /[\w.-]/.test(l[p.length] ?? '')));
  }
  if (parts[0] === 'hit' && parts.length === 4 && parts[1] && parts[2] && parts[3]) {
    const [, cat, src, text] = parts;
    for (let i = 0; i < lines.length; i += 1) {
      const m = /目標命中 (\d+) ✘$/.exec(lines[i]);
      if (!lines[i].startsWith(`${cat}：`) || !m || Number(m[1]) < 1) continue;
      for (let j = i + 1; j < lines.length && lines[j].startsWith('    '); j += 1) {
        if (lines[j].startsWith(`    [${src}] `) && lines[j].includes(text)) return true;
      }
    }
    return false;
  }
  throw new Error(`規格寫錯：${spec}`);
}

/** 兩個方向的對照組：[說明, 輸出, 規格, 應該對得上嗎]。 */
export function selftest() {
  const OUT = [
    '四類自查：FETCH_HEAD..refs/heads/main，新增行 1 行＋commit 訊息與作者 2 行',
    '(a) 金鑰／token：對照組命中 1 ✔｜目標命中 0 ✔',
    '(b) email（noreply 不算）：對照組命中 1 ✔｜目標命中 1 ✘',
    '    [新增行] +const k = "合成"',
    '    [commit 訊息／作者] +作者：someone',
    '四類自查：未通過',
    '說明：這一行提到【第二關擋下】但不是判決行',
    '【第一關擋下】公開前自查沒過（四類 precheck=1、第五類 piiscan=0），不推',
  ].join('\n');
  const cases = [
    ['命中行出現在 (b) 類底下，問 (a) 類 → 不算', OUT, 'hit|(a) 金鑰／token|新增行|const k =', false],
    ['同一行，問 (b) 類 → 算', OUT, 'hit|(b) email（noreply 不算）|新增行|const k =', true],
    ['來源對不上（問 commit 訊息，命中在新增行）→ 不算', OUT, 'hit|(b) email（noreply 不算）|commit 訊息／作者|const k =', false],
    ['作者欄的命中在 (b) 類底下 → 算', OUT, 'hit|(b) email（noreply 不算）|commit 訊息／作者|+作者：', true],
    ['判決行只出現在行中間 → 不算', OUT, 'head|【第二關擋下】', false],
    ['判決行從行首起 → 算', OUT, 'head|【第一關擋下】', true],
    ['(a) 類標頭是「目標命中 0 ✔」，問「對照組命中 1 ✔｜目標命中 1」的開頭 → 不算', OUT, 'head|(a) 金鑰／token：對照組命中 1 ✔｜目標命中 1', false],
    ['空的輸出 → 不算', '', 'head|【第一關擋下】', false],
    ['檔名只湊到前半（scripts/gatepush.sh 對上 scripts/gatepush.sh.orig）→ 不算',
      '【第零關擋下】改過之後還沒跑過驗法：scripts/gatepush.sh.orig（雜湊對不上）', 'head|【第零關擋下】改過之後還沒跑過驗法：scripts/gatepush.sh', false],
    ['檔名後面接的是標點 → 算',
      '【第零關擋下】改過之後還沒跑過驗法：scripts/gatepush.sh（雜湊對不上）', 'head|【第零關擋下】改過之後還沒跑過驗法：scripts/gatepush.sh', true],
  ];
  return cases.map(([name, out, spec, want]) => ({ name, ok: reasonHolds(out, spec) === want }));
}

if (process.argv[1] && process.argv[1].endsWith('gatereason.mjs')) {
  if (process.argv[2] === '--selftest') {
    const r = selftest();
    for (const c of r) console.log(`  ${c.ok ? '✓' : '✗'} （對照）擋下理由的比對：${c.name}`);
    process.exit(r.length >= 10 && r.every((c) => c.ok) ? 0 : 1);
  }
  const [file, spec] = process.argv.slice(2);
  let out;
  try { out = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`讀不到輸出檔：${e.message}`); process.exit(2); }
  try { process.exit(reasonHolds(out, spec) ? 0 : 1); } catch (e) { console.error(e.message); process.exit(2); }
}
