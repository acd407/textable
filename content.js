/*
 * 内容脚本：只做一件事 —— 如果当前文档是浏览器按纯文本渲染的表格，就把它换成表格视图。
 *
 * 什么时候会走到这里：
 *   1. 服务器本来就用 text/plain 返回（.tsv / .txt 常见）
 *   2. background 把 text/csv、text/tab-separated-values 之类改写成了 text/plain
 * 判断依据只有两样：响应的 MIME（由 background 转告）+ 内容形状，不看 URL、不看站点。
 */
'use strict';

(function () {
  var TT = globalThis.TT;
  if (!TT) return;
  var api = TT.api;

  /* 浏览器只给我们看纯文本时才有必要继续；其它 MIME 的文档不归我们管 */
  var contentType = TT.normalizeMime(document.contentType);
  if (contentType !== 'text/plain' && !TT.isTableMime(contentType)) return;

  /* 先把 <pre> 藏起来，避免"先看到一坨原文、再闪成表格" */
  var loading = true;
  function setLoading(on) {
    var html = document.documentElement;
    if (!html) return;
    html.classList[on ? 'add' : 'remove']('tt-loading');
    loading = on;
  }
  setLoading(true);

  function clearLoading() {
    if (loading) setLoading(false);
  }

  function askHint() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        resolve(value);
      };
      setTimeout(function () {
        finish(null);
      }, 1500);
      try {
        api.runtime.sendMessage({ method: 'tt-hint', url: location.href }, function (reply) {
          void api.runtime.lastError;
          finish(reply || null);
        });
      } catch (e) {
        finish(null);
      }
    });
  }

  function rawText() {
    var pre = document.querySelector('body > pre');
    if (pre) return pre.textContent;
    return document.body ? document.body.textContent : '';
  }

  function dropPlaintextStyles() {
    var links = document.querySelectorAll('link[rel~="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if (/\/plaintext\.css$/.test(links[i].href || '')) links[i].remove();
    }
  }

  function render(text, mime, settings) {
    dropPlaintextStyles();
    document.body.textContent = '';
    document.body.classList.add('tt-body');
    document.documentElement.classList.add('tt-page');
    clearLoading();

    var host = document.createElement('div');
    host.className = 'tt-host';
    document.body.appendChild(host);

    TT.mountViewer({
      container: host,
      text: text,
      name: TT.basename(location.href),
      mime: mime,
      settings: settings
    });
  }

  async function start() {
    var settings = {};
    var hint = null;
    try {
      settings = await TT.loadSettings();
    } catch (e) {
      settings = Object.assign({}, TT.DEFAULTS);
    }

    if (settings.enabled === false) {
      clearLoading();
      return;
    }

    try {
      hint = await askHint();
    } catch (e) {
      hint = null;
    }

    /* background 记下的原始 MIME（我们改写过的类型）；没有就是文档自身的类型 */
    var mime = (hint && hint.mime) || contentType;
    var rewritten = Boolean(hint && TT.isTableMime(hint.mime));

    var text = rawText();
    if (!text.trim()) {
      clearLoading();
      return;
    }

    var forced = TT.delimiterForMime(mime);
    var sniff = TT.sniffDelimiter(text);

    /* 改写过的表格 MIME 一律渲染；原生 text/plain 只有"内容确实像表格"才渲染 */
    var tabular = forced ? true : sniff.ok;
    var shouldRender = rewritten ? text.trim() !== '' : Boolean(settings.renderPlain) && tabular;

    if (!shouldRender) {
      clearLoading();
      return;
    }

    render(text, mime, settings);
  }

  function boot() {
    start().catch(function () {
      clearLoading();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
