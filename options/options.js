'use strict';

(function () {
  var TT = globalThis.TT;
  var api = TT.api;

  var FIELDS = {
    enabled: 'checkbox',
    renderPlain: 'checkbox',
    headerMode: 'value',
    theme: 'value',
    maxRows: 'number'
  };

  var savedHint = document.getElementById('saved');
  var savedTimer = 0;

  function flashSaved() {
    savedHint.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      savedHint.hidden = true;
    }, 1200);
  }

  function renderMimes() {
    var list = document.getElementById('mimes');
    TT.TABLE_MIMES.forEach(function (mime) {
      var item = document.createElement('li');
      var code = document.createElement('code');
      code.textContent = mime;
      item.appendChild(code);
      list.appendChild(item);
    });
  }

  async function load() {
    var settings = await TT.loadSettings();
    Object.keys(FIELDS).forEach(function (key) {
      var input = document.getElementById(key);
      if (!input) return;
      if (FIELDS[key] === 'checkbox') input.checked = Boolean(settings[key]);
      else input.value = String(settings[key]);
    });
  }

  function bind() {
    Object.keys(FIELDS).forEach(function (key) {
      var input = document.getElementById(key);
      if (!input) return;
      input.addEventListener('change', function () {
        var patch = {};
        if (FIELDS[key] === 'checkbox') patch[key] = input.checked;
        else if (FIELDS[key] === 'number') {
          var value = parseInt(input.value, 10);
          if (!Number.isFinite(value) || value < 1000) value = TT.DEFAULTS.maxRows;
          input.value = String(value);
          patch[key] = value;
        } else patch[key] = input.value;
        api.storage.local.set(patch).then(flashSaved);
      });
    });

    document.getElementById('openViewer').addEventListener('click', function () {
      api.tabs.create({ url: api.runtime.getURL('viewer/viewer.html') });
    });
  }

  async function renderFileAccess() {
    var state = document.getElementById('fileAccessState');
    var hint = document.getElementById('fileAccessHint');
    if (!api.extension || !api.extension.isAllowedFileSchemeAccess) {
      state.textContent = '不适用';
      hint.textContent = '这个浏览器没有提供文件访问开关。';
      return;
    }
    var allowed = false;
    try {
      allowed = await api.extension.isAllowedFileSchemeAccess();
    } catch (e) {
      allowed = false;
    }
    state.textContent = allowed ? '已授权' : '未授权';
    state.className = 'badge ' + (allowed ? 'badge-on' : 'badge-off');
    hint.textContent = allowed
      ? 'file:// 下的纯文本可以渲染成表格（前提是 Firefox 愿意内联显示它，见 README）。'
      : '未授权时扩展在 file:// 页面上完全不运行。在 about:addons → Textable → 权限和数据 里打开「访问文件 URL」。';
  }

  renderFileAccess();
  renderMimes();
  bind();
  load();
})();
