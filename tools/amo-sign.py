#!/usr/bin/env python3
"""用 AMO API 给 Textable 做 Mozilla 签名（unlisted / 自发布渠道）。

为什么需要签名
--------------
Firefox release 版只允许安装「Mozilla 已签名」的扩展，所以站点外分发时必须先把这个
xpi 提交到 addons.mozilla.org 换一个带 META-INF/mozilla.rsa 的已签名包。

凭证
----
API 凭证放在 ``~/.config/data/mozilla-developers-api.txt``（仓库外，不要提交）：

    第 1 行 = JWT issuer（AMO 控制台里的 "JWT issuer"，形如 user:12345:67）
    第 2 行 = API key（JWT secret）

在 https://addons.mozilla.org/en-US/developers/addon/api/key/ 生成或重置。
本脚本只读这个文件，不打印、不写回任何凭证内容。

用法
----
    python3 tools/amo-sign.py                       # 签名 dist/ 里当前版本
    python3 tools/amo-sign.py path/to/xxx.xpi       # 签名指定文件
    python3 tools/amo-sign.py --fetch 1.0.0         # 只重新下载已签名的包（不提交）

产物：``dist/textable-<version>-signed.xpi``，脚本会核对 AMO 返回的 sha256。

AMO v5 的几个坑（都是实测出来的，改脚本前先读）
-----------------------------------------------
1. 没有 ``/api/v5/addons/create/``（那个是旧文档里的说法，现在返回 404）。
   创建 add-on 和追加版本都走 ``PUT /api/v5/addons/addon/{guid}/``，
   body 是 ``{"version": {"upload": "<upload uuid>"}}``；guid 取自 manifest。
2. 版本号不能重复：同一个 add-on 再提交 1.0.0 会得到
   ``409 {"version": ["Version 1.0.0 already exists."]}``。发新版前先升 manifest 的
   ``version``。
3. unlisted 的 ``file.url`` 匿名访问是 404（只有作者能下），
   所以下载那一步必须带 ``Authorization: JWT <token>``。
4. 校验通过后签名不是同步完成的：``file.status`` 会先停在 ``unreviewed``，
   几十秒后才变 ``public``，必须轮询。
5. JWT 有效期很短（这里签 120 秒），长轮询要用新 token，所以封装了 ``make_token()``。
6. AMO 会用自己序列化过的 manifest 落地包内容（非 ASCII 转成 \\uXXXX），
   因此签出来的 manifest 和本地文件不是逐字节相同，属正常现象。
"""

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid as uuidlib
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRED_PATH = os.path.expanduser("~/.config/data/mozilla-developers-api.txt")
API = "https://addons.mozilla.org/api/v5"
DEV_HUB = "https://addons.mozilla.org/en-US/developers/addon/"
CHANNEL = "unlisted"          # unlisted = 自发布；改成 listed 需要额外的 license/分类等元数据
POLL_INTERVAL = 5             # 轮询间隔（秒）
POLL_TIMEOUT = 600            # 轮询超时（秒）


# --------------------------------------------------------------------- 凭证

def read_credentials():
    """读到 (issuer, key)。文件格式：第一行 userid，第二行 key。"""
    if not os.path.exists(CRED_PATH):
        sys.exit(
            "找不到凭证文件 %s\n"
            "在 https://addons.mozilla.org/en-US/developers/addon/api/key/ 生成后，"
            "把 issuer 和 key 分别写到第 1、2 行。" % CRED_PATH
        )
    with open(CRED_PATH, encoding="utf-8") as handle:
        lines = [line.strip() for line in handle.read().splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    if len(lines) < 2:
        sys.exit("凭证文件格式不对：需要两行（第 1 行 issuer，第 2 行 key）")
    return lines[0], lines[1]


def make_token(issuer, key):
    """AMO 要求 HS256 JWT，payload 里带 iss / jws_algorithm / iat / exp。"""
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"iss": issuer, "jws_algorithm": "HS256", "iat": now, "exp": now + 120}

    def b64(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    signing_input = b".".join(
        b64(json.dumps(part, separators=(",", ":")).encode()) for part in (header, payload)
    )
    signature = hmac.new(key.encode(), signing_input, hashlib.sha256).digest()
    return (signing_input + b"." + b64(signature)).decode()


# ----------------------------------------------------------------- HTTP 封装

def call(method, path, token, body=None, headers=None):
    """调 API。path 可以是相对 /api/v5 的路径，也可以是完整 URL。返回 (status, dict)。"""
    url = path if path.startswith("http") else API + path
    data = None
    hdrs = {"Authorization": "JWT " + token, "Accept": "application/json"}
    if body is not None:
        # bytes 视为已编码好的 multipart，其它走 JSON
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        if not isinstance(body, bytes):
            hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)

    request = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"detail": raw[:400]}


def multipart_body(field, filepath, extra_fields):
    """手写 multipart/form-data，避免为了一个上传再装 requests。"""
    boundary = "----textable" + uuidlib.uuid4().hex
    chunks = []
    for name, value in extra_fields.items():
        chunks.append(
            ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
             % (boundary, name, value)).encode()
        )
    content_type = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
    chunks.append(
        ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
         "Content-Type: %s\r\n\r\n"
         % (boundary, field, os.path.basename(filepath), content_type)).encode()
    )
    with open(filepath, "rb") as handle:
        chunks.append(handle.read())
    chunks.append(("\r\n--%s--\r\n" % boundary).encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


# ------------------------------------------------------------------- manifest

def read_manifest():
    path = os.path.join(ROOT, "manifest.json")
    with open(path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    guid = ((manifest.get("browser_specific_settings") or {}).get("gecko") or {}).get("id", "")
    if not guid:
        sys.exit("manifest.json 里没有 browser_specific_settings.gecko.id，无法按 guid 提交签名")
    return manifest, guid


def local_xpi(version):
    """没显式给路径时，用 dist/ 里当前版本构建好的 xpi。"""
    name = "textable-%s.xpi" % version
    return os.path.join(ROOT, "dist", name)


# --------------------------------------------------------------------- 各步骤

def step_upload(xpi, issuer, key):
    """上传 -> 等校验。校验不过就直接退出（AMO 不会给非法包签名）。"""
    print("[1/5] 上传 %s (%.1f KB)" % (os.path.basename(xpi), os.path.getsize(xpi) / 1024.0))
    body, content_type = multipart_body("upload", xpi, {"channel": CHANNEL})
    status, payload = call(
        "POST", "/addons/upload/", make_token(issuer, key), body, {"Content-Type": content_type}
    )
    if status >= 400:
        sys.exit("上传失败 HTTP %s：%s" % (status, json.dumps(payload, ensure_ascii=False)[:600]))

    upload_uuid = payload.get("uuid")
    print("       upload uuid = %s（channel = %s）" % (upload_uuid, payload.get("channel")))

    print("[2/5] 等 AMO 校验")
    deadline = time.time() + POLL_TIMEOUT
    info = {}
    while time.time() < deadline:
        status, info = call("GET", "/addons/upload/%s/" % upload_uuid, make_token(issuer, key))
        if status >= 400:
            sys.exit("查询上传状态失败 HTTP %s：%s" % (status, info))
        if info.get("processed"):
            break
        time.sleep(POLL_INTERVAL)
    else:
        sys.exit("校验超时（%d 秒）" % POLL_TIMEOUT)

    # errors 会带 message / description / file，原样打出来最有用
    for item in info.get("errors", []):
        print("       ERROR  %s | %s | %s" % (item.get("message"), item.get("description"), item.get("file")))
    for item in info.get("warnings", []):
        print("       WARN   %s | %s" % (item.get("message"), item.get("description")))
    print("       valid = %s" % info.get("valid"))
    if not info.get("valid"):
        sys.exit("校验未通过，未提交签名")
    return upload_uuid


def step_submit(upload_uuid, guid, version, issuer, key):
    """提交版本。PUT /addons/addon/{guid}/ 一步搞定「新建 add-on」和「追加版本」。"""
    print("[3/5] 提交签名（guid = %s）" % guid)
    payload = {"version": {"upload": upload_uuid}}
    status, response = call("PUT", "/addons/addon/%s/" % guid, make_token(issuer, key), payload)
    if status in (404, 405):
        # 极老的部署只认 POST /addons/addon/，留个兜底
        status, response = call("POST", "/addons/addon/", make_token(issuer, key), payload)
    if status == 409:
        sys.exit(
            "AMO 说版本 %s 已存在（HTTP 409）。\n"
            "发新版前先把 manifest.json 的 version 升级，再 make build。" % version
        )
    if status >= 400:
        sys.exit("提交签名失败 HTTP %s：%s" % (status, json.dumps(response, ensure_ascii=False)[:600]))
    print("       -> %s" % (DEV_HUB + str((response or {}).get("slug", ""))))


def step_wait_signed(guid, version, issuer, key):
    """签名是异步的：file.status 会先 unreviewed，再变 public。"""
    print("[4/5] 等签名完成")
    deadline = time.time() + POLL_TIMEOUT
    last = None
    while time.time() < deadline:
        status, info = call(
            "GET", "/addons/addon/%s/versions/%s/" % (guid, version), make_token(issuer, key)
        )
        if status >= 400:
            sys.exit("查询版本失败 HTTP %s：%s" % (status, json.dumps(info, ensure_ascii=False)[:400]))
        file_info = info.get("file") or {}
        current = file_info.get("status")
        if current != last:
            print("       file.status = %s" % current)
            last = current
        if current in ("public", "signed"):
            return file_info
        if current in ("disabled", "deleted"):
            sys.exit("文件状态是 %s，无法下载" % current)
        time.sleep(POLL_INTERVAL)
    sys.exit("等待签名超时（%d 秒）" % POLL_TIMEOUT)


def step_download(file_info, version, issuer, key):
    """下载已签名包并核对 hash。

    注意：unlisted 的 file.url 匿名请求会 404，必须带作者 JWT。
    """
    print("[5/5] 下载已签名 xpi")
    expected = (file_info.get("hash") or "").split(":")[-1]
    url = file_info.get("url")
    if not url:
        sys.exit("AMO 没有返回签名文件地址：%s" % json.dumps(file_info, ensure_ascii=False)[:400])

    request = urllib.request.Request(
        url,
        headers={
            "Authorization": "JWT " + make_token(issuer, key),
            "Accept": "application/x-xpinstall,application/octet-stream,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()

    actual = hashlib.sha256(raw).hexdigest()
    print("       字节数 = %d" % len(raw))
    print("       sha256 = %s" % actual)
    if expected and actual != expected:
        sys.exit("下载内容与 AMO 记录的 hash 不一致（期望 %s）" % expected)
    print("       与 AMO 记录一致 ✓")

    out = os.path.join(ROOT, "dist", "textable-%s-signed.xpi" % version)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as handle:
        handle.write(raw)

    # 顺手确认签名文件真的在包里，避免拿到未签名的半成品
    try:
        names = zipfile.ZipFile(out).namelist()
    except zipfile.BadZipFile:
        sys.exit("下载到的文件不是合法的 zip/xpi：%s" % out)
    if "META-INF/mozilla.rsa" not in names:
        sys.exit("包里没有 META-INF/mozilla.rsa，说明这不是已签名包：%s" % out)
    print("       -> %s" % out)
    return out


# ----------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description="给本扩展做 AMO 签名（unlisted）")
    parser.add_argument("xpi", nargs="?", help="要签名的 xpi（默认用 dist/ 里当前版本）")
    parser.add_argument(
        "--fetch", metavar="VERSION",
        help="只重新下载这个版本已签名的包，不提交任何内容（可用于换机器/重新拉取）",
    )
    args = parser.parse_args()

    issuer, key = read_credentials()
    manifest, guid = read_manifest()
    version = manifest.get("version") or ""
    if not version:
        sys.exit("manifest.json 里没有 version")

    if args.fetch:
        print("重新下载 %s v%s 的已签名包" % (guid, args.fetch))
        file_info = step_wait_signed(guid, args.fetch, issuer, key)
        step_download(file_info, args.fetch, issuer, key)
        return

    xpi = args.xpi or local_xpi(version)
    if not os.path.exists(xpi):
        sys.exit("找不到 %s，先跑 make build" % xpi)

    print("签名 %s v%s（%s）" % (guid, version, CHANNEL))
    upload_uuid = step_upload(xpi, issuer, key)
    step_submit(upload_uuid, guid, version, issuer, key)
    file_info = step_wait_signed(guid, version, issuer, key)
    step_download(file_info, version, issuer, key)
    print("\n完成。安装：Firefox 里打开这个 xpi，或 about:addons → 齿轮 → 从文件安装。")


if __name__ == "__main__":
    main()
