# 只做薄封装，逻辑都在 tools/ 和 test/ 里
PYTHON ?= python3
NODE   ?= node
FIREFOX ?= firefox

JS := common.js parse.js viewer.js content.js background.js viewer/viewer.js options/options.js

.DEFAULT_GOAL := help

help:
	@echo "make build    生成 dist/textable-<version>.{zip,xpi}（两者内容相同）"
	@echo "make test     冒烟测试（解析/嗅探/MIME，无需浏览器）"
	@echo "make e2e      真机端到端测试（headless Firefox + 真扩展，需 Marionette）"
	@echo "make check    语法检查 + 冒烟测试 + 打包自检"
	@echo "make icons    重新生成图标"
	@echo "make clean    删除 dist/"

build:
	$(PYTHON) tools/pack.py

xpi:
	$(PYTHON) tools/pack.py --only xpi

zip:
	$(PYTHON) tools/pack.py --only zip

test:
	$(NODE) test/smoke.test.mjs

e2e:
	FIREFOX=$(FIREFOX) $(NODE) test/e2e.mjs

check:
	@for f in $(JS); do $(NODE) --check $$f || exit 1; done
	$(NODE) test/smoke.test.mjs
	@$(PYTHON) tools/pack.py --only zip >/dev/null && echo "打包自检通过"

icons:
	$(PYTHON) tools/make-icons.py

clean:
	rm -rf dist

.PHONY: help build xpi zip test e2e check icons clean
