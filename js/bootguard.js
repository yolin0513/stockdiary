// 開機看門狗。**刻意是普通 script、沒有任何 import。**
//
// 使用者回報：按下「更新」之後只剩最上面的標題列、下面整片空白、連轉圈圈都沒有，
// 只能把 App 滑掉重開。頂列停在 index.html 寫死的「StockDiary」—— 這代表 **JS 整張沒跑**：
// 首頁載的是二十幾個檔的 ES module 圖，其中任何一個檔在網路不穩的那幾秒拿不到，
// 整張圖就不執行，也沒有東西會畫錯誤畫面（畫錯誤畫面的程式碼就在那張圖裡）。
//
// 所以這支不能 import 任何東西：它要在 module 圖死掉的時候還活著。
// 開機超過 BOOT_GUARD_MS 還沒被 app.js 標上 data-booted、或偵測到 script／link 載入失敗，
// 就在**還是空的** #view 補一張卡：先講「你的資料不會不見」，再給兩顆按鈕。
// 畫面已經有東西就什麼都不做 —— 這支只在沒人畫得出來的時候出手。
(function () {
  'use strict';
  var BOOT_GUARD_MS = 12000;
  var AFTER_ERROR_MS = 1500;
  var fired = false;
  var sawLoadError = false;

  function booted() { return document.documentElement.getAttribute('data-booted') === '1'; }
  function viewEmpty() { var v = document.getElementById('view'); return !v || !v.firstElementChild; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clearAndReload() {
    var done = function () { location.replace('./?fresh=' + Date.now() + '#/'); };
    var work = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        work.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
          return Promise.all(rs.map(function (r) { return r.unregister(); }));
        }));
      }
      if (window.caches && caches.keys) {
        work.push(caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        }));
      }
    } catch (e) { /* noop */ }
    Promise.all(work).then(done, done);
    setTimeout(done, 4000);   // 清不掉也要走
  }

  function rescue(reason) {
    if (fired || booted() || !viewEmpty()) return;
    fired = true;
    var view = document.getElementById('view');
    if (!view) return;
    var card = el('section', 'card');
    card.setAttribute('data-card', 'bootGuard');
    card.appendChild(el('h2', 'card-title', '畫面沒有載入完成'));
    card.appendChild(el('p', null, '你的資料不會不見 —— 持股、紀錄與設定都存在這台裝置上，跟這次載入沒有關係。'));
    card.appendChild(el('p', 'muted sm', reason === 'loadError'
      ? '有一個程式檔沒有下載完成（通常是網路不穩那幾秒）。重新載入一次多半就好。'
      : '程式等了 ' + Math.round(BOOT_GUARD_MS / 1000) + ' 秒還沒啟動。重新載入一次多半就好。'));
    var reloadBtn = el('button', 'btn btn-primary', '重新載入');
    reloadBtn.setAttribute('data-action', 'bootReload');
    reloadBtn.addEventListener('click', function () { reloadBtn.disabled = true; location.reload(); });
    var clearBtn = el('button', 'btn', '清快取再載入');
    clearBtn.setAttribute('data-action', 'bootClear');
    clearBtn.addEventListener('click', function () { clearBtn.disabled = true; clearBtn.textContent = '清理中…'; clearAndReload(); });
    card.appendChild(reloadBtn);
    card.appendChild(clearBtn);
    card.appendChild(el('p', 'muted sm', '「清快取再載入」只清掉程式檔的快取，不會動到你的資料。還是一樣的話，把 App 完全關掉（iPhone 從多工畫面上滑掉）再開一次。'));
    view.appendChild(card);
  }

  // script／link 載入失敗不會冒泡到 window.onerror，要用 capture 才接得到
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      sawLoadError = true;
      setTimeout(function () { rescue('loadError'); }, AFTER_ERROR_MS);
    }
  }, true);

  setTimeout(function () { rescue(sawLoadError ? 'loadError' : 'timeout'); }, BOOT_GUARD_MS);
})();
