// 測試用的預載模組（node --import scripts/testfetch.mjs …）：把 fetch 換掉，**不打網路**。
//   TESTFETCH_BODY=<檔>    每個請求都回這個檔的內容；TESTFETCH_STATUS 可指定狀態碼（預設 200）
//   沒設 TESTFETCH_BODY    任何請求都直接拋錯（訊息帶網址）——證明被測的腳本沒有打出去
// 給 scripts/buildtest.mjs 用。
//   TESTFS_RM_FAIL=1      刪 .tmp 結尾的檔一律丟 EPERM——造「清理也失敗」（Windows 上防毒或索引程式鎖檔就會這樣）
import fs from 'node:fs';

if (process.env.TESTFS_RM_FAIL) {
  for (const name of ['rmSync', 'unlinkSync']) {
    const orig = fs[name];
    fs[name] = (p, ...rest) => {
      if (String(p).endsWith('.tmp')) { const e = new Error(`EPERM：測試造的刪不掉（${p}）`); e.code = 'EPERM'; throw e; }
      return orig.call(fs, p, ...rest);
    };
  }
}

globalThis.fetch = async (url) => {
  const body = process.env.TESTFETCH_BODY;
  if (!body) throw new Error(`測試擋下了網路請求：${url}`);
  return new Response(fs.readFileSync(body), { status: Number(process.env.TESTFETCH_STATUS || 200) });
};
