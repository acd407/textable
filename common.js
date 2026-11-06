/*
 * 共享常量与工具：background / 内容脚本 / viewer 页面 / 设置页四处共用。
 *
 * 这个项目不做站点列表、不按 URL 后缀判断：能渲染什么，完全由响应的 MIME 决定。
 * 这里集中放 MIME 表与默认设置，避免几端各写一份。
 */
'use strict';

/* 挂在 globalThis 上，这样 node 里 require 之后 parse.js / viewer.js 也能拿到同一个对象 */
var TT = (globalThis.TT = globalThis.TT || {});

TT.api = globalThis.browser || globalThis.chrome;

/* 明确表示"这是表格文本"的 MIME。只有这些类型会被 background 从"下载"改成"内联"。 */
TT.TABLE_MIMES = [
  'text/csv',
  'text/x-csv',
  'application/csv',
  'application/x-csv',
  'text/comma-separated-values',
  'text/tab-separated-values',
  'text/tsv',
  'text/x-tsv',
  'application/tsv'
];

TT.DEFAULTS = {
  /* 总开关 */
  enabled: true,
  /* text/plain 也按内容嗅探（内容确实像表格才渲染） */
  renderPlain: true,
  /* 首行是否表头：auto | on | off */
  headerMode: 'auto',
  /* 主题：auto | light | dark */
  theme: 'auto',
  /* 超过这个行数就不再渲染，直接给原始文本（避免把浏览器卡死） */
  maxRows: 500000
};

TT.DELIMITERS = [
  { value: ',', label: '逗号 ,' },
  { value: '\t', label: '制表符 ⇥' },
  { value: ';', label: '分号 ;' },
  { value: '|', label: '竖线 |' },
  { value: ' ', label: '空格' }
];

/* 自动嗅探时考虑的候选（空格太容易误判，只在手动选择里给） */
TT.SNIFF_DELIMITERS = ['\t', ',', ';', '|'];

TT.delimiterLabel = function (value) {
  for (var i = 0; i < TT.DELIMITERS.length; i++) {
    if (TT.DELIMITERS[i].value === value) return TT.DELIMITERS[i].label;
  }
  return value;
};

TT.normalizeMime = function (value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
};

TT.isTableMime = function (value) {
  return TT.TABLE_MIMES.indexOf(TT.normalizeMime(value)) !== -1;
};

/* MIME 里能读出来的分隔符（TSV 就是制表符，CSV 是逗号），读不出来返回 null */
TT.delimiterForMime = function (value) {
  var mime = TT.normalizeMime(value);
  if (!mime) return null;
  if (/tab-separated|tsv/.test(mime)) return '\t';
  if (/csv|comma-separated/.test(mime)) return ',';
  return null;
};

/* 1234567 → "1,234,567"（不用 toLocaleString，避免受系统区域设置影响） */
TT.formatInt = function (n) {
  var s = String(Math.trunc(Number(n) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

TT.basename = function (url) {
  try {
    var path = new URL(url).pathname;
    var last = path.split('/').filter(Boolean).pop() || path;
    return decodeURIComponent(last) || '未命名';
  } catch (e) {
    return '未命名';
  }
};

TT.loadSettings = async function () {
  var settings = Object.assign({}, TT.DEFAULTS);
  try {
    var stored = await TT.api.storage.local.get(null);
    for (var key in TT.DEFAULTS) {
      if (stored && stored[key] !== undefined && stored[key] !== null) settings[key] = stored[key];
    }
  } catch (e) {
    /* 存储不可用时退回默认值 */
  }
  return settings;
};

/* 设置页里用的三态解析：auto 由内容决定，on/off 强制 */
TT.resolveHeader = function (mode, detected) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(detected);
};

if (typeof module === 'object' && module.exports) module.exports = TT;
