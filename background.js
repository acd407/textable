/*
 * 后台：把"浏览器会下载的表格 MIME"改成 text/plain 让它内联渲染。
 *
 * 为什么必须这么做：Firefox 遇到 text/csv、text/tab-separated-values 一律下载
 * （即使 Content-Disposition 是 inline），页面上没有 document，内容脚本就没有机会。
 * Firefox 在 MV3 里仍然支持 blocking webRequest，所以可以在响应头阶段改类型。
 *
 * 只按 MIME 决定，不匹配 URL、不维护站点列表：
 *   text/csv  text/x-csv  application/csv  application/x-csv
 *   text/comma-separated-values  text/tab-separated-values  text/tsv …
 * 二进制类型（application/vnd.ms-excel 之类）不碰，改了只会把 xls 变成乱码。
 */
'use strict';

var TT = globalThis.TT;
var api = TT.api;

/* 总开关：blocking 监听必须同步返回，所以设置缓存在内存里，变更时刷新 */
var enabled = true;
function refreshSettings() {
  TT.loadSettings().then(
    function (settings) {
      enabled = settings.enabled !== false;
    },
    function () {
      /* 读不到就当开着 */
    }
  );
}
refreshSettings();
try {
  api.storage.onChanged.addListener(function () {
    refreshSettings();
  });
} catch (e) {
  /* ignore */
}

/* tabId / url → 原始 MIME，回答内容脚本"我原本是什么类型" */
var hints = new Map();
var HINT_TTL = 10 * 60 * 1000;
var HINT_MAX = 500;

function remember(tabId, url, mime) {
  var entry = { mime: mime, url: url, at: Date.now() };
  if (typeof tabId === 'number' && tabId >= 0) hints.set('tab:' + tabId, entry);
  if (url) hints.set('url:' + url, entry);
  if (hints.size > HINT_MAX) {
    var now = Date.now();
    hints.forEach(function (value, key) {
      if (now - value.at > HINT_TTL) hints.delete(key);
    });
  }
}

function lookup(url, tabId) {
  var byTab = typeof tabId === 'number' && tabId >= 0 ? hints.get('tab:' + tabId) : null;
  if (byTab && (!url || byTab.url === url) && Date.now() - byTab.at < HINT_TTL) return byTab;
  var byUrl = url ? hints.get('url:' + url) : null;
  if (byUrl && Date.now() - byUrl.at < HINT_TTL) return byUrl;
  return null;
}

function findHeader(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || '').toLowerCase() === name) return headers[i];
  }
  return null;
}

function charsetOf(value) {
  var match = /;\s*charset\s*=\s*("?)([^";]+)\1/i.exec(String(value || ''));
  return match ? match[2].trim() : '';
}

/* 只有主文档才改：xhr/fetch 拿 JSON、脚本抓 CSV 都不该被影响 */
function onHeadersReceived(details) {
  if (!enabled) return {};
  if (details.type && details.type !== 'main_frame') return {};
  var headers = details.responseHeaders;
  if (!headers || !headers.length) return {};

  var typeHeader = findHeader(headers, 'content-type');
  if (!typeHeader || !TT.isTableMime(typeHeader.value)) return {};

  var original = typeHeader.value;
  var charset = charsetOf(original);
  typeHeader.value = 'text/plain' + (charset ? '; charset=' + charset : '');

  /* 附件头会把 text/plain 也变成下载，一并改掉 */
  for (var i = 0; i < headers.length; i++) {
    var name = String(headers[i].name || '').toLowerCase();
    if (name === 'content-disposition' && /attachment/i.test(headers[i].value || '')) {
      headers[i].value = 'inline';
    }
  }

  remember(details.tabId, details.url, original);
  return { responseHeaders: headers };
}

try {
  api.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['blocking', 'responseHeaders']
  );
} catch (e) {
  console.error('[textable] 无法注册 webRequest 监听（缺少 webRequestBlocking 权限？）', e);
}

api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'tt-hint') {
    var hint = lookup(message.url, sender && sender.tab ? sender.tab.id : -1);
    sendResponse(hint ? { mime: hint.mime } : null);
  }
});

/* 工具栏图标：打开本地文件查看页（下载下来的 CSV 也能看） */
try {
  api.action.onClicked.addListener(function () {
    api.tabs.create({ url: api.runtime.getURL('viewer/viewer.html') });
  });
} catch (e) {
  console.error('[textable] action.onClicked 注册失败', e);
}
