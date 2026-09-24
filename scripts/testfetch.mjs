// 測試用的預載模組（node --import scripts/testfetch.mjs …）：把 fetch 換掉，**不打網路**。
//   TESTFETCH_BODY=<檔>    每個請求都回這個檔的內容；TESTFETCH_STATUS 可指定狀態碼（預設 200）
//   沒設 TESTFETCH_BODY    任何請求都直接拋錯（訊息帶網址）——證明被測的腳本沒有打出去
// 給 scripts/buildtest.mjs 用。
import fs from 'node:fs';

globalThis.fetch = async (url) => {
  const body = process.env.TESTFETCH_BODY;
  if (!body) throw new Error(`測試擋下了網路請求：${url}`);
  return new Response(fs.readFileSync(body), { status: Number(process.env.TESTFETCH_STATUS || 200) });
};
