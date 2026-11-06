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

  renderMimes();
  bind();
  load();
})();
