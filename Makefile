.PHONY: help install test build icons clean

help:
	@echo "Targets:"
	@echo "  install  - npm install"
	@echo "  test     - run unit tests (npm test)"
	@echo "  build    - package the extension (scripts/build.sh)"
	@echo "  icons    - regenerate icons from icons/icon.svg"
	@echo "  clean    - remove dist/"

install:
	npm install

test:
	npm test

build:
	./scripts/build.sh

icons:
	./icons/make-icons.sh

clean:
	rm -rf dist
