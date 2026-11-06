# Textable

在浏览器里打开 `.csv` / `.tsv` / 制表符纯文本，**直接看到表格**，而不是一坨文本或者一个下载提示。

```
浏览器地址栏              Textable 之后
─────────────────────    ─────────────────────────────────────────
data.csv              →  可筛选、可虚拟滚动的表格（表头、行号、列宽、数字右对齐）
data.tsv              →  同上，制表符自动识别
notes.txt（制表符）    →  同上；散文、日志仍然按原文显示
```

## 为什么需要它

Firefox 对 `text/csv`、`text/tab-separated-values` **一律下载**（实测 159，即使响应头是
`Content-Disposition: inline`）。也就是说：点开一个 CSV 链接，浏览器不会给你页面，只会给你
一个下载。页面上没有 document，任何内容脚本都没有机会渲染它。

[Motrix/markdown-viewer][mv] 同类问题的解法是**要求服务器改**：必须用 `text/plain` 返回，
本地文件还得改 `~/.mime.types`。Textable 走的是另一条路：

> Firefox 在 Manifest V3 里**仍然保留 blocking `webRequest`**（Chrome 已经删了）。
> 那就由扩展在响应头阶段把 `text/csv` 改写成 `text/plain`、把 `attachment` 改成 `inline`，
> 浏览器于是内联渲染，内容脚本再把 `<pre>` 换成表格。**服务器不需要改，URL 也不会变。**

改写是按 MIME 无条件进行的，只看响应头，没有站点列表、不匹配 URL 后缀。

| 响应头 | 结果 |
| --- | --- |
| `text/csv`、`text/x-csv`、`application/csv`、`application/x-csv` | 内联 → 表格 |
| `text/comma-separated-values`、`text/tab-separated-values`、`text/tsv`、`text/x-tsv`、`application/tsv` | 内联 → 表格 |
| `text/plain` | 本来就能内联；内容**确实像表格**时才渲染 |
| `application/octet-stream` | 不接管（太多正常二进制用它），仍然下载 |
| `application/vnd.ms-excel` | 不接管（可能是真正的二进制 xls） |

## 功能

- **表格渲染**：粘性表头、行号列、列宽按内容量（不随滚动跳动）、数字右对齐、深浅色跟随系统。
- **虚拟滚动**：只渲染可见的几十行，5 万行、50 万行都不卡（`make e2e` 里有 5 万行的用例）。
- **分隔符**：自动嗅探（制表符 / 逗号 / 分号 / 竖线），也可以手动指定。
- **表头**：自动判断首行是不是表头（首行无数字、次行有数字），一个勾选框随时改，**只影响当前文件**。
- **过滤**：输入即筛，显示命中数；`Esc` 清空。
- **原始文本**：一键在表格与原文之间切换。
- **复制**：双击单元格复制；「复制全表」导出 TSV（Excel / Numbers 直接吃）。
- **本地文件**：工具栏图标打开查看页，支持拖拽、选择文件、`Ctrl+V` 粘贴，编码可选
  自动 / UTF-8 / GBK / Big5 / UTF-16LE（Excel 导出的中文 CSV 常是 GBK）。

## 安装

需要 **Firefox 128+**（MV3 + blocking webRequest）。

```bash
# 开发时临时载入
about:debugging#/runtime/this-firefox → 「临时载入附加组件」 → 选 manifest.json

# 打包（.zip 与 .xpi 内容相同，只是扩展名不同）
make build            # dist/textable-<version>.{zip,xpi}
```

未签名的 `.xpi` 只能装在 Developer Edition / ESR（或自签名后装正式版）。临时载入的扩展在
Firefox 重启后消失。

安装后浏览器会要求「访问所有网站」：必须给，否则 `webRequest` 看不到响应头，CSV 会继续下载。

## 使用

打开任意 CSV/TSV 链接即可。工具栏从左到右：

```
people.csv  3 行 × 4 列 · 逗号 ,（自动）      分隔符 [自动▾]  ☑首行表头  [过滤行…]  [原始文本] [复制全表]
```

- 文件里嵌了逗号的字段（`"Smith, John"`）、字段内的换行、`""` 转义、CRLF、BOM、
  Excel 的 `sep=;` 首行，都按 RFC 4180 处理。
- 想下载原文件：右键链接 →「另存为」，或者直接 `curl`；扩展只是让浏览器**也**能看。

设置页（`about:addons` → Textable → 选项）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 关掉后不再改写任何响应，CSV 恢复成下载 |
| 纯文本也按内容嗅探 | 开 | 服务器用 `text/plain` 返回的 TSV/CSV 也能渲染 |
| 首行表头 | 自动 | 单个文件里的勾选框不会改这里 |
| 主题 | 跟随系统 | |
| 最多渲染行数 | 500000 | 超过就截断，避免卡死标签页 |

## 工作原理

三层，各管一段：

1. **`background.js` —— 把"会下载的表格"变成"能显示的内联文本"**
   `webRequest.onHeadersReceived`（`blocking, responseHeaders`，只拦 `main_frame`）看到
   `content-type` 属于表格 MIME，就把它改成 `text/plain`（保留 `charset`），并把
   `Content-Disposition: attachment` 改成 `inline`。同时把原始 MIME 记在内存里，
   供内容脚本查询。
2. **`content.js` —— 拿到文本，决定要不要渲染**
   在 `document_start` 注入，只看 `document.contentType === 'text/plain'`。文档就绪后：
   先问后台"我原本是什么类型"，再读 `<body><pre>` 的 `textContent`（Firefox 的纯文本视图
   就是这个结构，文本是浏览器已经按 charset 解码好的，不用二次请求、也不会二次解压）。
   判定：原本是表格 MIME → 一定渲染；原本是 `text/plain` → 只有嗅探认为"每行列数一致且 ≥2 列"
   才渲染。等待期间给 `<html>` 挂 `tt-loading`，CSS 把 `<pre>` 藏起来，避免"先看到原文再闪成表格"。
3. **`parse.js` / `viewer.js` —— 解析与渲染**
   单遍扫描的 RFC 4180 解析器（40 万字符/几十毫秒）；`table-layout: fixed` + `colgroup`
   固定列宽（canvas 量前 400 行）；`tbody` 只放可见窗口的行，上下用两条 spacer `<tr>` 撑高度。
   所有单元格用 `textContent` 写入，数据里的 HTML 永远只是文字。

```
响应头 ──► background 改写 ──► Firefox 内联渲染 text/plain ──► content.js 读 <pre>
                                                                      │
                                              sniff + parse ◄──────────┘
                                                    │
                                             viewer.js（虚拟滚动表格）
```

## 本地文件（`file://`）

本地文件和 HTTP 是两条不同的判定路径，结论也不一样。以下是 Firefox 159 / Linux 上的实测结果：

1. **默认还是下载**。`file:///….csv`、`file:///….tsv` 和 http 一样进下载列表，页面上没有文档。
2. **改 `~/.mime.types` 只能救 `.tsv`，救不了 `.csv`**：
   - `helpers.private_mime_types_file` 指向一份 `type=text/plain exts=csv,tsv,tab` →
     `.tsv` 变成 `text/plain` 并内联显示 ✓；`.tab`、`.csvx` 这类系统没登记的扩展名同样生效 ✓
   - 同一份文件里的 `csv` 那一项**无效**，`.csv` 照旧下载；改成 `text/x-csv-custom` 也照旧下载 ✗
   - 原因在 Firefox 的"扩展名 → MIME"顺序（`uriloader/exthandler/nsExternalHelperAppService.cpp`）：
     `defaultMimeEntries` → OS（mime.types）→ **`extraMimeEntries`（`{"text/csv","csv"}` 就在这张表里）**
     → 插件 → `ext-to-type-mapping`。而 `text/csv` 又不在"可以在浏览器内查看"的类型里。
3. **强行设成"在 Firefox 中打开"也不行**：`handlers.json` 里给 `text/csv` 写 `"action": 3`
   （等价于 about:preferences → 应用程序里选"在 Firefox 中预览"）后打开本地 CSV，页面直接报
   `could not be opened, because an unknown error occurred. Try saving to disk first and then opening the file.`
4. **响应头改写这条路对 `file://` 根本不适用**：`webRequest.onHeadersReceived` 是靠
   `http-on-examine-response` 观察者驱动的，`file://` 不走 HTTP，没有响应头可改。
5. 还有一层容易漏：内容脚本在 `file://` 上默认没有权限。即使 manifest 里声明了 `file:///*`，
   `browser.extension.isAllowedFileSchemeAccess()` 依然是 `false`，要在
   about:addons → 权限和数据 → 打开「访问文件 URL」。本扩展的设置页会显示当前状态。

所以本地文件有两条实用路线：

| 想干的事 | 怎么做 |
| --- | --- |
| 看本地 `.csv`（最常见） | 工具栏图标打开查看页，拖进去 / 选择文件 / `Ctrl+V`；编码可选 GBK |
| 让 `file://` 的 `.tsv` 直接变成表格 | `~/.mime.types` 加 `type=text/plain exts=tsv,tab`（snap / flatpak 用 `helpers.private_mime_types_file` 指到沙箱内路径），再打开「访问文件 URL」 |
| 想在 `file://` 里也看 `.csv` | 起个静态服务器绕过去：`python3 -m http.server 8000`，然后开 `http://localhost:8000/x.csv`（http 上响应头改写照常生效） |

## 和 markdown-viewer 的差别

两者面对的是同一个 Firefox 行为（表格 / markdown 默认下载），但解法不同：

| | markdown-viewer | Textable |
| --- | --- | --- |
| 让 `text/csv` 内联 | 要求服务器返回 `text/plain`；本地文件改 `~/.mime.types` | 扩展改写响应头，服务器不用动 |
| 判断依据 | 站点列表 + 路径正则 + 头检测 | 只有 MIME（+ 内容形状） |
| 需要下载的站点 | 提前把 origin 加进白名单并授权 | 不需要，装完就能用 |
| 严格 CSP 的站点 | 内容脚本注入被 CSP 挡住 | 同样不涉及（纯文本文档没有页面脚本） |

## 已知限制

- **只支持 Firefox**。Chrome 的 MV3 没有 blocking `webRequest`，「点链接就内联」这条路走不通。
- **`application/octet-stream` / `application/vnd.ms-excel` 不接管**。很多对象存储（S3、
  各种 CDN）给所有文件都回 `octet-stream`，`vnd.ms-excel` 又可能真的是二进制 xls；按 MIME
  无法区分，就宁可不碰。这类文件仍然会下载 —— 下载后拖进查看页即可（工具栏图标）。
- **`file://` 下的 `.csv`** 没法靠 MIME 列表解决（Firefox 把它钉死在 `text/csv` 且不可内联查看），
  详见上面「本地文件」一节；用查看页或本地 HTTP 服务器。
- **超长文件**：默认最多渲染 50 万行。虚拟滚动的总高度靠元素高度撑出来，Firefox 的单个元素
  高度上限约 1789 万 px，28px 行高换算下来最多约 63 万行，所以设置页把上限卡在 60 万。
- **单元格不换行**：字段里的换行在单元格里显示成空格（`title` 里有完整值，双击可复制）。
  固定行高 + 虚拟滚动换来的是滚动流畅，代价就是不做单元格内换行。
- **`text/csv` 被改写后，页面的 `document.contentType` 是 `text/plain`**。所以如果某个站点
  有脚本依赖这个值判断"我自己是不是被当表格打开了"，会看到 `text/plain`。纯文本文档里没有
  页面脚本，实际影响为零。
- **响应头改写只作用于主文档**：`fetch()` / XHR 拿 CSV 不受影响。
- **扩展更新后**需要刷新已打开的页面。

## 开发

```bash
make test     # 81 项：解析器 / 嗅探 / 表头判定 / MIME 判定（node，无浏览器）
make e2e      # 56 项：headless Firefox + 真扩展 + 本地服务器
make check    # 语法检查 + 冒烟测试 + 打包自检
make build    # dist/textable-<version>.{zip,xpi}，可复现
make icons    # 重新生成图标
```

`test/e2e.mjs` 用 Firefox 自带的 **Marionette** 协议驱动浏览器，不依赖 web-ext / geckodriver：

```
firefox --headless --marionette --profile <临时目录>
  Addon:Install(temporary) → WebDriver:Navigate → WebDriver:ExecuteScript
```

它验证的是这个项目赖以成立的那几个事实：`text/csv` 被内联而不是下载、引号/换行/CRLF/BOM
解析正确、`text/plain` 的散文不误判、附件头也被内联、5 万行只渲染可见窗口而且能滚到第 50001 行、
设置页写入的开关真的改变行为。

两个踩过的坑记在这里：

- Marionette 的命令包是**数组** `[0, id, name, params]`（响应 `[1, id, error, result]`），
  不是 `{"id":…,"name":…}` 对象；分帧是 `<字节长度>:<json>`。
- 想用 Marionette 打开 `moz-extension://` 页面（设置页、查看页），必须给浏览器设
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`，否则 `WebDriver:Navigate` 会报
  "Navigation … is not allowed in this context"。扩展的 UUID 从 profile 的
  `storage/default/moz-extension+++*` 目录里找，并用页面标题确认没找错。

## 文件结构

```
manifest.json       MV3；Firefox 专用（blocking webRequest）
common.js           MIME 表、默认设置、共享小工具（四端共用）
parse.js            分隔符文本解析 + 分隔符嗅探 + 表头判定（无 DOM，可单测）
viewer.js           表格渲染：工具栏、固定列宽、虚拟滚动、过滤、原文切换
viewer.css          渲染器样式（作为内容脚本 CSS 注入，选择器全部带 tt- 前缀）
content.js          内容脚本：判定文本→表格，替换页面
background.js       webRequest 头改写 + 原始 MIME 记录 + 工具栏图标
viewer/             本地文件查看页（拖拽 / 选择 / 粘贴 + 编码选择）
options/            设置页
test/               smoke.test.mjs（解析）、e2e.mjs（真浏览器）、marionette.mjs、fixture/
tools/              pack.py（打包）、make-icons.py（图标）
Makefile            test / e2e / check / build / icons / clean
```

## 许可

MIT（见 `LICENSE`）。`test/marionette.mjs` 的协议细节参考了 Firefox 自带 Marionette 实现
（MPL-2.0）的行为，未复制其代码。

[mv]: https://github.com/simov/markdown-viewer
