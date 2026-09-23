// 「帶判斷意味」的禁用詞 —— 試算器、試算畫面、首頁成本說明共用**同一份**。
//
// 以前 calctest、calcviewtest、uikittest 各抄一份，內容剛好一樣；哪天有人只改其中一份，
// 另外兩處就悄悄少擋一個詞，而且沒有任何測試會紅。doctest 會擋「又有人另抄一份」。
//
// 這份清單管的是**本 App 自己寫的文案**。AI 輸出的過濾在 js/insight.js，規則不同，不共用。

export const BANNED = ['預期', '保守', '樂觀', '建議', '歷史平均', '常見', '推薦', '目標價', '應該買', '值得'];

/** 文字裡出現了哪幾個禁用詞（沒有就是空陣列）。 */
export const bannedIn = (text) => BANNED.filter((w) => String(text ?? '').includes(w));
