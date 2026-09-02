#!/usr/bin/env bash
# The toast overlay's styles must survive the production build.
#
# Sonner ships its CSS twice: as a `styles.css` file, and inlined in the
# JS behind an `__insertCSS` helper that runs at mount. Vite's build
# STRIPS that helper -- it recognises the pattern and extracts the CSS --
# but the extracted CSS only reaches the stylesheet if something imports
# `sonner/dist/styles.css`. Without the import, neither path delivers:
# the JS no longer injects and the CSS was never bundled.
#
# The failure is invisible everywhere it would normally be caught. `yarn
# dev` does not extract, so it looks right. jsdom applies the injected
# CSS, so every unit test passes. Only a production bundle is wrong --
# and there the toast has no `position: fixed`, so it renders as an
# unstyled block in normal document flow at the bottom of the document,
# growing the page and raising a scrollbar.
#
# That is what the "clicking Claudify shifts the layout" reports were.
set -euo pipefail

css=$(ls dist/assets/*.css 2>/dev/null | head -1 || true)
if [ -z "$css" ]; then
  echo "ERROR: no built CSS in dist/assets/ -- run 'yarn build' first" >&2
  exit 2
fi

# The rule that matters is the toaster getting fixed positioning; the
# selector's presence alone is not enough, because the variables-only
# rule also carries that selector.
if ! grep -qE '\[data-sonner-toaster\][^{]*\{[^}]*position: *fixed' "$css"; then
  echo "ERROR: the toast overlay has no 'position: fixed' in $css" >&2
  echo "" >&2
  echo "Toasts will render in normal document flow at the bottom of the" >&2
  echo "page instead of as an overlay, growing the document and raising a" >&2
  echo "scrollbar. Ensure 'sonner/dist/styles.css' is imported (src/main.tsx)." >&2
  exit 1
fi

echo "toast css check: clean"
