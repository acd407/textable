# 为什么本地 `.csv` 救不了（以及 `.tsv` 为什么能救）

这是 Textable 开发过程中对 `file://` 的实测记录。结论：**本地 `.csv` 一定走下载，改系统 MIME、
改 `about:config`、强制"在浏览器中打开"都没用；本地 `.tsv` 可以通过 `~/.mime.types` 救回来。**

环境：Firefox 159 / Linux。每一项都单独跑一轮，判据是"文件是否被内联显示"以及 `document.contentType`。

| 扩展名 | 默认行为 | `~/.mime.types` 里映射成 `text/plain` |
| --- | --- | --- |
| `.csv` | 下载 | **仍然下载** |
| `.tsv` | 下载 | 内联显示 |
| `.tab`、未登记的扩展名 | 内联（未知类型按文本嗅探） | 内联 |
| `.txt` | 内联 | 内联（映射被忽略） |

## 判定分两层，只有第一层能操作

```
① 扩展名 → MIME 类型      defaultMimeEntries（不可覆盖） → OS 层（私有 mime.types → GIO/XDG → 全局 mime.types） → extraMimeEntries
② MIME 类型 → 能否内联    nsContentUtils::IsPlainTextType()，硬编码黑名单
```

黑名单（`dom/base/nsContentUtils.cpp`，2024 年 [D212078] 引入）：

```cpp
bool nsContentUtils::IsPlainTextType(const nsACString& aContentType) {
  // All `text/*`, any JSON type and any JavaScript type are considered "plain text"
  return (StringBeginsWith(aContentType, "text/"_ns) &&
          !IsNonPlainTextType(aContentType)) || IsJSONType(aContentType) || ...
}
```

`kNonPlainTextTypes` 明确排除：

```
html xml xsl calendar x-calendar x-vcalendar vcalendar vcard x-vcard directory ldif
qif x-qif x-csv x-vcf rtf comma-separated-values csv tab-separated-values tsv ofx
vnd.sun.j2me.app-descriptor x-ms-iqy x-ms-odc x-ms-rqy x-ms-contact
```

所以：`text/plain` 不在名单里（能内联）；`text/csv`、`text/tab-separated-values` 都在名单里（不能内联）。
这段代码没有任何 `StaticPrefs` 门控。

`.tsv` 能救，是因为它在**第一层**可覆盖：`~/.mime.types` 写 `type=text/plain exts=tsv,tab`
把它变成 `text/plain`，第二层于是不再命中。注意这不是"把 tsv 变可查看"，而是**换掉类型**。

## 反证实验

- **与内容无关**：把散文（不含表格结构）存成 `prose.csv` 一样下载；同样内容存成 `.weird` 就内联。
- **与目标类型无关**：`csv` 映射成 `text/plain`、`text/x-csv-custom`、`image/png`、`application/x-foo`，
  `.csv` 全都下载 —— 说明它根本没走 mime.types 那一层，而不是"映射成了不可查看的类型被拒"。
- **可覆盖性对照**：把 `ics` / `vcf` / `qif`（在 `extraMimeEntries` 里）映射成 `text/plain`，
  它们都变成 `text/plain` 并内联；把 `txt` 映射成 `image/png`，`.txt` 依然是 `text/plain`
  （`defaultMimeEntries` 的注释是 *"These are not overridable"*）。
  `.csv` 的表现和 `.txt` 一致、和 `ics`/`vcf` 相反 → 这个构建里它属于**不可覆盖**的那张表。
  master 源码里 `{"text/csv","csv"}` 还挂在 `extraMimeEntries`，说明这是版本差异。
- **全局 mime.types 也不行**：把 `helpers.global_mime_types_file` 指向
  `/etc/mime.types` + `csv→text/plain`，`.csv` 仍然下载。
- **`handlers.json` 强制内部查看会报错**：给 `text/csv` 写 `"action": 3`（等价于
  about:preferences → 应用程序里选"在 Firefox 中预览"）后打开本地 CSV，页面报
  `could not be opened, because an unknown error occurred. Try saving to disk first and then opening the file.`
- **系统栈不作数**：`xdg-mime query filetype x.csv` 在这一台机器上报 `text/plain`（`x.tsv` 同样），
  Firefox 照样下载。GIO/XDG 只在前面的查表都落空时才被问到。

## 为什么 `about:config` 里那几个项都不管用

| 项 | 实际作用 |
| --- | --- |
| `helpers.global_mime_types_file` / `helpers.private_mime_types_file` | 只提供"扩展名 → MIME"查表（第一层）。`.csv` 被更前面的不可覆盖映射拦住，改这里无效 |
| `network.mimesniff.*` | 类型缺失或标错时要不要做 HTML 嗅探 |
| `security.block_*_with_wrong_mime` | Worker / Worker script 的 MIME 检查 |
| `widget.use-xdg-desktop-portal.mime-handler` | 「用外部程序打开」是否走 XDG portal |

`greprefs.js` 里和 MIME 解析相关的 pref 只有前两个，也没有任何"哪些类型可以内联查看"的开关。

## 另外两件事

- **扩展无法接管 `file://` 的响应头**：`webRequest.onHeadersReceived` 由 `http-on-examine-response`
  观察者驱动，`file://` 不走 HTTP，没有响应头可改。
- **内容脚本在 `file://` 上默认没有权限**：即使 manifest 声明了 `file:///*`，
  `browser.extension.isAllowedFileSchemeAccess()` 仍为 `false`，要在 about:addons → 权限和数据 →
  打开「访问文件 URL」。Textable 的设置页会显示当前状态。

## 可用的做法

| 想干的事 | 怎么做 |
| --- | --- |
| 看本地 `.csv` | 工具栏图标打开查看页：拖拽 / 选择文件 / `Ctrl+V`，编码可选 GBK |
| 让 `file://` 的 `.tsv` 直接变表格 | `~/.mime.types` 加 `type=text/plain exts=tsv,tab`（snap / flatpak 用 `helpers.private_mime_types_file` 指到沙箱内路径），再打开「访问文件 URL」 |
| 想让 `file://` 的 `.csv` 也变表格 | 起静态服务器绕过去：`python3 -m http.server 8000`，然后开 `http://localhost:8000/x.csv` |

## 一个可能的将来

如果哪天 Firefox 把 `.csv` 挪回可覆盖的 `extraMimeEntries`，或者把 `text/csv` 移出
`kNonPlainTextTypes`，本地 CSV 立刻就能被 Textable 接管，扩展代码一行都不用改。

[D212078]: https://phabricator.services.mozilla.com/D212078
