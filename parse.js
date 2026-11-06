/*
 * 分隔符文本解析：不依赖 DOM，node 里可以直接测。
 *
 * 只实现"表格文本"需要的那部分 RFC 4180：
 *   - 分隔符任意单字符（\t , ; | 空格 …），引号固定双引号，引号内的 "" 表示一个 "
 *   - 引号内允许换行；CRLF / CR / LF 都当行尾
 *   - 去掉 BOM；容忍 Excel 的 "sep=;" 首行
 *   - 行宽不齐时不补列，只记录 fields = 最宽那行的列数，渲染时按最长行补齐
 */
'use strict';

var TT = (globalThis.TT = globalThis.TT || {});

(function () {
  var QUOTE = 34; /* " */
  var LF = 10;
  var CR = 13;

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /* Excel 导出的 "sep=;" 首行：用它确定分隔符，并把这一行丢掉 */
  TT.detectSeparatorLine = function (text) {
    var head = text.slice(0, 8);
    var m = /^sep=(.)\r?\n/i.exec(head);
    if (!m) return null;
    return { delimiter: m[1], body: text.slice(m[0].length) };
  };

  /**
   * 解析分隔符文本。
   * @param {string} text
   * @param {{delimiter?: string, maxRows?: number}} options
   * @returns {{rows: string[][], fields: number, delimiter: string, warnings: string[], truncated: boolean}}
   */
  TT.parseDelimited = function (text, options) {
    var opts = options || {};
    var delimiter = typeof opts.delimiter === 'string' && opts.delimiter ? opts.delimiter : ',';
    var delim = delimiter.charCodeAt(0);
    var maxRows = opts.maxRows || 0;
    var source = stripBom(String(text == null ? '' : text));

    var sep = TT.detectSeparatorLine(source);
    if (sep) {
      source = sep.body;
      if (!opts.delimiter) {
        delimiter = sep.delimiter;
        delim = delimiter.charCodeAt(0);
      }
    }

    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var quoted = false; /* 当前字段是否以引号开始（决定 "" 的理解方式） */
    var truncated = false;
    var warnings = [];
    var i = 0;
    var n = source.length;

    function endField() {
      row.push(field);
      field = '';
      quoted = false;
    }

    function endRow() {
      endField();
      rows.push(row);
      row = [];
    }

    while (i < n) {
      var code = source.charCodeAt(i);

      if (inQuotes) {
        if (code === QUOTE) {
          if (source.charCodeAt(i + 1) === QUOTE) {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += source[i];
        i += 1;
        continue;
      }

      if (code === QUOTE && field === '' && !quoted) {
        inQuotes = true;
        quoted = true;
        i += 1;
        continue;
      }

      if (code === delim) {
        endField();
        i += 1;
        continue;
      }

      if (code === LF || code === CR) {
        if (code === CR && source.charCodeAt(i + 1) === LF) i += 1;
        i += 1;
        if (maxRows && rows.length >= maxRows) {
          truncated = true;
          break;
        }
        endRow();
        continue;
      }

      field += source[i];
      i += 1;
    }

    if (!truncated && (field !== '' || row.length > 0 || quoted)) endRow();
    if (inQuotes) warnings.push('引号未闭合，末尾内容按剩余文本处理');

    var fields = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length > fields) fields = rows[r].length;
    }

    return {
      rows: rows,
      fields: fields,
      delimiter: delimiter,
      warnings: warnings,
      truncated: truncated
    };
  };

  /* 取一段样本，尽量在行尾切断（省得把最后半行算进去） */
  function sampleText(text, limit) {
    if (text.length <= limit) return text;
    var cut = text.lastIndexOf('\n', limit);
    return cut > 0 ? text.slice(0, cut) : text.slice(0, limit);
  }

  function scoreCandidate(sample, delimiter) {
    var parsed = TT.parseDelimited(sample, { delimiter: delimiter });
    var rows = parsed.rows;
    var nonEmpty = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.length === 1 && r[0] === '') continue;
      nonEmpty.push(r);
    }
    if (nonEmpty.length < 2) return null;
    var fields = nonEmpty[0].length;
    if (fields < 2) return null;
    for (var j = 1; j < nonEmpty.length; j++) {
      if (nonEmpty[j].length !== fields) return null;
    }
    return { fields: fields, rows: nonEmpty.length };
  }

  /**
   * 猜分隔符：看前若干行里哪种分隔符切出来的列数最一致。
   * 只有在"至少两行、每行列数相同、且列数 ≥ 2"时才算识别成功，
   * 所以普通散文（逗号数量飘忽）不会被当成表格。
   * @param {string} text
   * @returns {{delimiter: string, fields: number, rows: number, ok: boolean}}
   */
  TT.sniffDelimiter = function (text) {
    var source = stripBom(String(text == null ? '' : text));
    var sep = TT.detectSeparatorLine(source);
    if (sep) {
      var forced = TT.parseDelimited(sep.body, { delimiter: sep.delimiter });
      return {
        delimiter: sep.delimiter,
        fields: forced.fields,
        rows: forced.rows.length,
        ok: forced.fields >= 2
      };
    }

    var sample = sampleText(source, 65536);
    var best = null;
    for (var i = 0; i < TT.SNIFF_DELIMITERS.length; i++) {
      var delimiter = TT.SNIFF_DELIMITERS[i];
      var score = scoreCandidate(sample, delimiter);
      if (!score) continue;
      if (!best || score.fields > best.fields) {
        best = { delimiter: delimiter, fields: score.fields, rows: score.rows, ok: true };
      }
    }
    return best || TT.guessFieldsFallback(source);
  };

  /* 嗅探失败时的兜底：仍然按逗号切，方便手动改分隔符。ok 恒为 false —— 这只是兜底猜测，不是"识别成功" */
  TT.guessFieldsFallback = function (text) {
    var parsed = TT.parseDelimited(sampleText(stripBom(String(text || '')), 65536), { delimiter: ',' });
    return {
      delimiter: ',',
      fields: parsed.fields,
      rows: parsed.rows.length,
      ok: false
    };
  };

  var NUMERIC = /^[-+]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;

  TT.isNumericCell = function (value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (!/[0-9]/.test(v)) return false;
    return NUMERIC.test(v);
  };

  /**
   * 首行是不是表头。规则故意保守：首行不能有数字，且下一行里有数字（或首行非空、
   * 下一行有空单元格）才算。猜错也没关系，工具栏上一个勾选框就能改。
   */
  TT.detectHeader = function (rows) {
    if (!rows || rows.length < 2) return false;
    var head = rows[0];
    var next = rows[1];
    if (!head.length) return false;

    var headHasNumber = false;
    var headHasEmpty = false;
    for (var i = 0; i < head.length; i++) {
      if (TT.isNumericCell(head[i])) headHasNumber = true;
      if (!String(head[i]).trim()) headHasEmpty = true;
    }
    if (headHasNumber || headHasEmpty) return false;

    for (var j = 0; j < next.length; j++) {
      if (TT.isNumericCell(next[j])) return true;
    }
    for (var k = 0; k < next.length; k++) {
      if (!String(next[k]).trim()) return true;
    }
    return false;
  };

  if (typeof module === 'object' && module.exports) module.exports = TT;
})();
