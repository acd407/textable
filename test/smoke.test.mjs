/*
 * 冒烟测试：解析器 + 嗅探 + MIME 判定。不需要浏览器。
 *
 * 运行： make test   （或 node test/smoke.test.mjs）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../common.js');
require('../parse.js');

const TT = globalThis.TT;

let failures = 0;
let checks = 0;

function ok(name, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? undefined : { actual, expected });
}

function parse(text, delimiter) {
  return TT.parseDelimited(text, { delimiter });
}

/* ------------------------------------------------------------ 基本解析 */

eq('单行三列', parse('a,b,c').rows, [['a', 'b', 'c']]);
eq('两行', parse('a,b\nc,d').rows, [['a', 'b'], ['c', 'd']]);
eq('末尾换行不多出空行', parse('a,b\nc,d\n').rows, [['a', 'b'], ['c', 'd']]);
eq('中间的空行保留', parse('a\n\nb\n').rows, [['a'], [''], ['b']]);
eq('空字符串', parse('').rows, []);
eq('只有 BOM', parse('\uFEFF').rows, []);
eq('连续分隔符是空字段', parse('a,,c').rows, [['a', '', 'c']]);
eq('制表符', parse('a\tb\tc', '\t').rows, [['a', 'b', 'c']]);
eq('分号', parse('a;b;c', ';').rows, [['a', 'b', 'c']]);
eq('空格分隔', parse('a b c', ' ').rows, [['a', 'b', 'c']]);

/* ------------------------------------------------------------ 引号规则 */

eq('引号内的逗号', parse('"Smith, John",42').rows, [['Smith, John', '42']]);
eq('引号内的换行', parse('a,"x\ny",c').rows, [['a', 'x\ny', 'c']]);
eq('两个引号是一个引号', parse('"say ""hi""",b').rows, [['say "hi"', 'b']]);
eq('引号内的 CRLF 原样保留', parse('a,"x\r\ny"\n').rows, [['a', 'x\r\ny']]);
eq('字段中间的引号是普通字符', parse('a"b,c').rows, [['a"b', 'c']]);
eq('引号后多余的字符照收', parse('"a"b,c').rows, [['ab', 'c']]);
eq('未闭合引号给出警告', parse('a,"b\nc').warnings.length, 1);
eq('未闭合引号内容不丢', parse('a,"b\nc').rows, [['a', 'b\nc']]);
eq('空引号字段', parse('"",""').rows, [['', '']]);

/* ------------------------------------------------------------ 行尾 / BOM */

eq('CRLF', parse('a,b\r\nc,d\r\n').rows, [['a', 'b'], ['c', 'd']]);
eq('只有 CR', parse('a,b\rc,d\r').rows, [['a', 'b'], ['c', 'd']]);
eq('BOM 去掉', parse('\uFEFFa,b\n').rows, [['a', 'b']]);

/* ------------------------------------------------------- Excel sep= 行 */

const sep = parse('sep=;\na;b\n1;2\n');
eq('sep= 行被丢掉', sep.rows, [['a', 'b'], ['1', '2']]);
eq('sep= 行决定分隔符', sep.delimiter, ';');
eq('显式分隔符优先于 sep=', parse('sep=;\na;b', ',').delimiter, ',');

/* ------------------------------------------------------------ 列数/裁断 */

eq('行宽不齐时取最宽行', parse('a,b,c\nd,e\n').fields, 3);
eq('单列 fields=1', parse('a\nb\n').fields, 1);
const capped = parse('a\nb\nc\nd\n', undefined, {});
const truncated = TT.parseDelimited('a,b\nc,d\ne,f\n', { delimiter: ',', maxRows: 2 });
eq('maxRows 截断', truncated.rows.length, 2);
ok('maxRows 标记 truncated', truncated.truncated === true);
ok('没超限时不标 truncated', capped.truncated === false);

/* -------------------------------------------------------------- 嗅探 */

const sniffTsv = TT.sniffDelimiter('name\tage\tcity\nJohn\t42\tNYC\nJane\t31\tBerlin\n');
eq('嗅探制表符', sniffTsv.delimiter, '\t');
eq('嗅探列数', sniffTsv.fields, 3);
ok('嗅探成功标记', sniffTsv.ok === true);

eq('嗅探逗号', TT.sniffDelimiter('a,b,c\n1,2,3\n').delimiter, ',');
eq('嗅探分号（欧洲 CSV）', TT.sniffDelimiter('a;b;c\n1;2;3\n').delimiter, ';');
eq('嗅探竖线', TT.sniffDelimiter('a|b\n1|2\n').delimiter, '|');
eq('引号里的逗号不影响列数', TT.sniffDelimiter('a,"b,c"\n1,"2,3"\n').fields, 2);
eq('制表符优先于逗号（同样列数）', TT.sniffDelimiter('a\tb\n1\t2\n').delimiter, '\t');
eq('多种候选取列数多的', TT.sniffDelimiter('a,b;c\n1,2;3\n').delimiter, ',');

const prose = '这是一个段落，里面有逗号，也有顿号、以及很多标点。\n第二行，逗号数量，不一样，所以不是表格。\n第三行没有逗号。\n';
ok('散文不会被当成表格', TT.sniffDelimiter(prose).ok === false, TT.sniffDelimiter(prose));

const singleColumn = 'alpha\nbeta\ngamma\n';
ok('单列文本不算表格', TT.sniffDelimiter(singleColumn).ok === false);

const oneRow = 'a,b,c\n';
ok('只有一行不算表格', TT.sniffDelimiter(oneRow).ok === false);

const ragged = 'a,b,c\n1,2\n3,4,5\n6,7,8\n';
ok('列数飘忽不算表格', TT.sniffDelimiter(ragged).ok === false);

eq('嗅探 sep= 行', TT.sniffDelimiter('sep=,\na,b\n1,2\n').delimiter, ',');

/* ------------------------------------------------------------ 表头判定 */

ok('name/age/city 是表头', TT.detectHeader([['name', 'age', 'city'], ['John', '42', 'NYC']]) === true);
ok('首行有数字就不是表头', TT.detectHeader([['1', '2', '3'], ['4', '5', '6']]) === false);
ok('首行有空单元格不是表头', TT.detectHeader([['a', '', 'c'], ['1', '2', '3']]) === false);
ok('纯文本两行且无数字', TT.detectHeader([['name', 'city'], ['John', 'NYC']]) === false);
ok('次行有空单元格时认表头', TT.detectHeader([['a', 'b'], ['', '2']]) === true);
ok('单行不认表头', TT.detectHeader([['a', 'b']]) === false);

/* ------------------------------------------------------------ 数值判定 */

ok('整数是数值', TT.isNumericCell('42') === true);
ok('小数是数值', TT.isNumericCell('3.14') === true);
ok('负数', TT.isNumericCell('-7') === true);
ok('千分位', TT.isNumericCell('1,234') === true);
ok('百分比', TT.isNumericCell('95%') === true);
ok('科学计数', TT.isNumericCell('1.2e-3') === true);
ok('空不是数值', TT.isNumericCell('') === false);
ok('单个减号不是数值', TT.isNumericCell('-') === false);
ok('日期不是数值', TT.isNumericCell('2024-01-02') === false);
ok('带单位的不是数值', TT.isNumericCell('42 kg') === false);

/* -------------------------------------------------------------- MIME */

eq('normalizeMime 去参数', TT.normalizeMime('text/csv; charset=utf-8'), 'text/csv');
eq('normalizeMime 小写', TT.normalizeMime('Text/CSV'), 'text/csv');
ok('text/csv 是表格类型', TT.isTableMime('text/csv') === true);
ok('带参数的 text/csv 也算', TT.isTableMime('text/csv; charset=utf-8') === true);
ok('text/tab-separated-values 是表格类型', TT.isTableMime('text/tab-separated-values') === true);
ok('text/plain 不是表格类型', TT.isTableMime('text/plain') === false);
ok('application/octet-stream 不接管', TT.isTableMime('application/octet-stream') === false);
ok('application/vnd.ms-excel 不接管（可能是 xls 二进制）', TT.isTableMime('application/vnd.ms-excel') === false);
eq('TSV 类型推断制表符', TT.delimiterForMime('text/tab-separated-values'), '\t');
eq('CSV 类型推断逗号', TT.delimiterForMime('text/csv'), ',');
eq('未知类型不推断', TT.delimiterForMime('application/octet-stream'), null);

/* ---------------------------------------------------------- 展示用工具 */

eq('formatInt 千分位', TT.formatInt(1234567), '1,234,567');
eq('formatInt 小数字', TT.formatInt(42), '42');
eq('basename 普通路径', TT.basename('https://x.test/a/b/data.csv?x=1'), 'data.csv');
eq('basename 百分号编码', TT.basename('https://x.test/%E8%A1%A8.tsv'), '表.tsv');
eq('basename 根路径', TT.basename('https://x.test/'), '/');
eq('resolveHeader auto 跟随检测', TT.resolveHeader('auto', true), true);
eq('resolveHeader on 强制', TT.resolveHeader('on', false), true);
eq('resolveHeader off 强制', TT.resolveHeader('off', true), false);

/* ------------------------------------------------------------ 性能兜底 */

const many = ['a,b,c'];
for (let i = 0; i < 50000; i++) many.push(`row ${i},${i * 3},x`);
const started = Date.now();
const fast = TT.parseDelimited(many.join('\n') + '\n', { delimiter: ',' });
const elapsed = Date.now() - started;
ok('5 万行解析成功', fast.rows.length === 50001, fast.rows.length);
ok('5 万行解析不慢（< 1500ms）', elapsed < 1500, elapsed + 'ms');
console.log(`  …  5 万行 × 3 列解析 ${elapsed}ms`);

/* -------------------------------------------------------------- 结果 */

console.log(failures === 0 ? `\n✔ ${checks} 项全部通过` : `\n✘ ${failures} / ${checks} 项失败`);
process.exit(failures === 0 ? 0 : 1);
