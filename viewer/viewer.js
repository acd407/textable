/*
 * 本地文件查看页：拖拽 / 选择 / 粘贴。用的是内容脚本同一套解析与渲染代码。
 *
 * 存在的理由：Firefox 遇到 text/csv 会下载，webRequest 也拦不住已经落盘的文件；
 * 下载下来的 CSV 拖进这里就能看。
 */
'use strict';

(function () {
  var TT = globalThis.TT;
  var api = TT.api;

  var drop = document.getElementById('drop');
  var mount = document.getElementById('mount');
  var fileInput = document.getElementById('file');
  var encodingSelect = document.getElementById('encoding');
  var pickButton = document.getElementById('pick');

  var settings = Object.assign({}, TT.DEFAULTS);
  var viewer = null;
  var dragDepth = 0;

  TT.loadSettings().then(function (loaded) {
    settings = loaded;
  });

  function decode(buffer) {
    var encoding = encodingSelect.value;
    if (encoding === 'auto') {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch (e) {
        try {
          return new TextDecoder('gbk').decode(buffer);
        } catch (err) {
          return new TextDecoder().decode(buffer);
        }
      }
    }
    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch (e) {
      return new TextDecoder().decode(buffer);
    }
  }

  function show(text, name, mime) {
    if (viewer) viewer.destroy();
    drop.hidden = true;
    mount.hidden = false;
    document.title = name + ' · Textable';
    viewer = TT.mountViewer({
      container: mount,
      text: text,
      name: name,
      mime: mime || '',
      settings: settings,
      actions: [{ label: '打开文件', onClick: openPicker }]
    });
  }

  function openPicker() {
    fileInput.value = '';
    fileInput.click();
  }

  async function openFile(file) {
    if (!file) return;
    var buffer = await file.arrayBuffer();
    show(decode(buffer), file.name, file.type || '');
  }

  drop.addEventListener('click', function (event) {
    if (event.target === pickButton) return;
    if (event.target.closest && event.target.closest('select, label, button')) return;
    openPicker();
  });

  pickButton.addEventListener('click', function (event) {
    event.stopPropagation();
    openPicker();
  });

  fileInput.addEventListener('change', function () {
    openFile(fileInput.files && fileInput.files[0]);
  });

  /* 拖拽 */
  window.addEventListener('dragenter', function (event) {
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('tv-dragging');
  });

  window.addEventListener('dragover', function (event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function (event) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('tv-dragging');
  });

  window.addEventListener('drop', function (event) {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('tv-dragging');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openFile(file);
  });

  /* 粘贴：Excel / Numbers / 网页表格复制出来的都是制表符文本 */
  window.addEventListener('paste', function (event) {
    var data = event.clipboardData;
    if (!data) return;
    var text = data.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    show(text, '粘贴的表格', 'text/tab-separated-values');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'o' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openPicker();
    }
  });
})();
