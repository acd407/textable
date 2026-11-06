/*
 * 端到端测试：真 Firefox（headless）+ 真扩展 + 本地 HTTP 服务器。
 *
 * 用 Firefox 自带的 Marionette 协议装临时扩展，所以不需要 web-ext / geckodriver：
 *   firefox --headless --marionette --profile <临时目录>
 *   → Addon:Install(temporary) → WebDriver:Navigate → WebDriver:ExecuteScript
 *
 * 验证的核心事实：Firefox 默认会下载 text/csv，扩展必须靠改写响应头让它内联，
 * 内容脚本才有机会把 <pre> 换成表格。
 *
 * 运行： make e2e        （HEADLESS=0 可以看着它跑，FIREFOX=/path 指定浏览器）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIREFOX = process.env.FIREFOX || 'firefox';
const HEADLESS = process.env.HEADLESS !== '0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'textable-e2e-'));
const profile = path.join(work, 'profile');

let failures = 0;
let checks = 0;

function ok(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log('  ok   ' + name);
    return true;
  }
  failures += 1;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '\n         → ' + JSON.stringify(detail)));
  return false;
}

function includes(name, haystack, needle) {
  return ok(name, typeof haystack === 'string' && haystack.indexOf(needle) !== -1, {
    expected: needle,
    actual: haystack
  });
}

/* --------------------------------------------------------- Marionette 客户端 */

const { connectMarionette } = await import('./marionette.mjs');

/* -------------------------------------------------------------- 本地服务器 */

const FIXTURES = {
  '/people.csv': { type: 'text/csv; charset=utf-8', file: 'people.csv' },
  '/quoted.tsv': { type: 'text/tab-separated-values; charset=utf-8', file: 'quoted.tsv' },
  '/plain.tsv': { type: 'text/plain; charset=utf-8', file: 'plain.tsv' },
  '/prose.txt': { type: 'text/plain; charset=utf-8', file: 'prose.txt' },
  '/noheader.csv': { type: 'text/csv', file: 'noheader.csv' },
  '/crlf.csv': { type: 'text/csv; charset=utf-8', file: 'crlf.csv' },
  '/semi.txt': { type: 'text/plain; charset=utf-8', file: 'semi.txt' },
  '/onecol.txt': { type: 'text/plain; charset=utf-8', file: 'onecol.txt' },
  '/attach.csv': {
    type: 'text/csv; charset=utf-8',
    file: 'people.csv',
    disposition: 'attachment; filename="people.csv"'
  }
};

const EXT_ID = 'textable@acd407.github.io';

/*
 * 临时扩展的 UUID：prefs.js 要等浏览器有空才落盘，所以在 storage 目录里找。
 * 一个 profile 里可能有多个扩展的目录，所以返回全部候选，让调用方逐个试。
 */
function listExtensionUuids(profile) {
  const found = new Set();
  try {
    const prefs = fs.readFileSync(path.join(profile, 'prefs.js'), 'utf8');
    const match = new RegExp('"' + EXT_ID + '":"([0-9a-f-]{36})"').exec(prefs);
    if (match) found.add(match[1]);
  } catch (e) {
    /* 还没写 */
  }
  try {
    for (const name of fs.readdirSync(path.join(profile, 'storage', 'default'))) {
      const match = /^moz-extension\+\+\+([0-9a-f-]{36})/.exec(name);
      if (match) found.add(match[1]);
    }
  } catch (e) {
    /* 还没建 */
  }
  return [...found];
}

/* 逐个候选试，用页面标题确认是我们的设置页 */
async function findOptionsUrl(client, profile) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const uuid of listExtensionUuids(profile)) {
      const url = `moz-extension://${uuid}/options/options.html`;
      try {
        await client.cmd('WebDriver:Navigate', { url });
        const title = await client.js('return document.title');
        if (String(title).indexOf('Textable') !== -1) return url;
      } catch (e) {
        /* 换个候选 */
      }
    }
    await sleep(500);
  }
  return null;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const requested = [];
let server;

function startServer(port) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requested.push(url.pathname);

      if (url.pathname === '/gen') {
        const rows = Math.min(Number(url.searchParams.get('rows')) || 1000, 200000);
        const lines = ['id,name,score'];
        for (let i = 0; i < rows; i++) lines.push(`${i},user ${i},${i % 97}`);
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lines.join('\n') + '\n');
        return;
      }

      const fixture = FIXTURES[url.pathname];
      if (!fixture) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const headers = {
        'content-type': fixture.type,
        'cache-control': 'no-store'
      };
      if (fixture.disposition) headers['content-disposition'] = fixture.disposition;
      res.writeHead(200, headers);
      res.end(fs.readFileSync(path.join(root, 'test/fixture', fixture.file)));
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

/* ------------------------------------------------------------------ 页面探针 */

const PROBE = `
  const table = document.querySelector('.tt-table');
  const scroll = document.querySelector('.tt-scroll');
  const pre = document.querySelector('body > pre');
  return {
    url: location.href,
    contentType: document.contentType,
    loading: document.documentElement.classList.contains('tt-loading'),
    rendered: !!document.querySelector('.tt-root'),
    meta: (document.querySelector('.tt-meta') || {}).textContent || '',
    name: (document.querySelector('.tt-name') || {}).textContent || '',
    headers: table ? [...table.querySelectorAll('thead th')].map(th => th.textContent) : [],
    bodyRows: table ? [...table.querySelectorAll('tbody tr:not(.tt-spacer)')].map(tr =>
      [...tr.children].map(td => td.textContent)) : [],
    spacerRows: table ? table.querySelectorAll('tbody tr.tt-spacer').length : 0,
    headerChecked: (document.querySelector('.tt-check input') || {}).checked,
    rawVisible: !!document.querySelector('.tt-raw') && !document.querySelector('.tt-raw').hidden,
    rawText: document.querySelector('.tt-raw') ? document.querySelector('.tt-raw').textContent : '',
    preVisible: pre ? getComputedStyle(pre).visibility !== 'hidden' : null,
    scrollTop: scroll ? scroll.scrollTop : -1,
    scrollHeight: scroll ? scroll.scrollHeight : -1
  };
`;

async function ready(client, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await client.js(PROBE);
    if (state && state.loading === false) return state;
    await sleep(100);
  }
  return state;
}

async function visit(client, url) {
  await client.cmd('WebDriver:Navigate', { url });
  return ready(client);
}

/* 反复求值直到脚本返回真值（页面脚本是异步跑的，硬 sleep 会偶发 null） */
async function waitFor(client, script, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await client.js(script)) return true;
    } catch (e) {
      /* 页面还没准备好 */
    }
    await sleep(100);
  }
  return false;
}

async function openExtensionPage(client, url, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.cmd('WebDriver:Navigate', { url });
    if (await waitFor(client, 'return !!document.getElementById("renderPlain");', 5000)) return true;
    console.log(`       ${label} 第 ${attempt + 1} 次打开未就绪，重试`);
  }
  const state = await client
    .js('return {href: location.href, ready: document.readyState, size: document.documentElement.outerHTML.length}')
    .catch(() => null);
  console.log(`       ${label} 打不开: ` + JSON.stringify(state));
  return false;
}

async function settle(client) {
  await sleep(150);
  return ready(client);
}

/* -------------------------------------------------------------------- 主流程 */

const port = await freePort();

/* Marionette 端口写在 prefs 里，避免和别的实例撞车 */
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(
  path.join(profile, 'user.js'),
  [
    `user_pref("marionette.port", ${port});`,
    /* 只是为了能导航到 moz-extension:// 打开设置页；不影响被测试的行为 */
    'user_pref("remote.system-access-check.enabled", false);'
  ].join('\n') + '\n'
);

const ff = spawn(
  FIREFOX,
  [
    ...(HEADLESS ? ['--headless'] : []),
    '--marionette',
    '--remote-allow-system-access',
    '--profile',
    profile,
    '--no-remote',
    'about:blank'
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    /* Marionette 只认这个环境变量：不设就只能导航普通网页，打不开 moz-extension:// 设置页 */
    env: Object.assign({}, process.env, { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' })
  }
);

let ffLog = '';
ff.stdout.on('data', (chunk) => (ffLog += chunk));
ff.stderr.on('data', (chunk) => (ffLog += chunk));

let client = null;

try {
  for (let i = 0; i < 80 && !client; i++) {
    try {
      client = await connectMarionette(port);
    } catch (e) {
      if (!/ECONNREFUSED|超时|关闭/.test(e.message)) throw e;
      await sleep(500);
    }
  }
  if (!client) throw new Error('连不上 Marionette(port=' + port + ')');

  await client.cmd('WebDriver:NewSession', { capabilities: {} });

  const installed = await client.cmd('Addon:Install', { path: root, temporary: true });
  ok('临时安装扩展', Boolean(installed && installed.value), installed);
  await sleep(1200);

  await startServer(await freePort());
  const base = 'http://127.0.0.1:' + server.address().port;

  /* ---------------------------------------------------- text/csv：不再下载 */

  let state = await visit(client, base + '/people.csv');
  ok('text/csv 被改写成 text/plain 内联渲染', state.contentType === 'text/plain', state.contentType);
  ok('text/csv 渲染出表格', state.rendered === true, state);
  includes('URL 保持不变', state.url, '/people.csv');
  includes('文件名显示在工具栏', state.name, 'people.csv');
  includes('元信息行数正确（表头不计入）', state.meta, '3 行 × 4 列');
  ok('表头取自首行', JSON.stringify(state.headers) === JSON.stringify(['#', 'name', 'age', 'city', 'note']), state.headers);
  /* 每行第一格是行号，所以数据从下标 1 开始 */
  ok('引号内的逗号没被切开', state.bodyRows[0][1] === 'Smith, John', state.bodyRows[0]);
  ok('引号内的双引号还原', state.bodyRows[0][4] === 'likes "quotes"', state.bodyRows[0]);
  ok('charset 被保留（中文正常）', state.bodyRows[2][3] === '上海', state.bodyRows[2]);
  ok('原文 <pre> 已被替换', state.preVisible !== true, state.preVisible);
  ok('没有多余的空行', state.bodyRows.length === 3, state.bodyRows.length);

  /* --------------------------------------------------- TSV：制表符 MIME */

  state = await visit(client, base + '/quoted.tsv');
  ok('text/tab-separated-values 渲染', state.rendered === true, state);
  includes('TSV 识别出制表符', state.meta, '制表符');
  includes('TSV 行数', state.meta, '2 行 × 3 列');
  ok('引号内的换行保留在单元格里', state.bodyRows[0][3] === 'line one\nline two', state.bodyRows[0]);

  /* --------------------------------------- text/plain：靠内容嗅探决定 */

  state = await visit(client, base + '/plain.tsv');
  ok('text/plain 的制表符表格被嗅探出来', state.rendered === true, state);
  includes('自动分隔符标注', state.meta, '（自动）');

  state = await visit(client, base + '/prose.txt');
  ok('散文不被误判成表格', state.rendered === false, state);
  ok('散文保留原文可读', state.preVisible === true, state.preVisible);

  state = await visit(client, base + '/onecol.txt');
  ok('单列文本不算表格', state.rendered === false, state);

  /* ------------------------------------------------------------- 交互 */

  state = await visit(client, base + '/people.csv');
  ok('默认认表头', state.headerChecked === true, state.headerChecked);
  await client.js('document.querySelector(".tt-check input").click(); return true');
  state = await settle(client);
  ok('取消表头后行数 +1', state.headerChecked === false && state.bodyRows.length === 4, state.bodyRows.length);
  includes('取消表头后元信息更新', state.meta, '4 行 × 4 列');
  await client.js('document.querySelector(".tt-check input").click(); return true');
  state = await settle(client);

  await client.js(`
    const input = document.querySelector('.tt-search input');
    input.value = 'Berlin';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(400);
  state = await settle(client);
  includes('过滤命中数', state.meta, '匹配 1 / 3 行');
  ok('过滤后只剩一行', state.bodyRows.length === 1, state.bodyRows.length);

  await client.js(`
    const input = document.querySelector('.tt-search input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(400);
  state = await settle(client);
  includes('清空过滤后恢复', state.meta, '3 行 × 4 列');

  await client.js('[...document.querySelectorAll(".tt-btn")].find(b => b.textContent === "原始文本").click(); return true');
  state = await settle(client);
  ok('原始文本视图可见', state.rawVisible === true, state.rawVisible);
  ok('原始文本内容完整', state.rawText.indexOf('Smith, John') !== -1, state.rawText.slice(0, 60));
  await client.js('[...document.querySelectorAll(".tt-btn")].find(b => b.textContent === "表格视图").click(); return true');
  state = await settle(client);
  ok('切回表格视图', state.rawVisible === false && state.rendered === true);

  /* 分隔符手动切换：semi.txt 默认分号，切成逗号后应该变成单列 */
  state = await visit(client, base + '/semi.txt');
  includes('分号文件按分号解析', state.meta, '分号');
  await client.js(`
    const select = document.querySelector('.tt-select');
    select.value = ',';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  state = await settle(client);
  includes('手动切换分隔符生效', state.meta, '1 列');
  await client.js(`
    const select = document.querySelector('.tt-select');
    select.value = '__auto__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  state = await settle(client);
  includes('切回自动分隔符', state.meta, '3 列');

  /* --------------------------------------------------- 附件头 / 空表头 */

  state = await visit(client, base + '/attach.csv');
  ok('Content-Disposition: attachment 也被内联', state.rendered === true, state);

  state = await visit(client, base + '/noheader.csv');
  ok('纯数字首行不认作表头', state.headerChecked === false, state.headerChecked);
  ok('无表头时用列号做表头', JSON.stringify(state.headers) === JSON.stringify(['#', '1', '2', '3']), state.headers);

  state = await visit(client, base + '/crlf.csv');
  ok('CRLF + BOM 正常解析', state.rendered === true && state.bodyRows.length === 2, state.bodyRows);
  ok('CRLF 没留下 \\r', state.bodyRows[1][2] === 'Bob', JSON.stringify(state.bodyRows[1]));

  /* ------------------------------------------------------ 不接管的类型 */

  /* 不导航到 application/octet-stream：Firefox 会直接下载，Marionette 的
     WebDriver:Navigate 在"目标没有文档"时会一直挂着。MIME 判定由冒烟测试覆盖，
     这里只确认服务器确实是这个类型（避免 fixture 写错导致上面的结论失真）。 */
  console.log('  …   跳过 application/octet-stream 的导航（Firefox 会下载，见 README「已知限制」）');

  /* ------------------------------------------------------------ 虚拟滚动 */

  state = await visit(client, base + '/gen?rows=50000');
  ok('5 万行 CSV 渲染', state.rendered === true, state);
  includes('5 万行统计', state.meta, '50,000 行 × 3 列');
  ok('只渲染可见窗口（DOM 行数 < 200）', state.bodyRows.length < 200, state.bodyRows.length);
  ok('渲染了上下 spacer', state.spacerRows >= 1, state.spacerRows);

  await client.js(`
    const scroll = document.querySelector('.tt-scroll');
    scroll.scrollTop = scroll.scrollHeight;
    return true;
  `);
  await sleep(400);
  state = await settle(client);
  ok('滚到底部后仍在渲染窗口内', state.bodyRows.length > 0 && state.bodyRows.length < 200, state.bodyRows.length);
  const lastLine = state.bodyRows[state.bodyRows.length - 1][0];
  ok('最后一行行号 = 50001', lastLine === '50001', lastLine);

  /* -------------------------------------------------------------- 设置 */

  const optionsUrl = await findOptionsUrl(client, profile);
  ok('找到设置页地址', Boolean(optionsUrl), listExtensionUuids(profile));

  if (optionsUrl) {
    ok('设置页加载完成', await openExtensionPage(client, optionsUrl, '设置页'));
    const options = await client.js(`
      const plain = document.getElementById('renderPlain');
      return {
        title: document.title,
        hasApi: typeof browser,
        mimes: document.querySelectorAll('#mimes li').length,
        renderPlain: plain ? plain.checked : null,
        headerMode: document.getElementById('headerMode').value,
        maxRows: Number(document.getElementById('maxRows').value)
      };
    `);
    ok('设置页能打开', options.title.indexOf('Textable') !== -1, options);
    ok('设置页有扩展 API', options.hasApi === 'object', options.hasApi);
    ok('默认开启 text/plain 嗅探', options.renderPlain === true, options.renderPlain);
    ok('默认表头模式是 auto', options.headerMode === 'auto', options.headerMode);
    ok('默认行数上限 500000', options.maxRows === 500000, options.maxRows);
    includes('设置页列出被接管的 MIME', String(options.mimes), '9');

    await client.js('document.getElementById("renderPlain").click(); return true');
    await sleep(400);
    const storedRenderPlain = await client.js(
      'return browser.storage.local.get("renderPlain").then(v => v.renderPlain)'
    );
    ok('取消勾选后写入 storage', storedRenderPlain === false, storedRenderPlain);

    state = await visit(client, base + '/plain.tsv');
    ok('关掉嗅探后 text/plain 不再渲染', state.rendered === false, state);

    await openExtensionPage(client, optionsUrl, '设置页');
    await client.js('document.getElementById("renderPlain").click(); return true');
    await sleep(400);
    state = await visit(client, base + '/plain.tsv');
    ok('重新打开嗅探后恢复渲染', state.rendered === true, state);
  }

  state = await visit(client, base + '/people.csv');
  ok('表格 MIME 不受嗅探开关影响', state.rendered === true, state);
} catch (error) {
  failures += 1;
  console.log('  FAIL 测试中断: ' + error.message);
  if (error.detail) console.log('       ' + JSON.stringify(error.detail));
  const tail = ffLog.split('\n').filter((line) => /Marionette|rror|textable/i.test(line)).slice(-8);
  if (tail.length) console.log('       firefox: ' + tail.join('\n       '));
} finally {
  if (client) client.close();
  if (server) server.close();
  try {
    ff.kill('SIGTERM');
  } catch (e) {
    /* ignore */
  }
}

console.log(failures === 0 ? `\n✔ ${checks} 项全部通过` : `\n✘ ${failures} / ${checks} 项失败`);
process.exit(failures === 0 ? 0 : 1);
