/*
 * 表格渲染器：工具栏 + 虚拟滚动的表格。内容脚本和 viewer 页面共用同一个入口。
 *
 * 关键取舍：
 *   - 所有单元格只用 textContent 写入，永远不拼 HTML → 数据里的 <script> 只是文字
 *   - table-layout: fixed + colgroup 固定列宽（canvas 量前 400 行），滚动时列宽不跳
 *   - 只渲染可见窗口（上下各留 OVERSCAN 行），用两条 spacer 撑出总高度
 */
'use strict';

var TT = (globalThis.TT = globalThis.TT || {});

(function () {
  var ROW_H = 28;
  var OVERSCAN = 12;
  /* 行数不多时整表渲染：浏览器的查找（Ctrl+F）、全选、Ctrl+A/Ctrl+C 都得看到 DOM 才能工作。
     超过这个量才退回虚拟滚动 —— 那时浏览器自带的查找本来就只能看到窗口内的行。 */
  var RENDER_ALL_ROWS = 5000;
  var RENDER_ALL_CELLS = 80000;
  var MAX_COL_W = 420;
  var MIN_COL_W = 56;
  var MEASURE_ROWS = 400;
  var MONO =
    '13px ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var area = h('textarea', 'tt-copy-sink');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* 复制不了就只是没复制 */
    }
    area.remove();
  }

  TT.mountViewer = function (options) {
    var opts = options || {};
    var settings = Object.assign({}, TT.DEFAULTS, opts.settings || {});
    var headerMode = settings.headerMode;
    var source = {
      text: String(opts.text == null ? '' : opts.text),
      name: opts.name || '未命名',
      mime: opts.mime || ''
    };

    var state = {
      doc: null,
      delimiter: ',',
      delimiterAuto: true,
      headerRow: false,
      headerDetected: false,
      fields: 0,
      data: [],
      filter: '',
      filtered: null,
      raw: false
    };

    /* ------------------------------------------------------------ 骨架 */

    var root = h('div', 'tt-root');
    root.style.setProperty('--tt-row-h', ROW_H + 'px');
    if (settings.theme && settings.theme !== 'auto') root.dataset.ttTheme = settings.theme;

    var bar = h('div', 'tt-bar');
    var head = h('div', 'tt-head');
    var nameEl = h('span', 'tt-name', source.name);
    nameEl.title = source.name;
    var metaEl = h('span', 'tt-meta');
    head.appendChild(nameEl);
    head.appendChild(metaEl);

    var tools = h('div', 'tt-tools');

    var delimWrap = h('label', 'tt-field');
    delimWrap.appendChild(h('span', 'tt-label', '分隔符'));
    var delimSelect = h('select', 'tt-select');
    var autoOption = h('option', null, '自动');
    autoOption.value = '__auto__';
    delimSelect.appendChild(autoOption);
    TT.DELIMITERS.forEach(function (item) {
      var option = h('option', null, item.label);
      option.value = item.value;
      delimSelect.appendChild(option);
    });
    delimWrap.appendChild(delimSelect);

    var headerWrap = h('label', 'tt-field tt-check');
    var headerBox = document.createElement('input');
    headerBox.type = 'checkbox';
    headerWrap.appendChild(headerBox);
    headerWrap.appendChild(h('span', 'tt-label', '首行表头'));

    var searchWrap = h('label', 'tt-search');
    var searchBox = document.createElement('input');
    searchBox.type = 'search';
    searchBox.placeholder = '过滤行…（Ctrl+F）';
    searchBox.spellcheck = false;
    searchWrap.appendChild(searchBox);

    var rawBtn = h('button', 'tt-btn', '原始文本');
    rawBtn.type = 'button';
    var copyBtn = h('button', 'tt-btn tt-btn-ghost', '复制全表');
    copyBtn.type = 'button';

    tools.appendChild(delimWrap);
    tools.appendChild(headerWrap);
    tools.appendChild(searchWrap);
    tools.appendChild(rawBtn);
    tools.appendChild(copyBtn);

    (opts.actions || []).forEach(function (action) {
      var button = h('button', 'tt-btn tt-btn-ghost', action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      tools.appendChild(button);
    });

    bar.appendChild(head);
    bar.appendChild(tools);

    var body = h('div', 'tt-body');
    var scroll = h('div', 'tt-scroll');
    var table = h('table', 'tt-table');
    var colgroup = h('colgroup');
    var thead = h('thead');
    var tbody = h('tbody');
    table.appendChild(colgroup);
    table.appendChild(thead);
    table.appendChild(tbody);
    scroll.appendChild(table);

    var rawPre = h('pre', 'tt-raw');
    rawPre.hidden = true;

    var toast = h('div', 'tt-toast');
    toast.hidden = true;

    body.appendChild(scroll);
    body.appendChild(rawPre);
    root.appendChild(bar);
    root.appendChild(body);
    root.appendChild(toast);

    /* ------------------------------------------------------------ 解析 */

    function dataRows() {
      return state.data;
    }

    /* 表头开/关只影响"数据从第几行开始"，切片放在这里做一次 */
    function refreshData() {
      var rows = state.doc ? state.doc.rows : [];
      state.data = state.headerRow ? rows.slice(1) : rows;
    }

    function rowLineNumber(dataIndex) {
      return state.headerRow ? dataIndex + 2 : dataIndex + 1;
    }

    function reparse(delimiter) {
      var parsed = TT.parseDelimited(source.text, {
        delimiter: delimiter,
        maxRows: settings.maxRows
      });
      state.doc = parsed;
      state.delimiter = parsed.delimiter;
      state.fields = Math.max(parsed.fields, 1);
      state.headerDetected = TT.detectHeader(parsed.rows);
      state.headerRow = TT.resolveHeader(headerMode, state.headerDetected);
      refreshData();
      state.filtered = null;
      scroll.scrollTop = 0;
      buildHead();
      buildCols();
      updateMeta();
      paint();
    }

    /* --------------------------------------------------------- 表头/列宽 */

    function buildHead() {
      thead.textContent = '';
      var tr = h('tr');
      var gutter = h('th', 'tt-gutter', '#');
      gutter.scope = 'col';
      tr.appendChild(gutter);
      var header = state.headerRow ? state.doc.rows[0] : null;
      for (var i = 0; i < state.fields; i++) {
        var value = header ? header[i] || '' : String(i + 1);
        var th = h('th', header ? '' : 'tt-colnum', value);
        th.scope = 'col';
        th.title = value;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
    }

    var measureCtx = null;
    function textWidth(value) {
      if (!measureCtx) {
        var canvas = document.createElement('canvas');
        measureCtx = canvas.getContext('2d');
        measureCtx.font = MONO;
      }
      return measureCtx.measureText(value).width;
    }

    function measureWidths() {
      var rows = dataRows();
      var sample = Math.min(rows.length, MEASURE_ROWS);
      var header = state.headerRow ? state.doc.rows[0] : null;
      var widths = [];
      for (var f = 0; f < state.fields; f++) {
        var max = 24;
        if (header) max = Math.max(max, textWidth(String(header[f] || '')));
        for (var i = 0; i < sample; i++) {
          var value = rows[i][f];
          if (!value) continue;
          if (value.length > 64) value = value.slice(0, 64);
          max = Math.max(max, textWidth(value));
        }
        widths.push(Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.ceil(max) + 20)));
      }
      return widths;
    }

    function gutterWidth() {
      var digits = String(Math.max(state.doc ? state.doc.rows.length : 0, 2)).length;
      return Math.max(44, digits * 8 + 20);
    }

    function buildCols() {
      colgroup.textContent = '';
      var widths = measureWidths();
      var gutter = h('col');
      gutter.style.width = gutterWidth() + 'px';
      colgroup.appendChild(gutter);
      widths.forEach(function (width) {
        var col = h('col');
        col.style.width = width + 'px';
        colgroup.appendChild(col);
      });
      layoutWidths(widths);
    }

    function layoutWidths(widths) {
      var sum = gutterWidth();
      for (var i = 0; i < widths.length; i++) sum += widths[i];
      var available = scroll.clientWidth;
      if (available && sum <= available) {
        table.style.width = '100%';
        table.classList.remove('tt-wide');
      } else {
        table.style.width = sum + 'px';
        table.classList.add('tt-wide');
      }
    }

    /* ------------------------------------------------------------ 元信息 */

    function updateMeta() {
      var rows = dataRows().length;
      var parts = [];
      parts.push(TT.formatInt(rows) + ' 行 × ' + TT.formatInt(state.fields) + ' 列');
      parts.push(TT.delimiterLabel(state.delimiter) + (state.delimiterAuto ? '（自动）' : ''));
      if (state.doc.truncated) parts.push('已截断到 ' + TT.formatInt(settings.maxRows) + ' 行');
      if (state.doc.warnings.length) parts.push(state.doc.warnings.join('；'));
      if (state.filtered) {
        parts.push('匹配 ' + TT.formatInt(state.filtered.length) + ' / ' + TT.formatInt(rows) + ' 行');
      }
      metaEl.textContent = parts.join(' · ');
    }

    /* -------------------------------------------------------------- 绘制 */

    var frame = 0;
    function schedulePaint() {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        paint();
      });
    }

    function spacer(height) {
      var tr = h('tr', 'tt-spacer');
      tr.style.height = height + 'px';
      var td = h('td');
      td.colSpan = state.fields + 1;
      tr.appendChild(td);
      return tr;
    }

    function cell(value, isNumeric, clipped) {
      var td = h('td', isNumeric ? 'tt-num' : '', value);
      if (clipped) td.title = value;
      return td;
    }

    function buildRow(row, dataIndex) {
      var tr = h('tr', dataIndex % 2 === 1 ? 'tt-odd' : '');
      tr.appendChild(h('td', 'tt-gutter', String(rowLineNumber(dataIndex))));
      for (var f = 0; f < state.fields; f++) {
        var value = row && row[f] != null ? row[f] : '';
        tr.appendChild(cell(value, TT.isNumericCell(value), value.length > 24));
      }
      return tr;
    }

    function paint() {
      if (!state.doc) return;

      /* 先把尺寸读干净：清空 tbody 会让表格高度塌陷，之后的 scrollTop 读到的就是被夹到 0 的值 */
      var viewHeight = scroll.clientHeight || 400;
      var scrollTop = scroll.scrollTop;

      var rows = dataRows();
      var total = state.filtered ? state.filtered.length : rows.length;
      var headH = state.headerRow ? ROW_H : 0;
      var offset = Math.max(0, scrollTop - headH);

      /* 行数够少就整表进 DOM：查找/全选/复制全表都按浏览器的直觉工作 */
      var renderAll = total * state.fields <= RENDER_ALL_CELLS && total <= RENDER_ALL_ROWS;
      var start = renderAll ? 0 : Math.max(0, Math.floor(offset / ROW_H) - OVERSCAN);
      var end = renderAll ? total : Math.min(total, Math.ceil((offset + viewHeight) / ROW_H) + OVERSCAN);

      var fragment = document.createDocumentFragment();
      if (start > 0) fragment.appendChild(spacer(start * ROW_H));
      for (var i = start; i < end; i++) {
        var dataIndex = state.filtered ? state.filtered[i] : i;
        fragment.appendChild(buildRow(rows[dataIndex], dataIndex));
      }
      if (end < total) fragment.appendChild(spacer((total - end) * ROW_H));

      /* 一次性替换：中间不留"空表"状态 */
      if (typeof tbody.replaceChildren === 'function') {
        tbody.replaceChildren(fragment);
      } else {
        tbody.textContent = '';
        tbody.appendChild(fragment);
      }
    }

    /* ------------------------------------------------------------ 交互 */

    var filterTimer = 0;
    function applyFilter() {
      var query = state.filter.trim().toLowerCase();
      if (!query) {
        state.filtered = null;
      } else {
        var rows = dataRows();
        var hits = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          for (var j = 0; j < row.length; j++) {
            if (row[j] && row[j].toLowerCase().indexOf(query) !== -1) {
              hits.push(i);
              break;
            }
          }
        }
        state.filtered = hits;
      }
      scroll.scrollTop = 0;
      updateMeta();
      paint();
    }

    function showToast(message) {
      toast.textContent = message;
      toast.hidden = false;
      toast.classList.add('tt-toast-in');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(function () {
        toast.classList.remove('tt-toast-in');
        toast.hidden = true;
      }, 1200);
    }

    function setRaw(raw) {
      state.raw = raw;
      rawPre.hidden = !raw;
      scroll.hidden = raw;
      rawBtn.textContent = raw ? '表格视图' : '原始文本';
      if (raw) {
        rawPre.textContent = source.text;
      } else {
        paint();
      }
    }

    delimSelect.addEventListener('change', function () {
      var value = delimSelect.value;
      if (value === '__auto__') {
        state.delimiterAuto = true;
        reparse(TT.sniffDelimiter(source.text).delimiter);
      } else {
        state.delimiterAuto = false;
        reparse(value);
      }
      if (state.raw) setRaw(false);
    });

    headerBox.addEventListener('change', function () {
      /* 只影响当前这个文档：全局默认值在设置页里改，别因为顺手点一下就把所有文件改了 */
      state.headerRow = headerBox.checked;
      refreshData();
      buildHead();
      buildCols();
      updateMeta();
      paint();
    });

    searchBox.addEventListener('input', function () {
      state.filter = searchBox.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyFilter, 120);
    });

    searchBox.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        searchBox.value = '';
        state.filter = '';
        applyFilter();
        searchBox.blur();
      }
    });

    rawBtn.addEventListener('click', function () {
      setRaw(!state.raw);
    });

    copyBtn.addEventListener('click', function () {
      /* TSV 回写：Excel / Numbers / 表格软件都直接吃 */
      var rows = state.filtered ? state.filtered.map(function (index) {
        return dataRows()[index];
      }) : dataRows();
      var lines = [];
      if (state.headerRow) lines.push(state.doc.rows[0].join('\t'));
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var out = [];
        for (var f = 0; f < state.fields; f++) out.push(row && row[f] != null ? row[f] : '');
        lines.push(out.join('\t'));
      }
      copyText(lines.join('\n')).then(function () {
        showToast('已复制 ' + TT.formatInt(lines.length) + ' 行（TSV）');
      });
    });

    tbody.addEventListener('dblclick', function (event) {
      var target = event.target;
      if (!target || target.tagName !== 'TD' || target.classList.contains('tt-gutter')) return;
      copyText(target.textContent).then(function () {
        showToast('已复制单元格');
      });
    });

    scroll.addEventListener('scroll', schedulePaint, { passive: true });

    /* 虚拟滚动下行不在 DOM 里，浏览器自带的 Ctrl+F 找不到它们；把快捷键交给表格自己的过滤框。
       preventDefault 能压掉 Firefox 的查找栏（网页里拦 Ctrl+F 是允许的）。 */
    function focusSearch() {
      if (state.raw) setRaw(false);
      searchBox.focus();
      searchBox.select();
    }

    function onKeyDown(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key !== 'f' && event.key !== 'F' && event.key !== 'Find') return;
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
    }

    document.addEventListener('keydown', onKeyDown, true);

    var resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () {
        var widths = [];
        var cols = colgroup.querySelectorAll('col');
        for (var i = 1; i < cols.length; i++) widths.push(parseFloat(cols[i].style.width) || MIN_COL_W);
        if (widths.length) layoutWidths(widths);
        paint();
      });
      resizeObserver.observe(scroll);
    } else {
      window.addEventListener('resize', schedulePaint);
    }

    /* ------------------------------------------------------------ 启动 */

    var initial = TT.sniffDelimiter(source.text);
    state.delimiterAuto = true;
    headerBox.checked = false;
    opts.container.appendChild(root);
    reparse(initial.delimiter);
    headerBox.checked = state.headerRow;
    delimSelect.value = state.delimiterAuto ? '__auto__' : state.delimiter;
    if (opts.raw) setRaw(true);

    return {
      root: root,
      state: state,
      setRaw: setRaw,
      focus: function () {
        searchBox.focus();
      },
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown, true);
        if (resizeObserver) resizeObserver.disconnect();
        if (frame) cancelAnimationFrame(frame);
        clearTimeout(filterTimer);
        root.remove();
      }
    };
  };

  if (typeof module === 'object' && module.exports) module.exports = TT;
})();
