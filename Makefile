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

# Requires Pillow: pip install -r scripts/requirements.txt
#
# `yarn tauri icon` also emits Windows/iOS/Android icon variants this
# macOS-only app never uses, and its ICNS encoder is non-deterministic --
# re-running against unchanged source art re-packs icon.icns with different
# compressed-stream bytes even though every image inside is pixel-identical.
# Restore the 1024 master over icon.png (as before), prune the unused
# variants, and restore the committed icon.icns bytes when its *content*
# (not raw bytes) matches what's already committed -- so a second run of
# this target leaves `git status` clean.
icons:
	python3 scripts/make-icons.py
	yarn tauri icon src-tauri/icons/icon.png
	cp src-tauri/icons/icon-master.png src-tauri/icons/icon.png
	rm -rf src-tauri/icons/android src-tauri/icons/ios
	# icon.ico is KEPT: tauri_build embeds it as a Windows resource, and
	# without it the build script fails before compiling any app code.
	# Deleting it was correct while this was macOS-only and is not now.
	rm -f src-tauri/icons/StoreLogo.png
	rm -f src-tauri/icons/Square*.png src-tauri/icons/64x64.png
	python3 scripts/make-icons.py --restore-icns-if-unchanged
