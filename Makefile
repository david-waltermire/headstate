.PHONY: dev build test test-rust test-ui lint lint-rust lint-ui fmt icons

dev:
	yarn tauri dev

build:
	yarn tauri build

test: test-rust test-ui

test-rust:
	cd src-tauri && cargo test

test-ui:
	yarn vitest run

lint: lint-rust lint-ui

lint-rust:
	cd src-tauri && cargo fmt --check
	cd src-tauri && cargo clippy --all-targets -- -D warnings

lint-ui:
	yarn tsc -b --force
	yarn eslint .
	yarn knip

fmt:
	cd src-tauri && cargo fmt

icons:
	python3 scripts/make-icons.py
	yarn tauri icon src-tauri/icons/icon.png
	cp src-tauri/icons/icon-master.png src-tauri/icons/icon.png
