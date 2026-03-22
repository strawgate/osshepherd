# OSShepherd - Developer Makefile

.PHONY: all test test-e2e lint zip clean help

all: lint test

lint:
	@npx eslint .
	@npm run lint:md

test:
	@node --test test/unit/*.test.js

test-e2e:
	@npx playwright test

# Package extension for Chrome Web Store upload.
# Only includes files needed at runtime — no tests, docs, or dev tooling.
zip:
	@echo "Building osshepherd.zip…"
	@rm -f osshepherd.zip
	@zip -r osshepherd.zip \
		manifest.json \
		background.js \
		content.js \
		content.css \
		offscreen.html \
		offscreen.js \
		options.html \
		options.js \
		popup.html \
		popup.js \
		sidebar.js \
		sidepanel.html \
		sidepanel.css \
		sidepanel-mount.js \
		rules.json \
		icons/icon*.png \
		vendor/preact-htm.js \
		utils/
	@echo "Done — $$(du -h osshepherd.zip | cut -f1)"

clean:
	@rm -f *.log *.trace osshepherd.zip

help:
	@echo "Available commands:"
	@echo "  make lint     : Run ESLint + markdownlint."
	@echo "  make test     : Run unit tests."
	@echo "  make test-e2e : Run Playwright E2E tests."
	@echo "  make zip      : Package extension for Chrome Web Store."
	@echo "  make clean    : Remove logs, traces, and zip files."
