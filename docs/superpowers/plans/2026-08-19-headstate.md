# Headstate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS desktop app that shows a developer every open pull request they authored, flags the ones blocked on them, and generates a pasteable review-request list.

**Architecture:** A Tauri 2 shell with a Rust core that owns all GitHub access. One GraphQL query returns every open PR with CI, mergeability, review state, and merge-queue membership; a tokio interval polls it and emits an event to the webview. React renders snapshots and never fetches from GitHub directly. SQLite caches the last snapshot for instant cold start and records merge history for the dashboard's week/month counters.

**Tech Stack:** Tauri 2.11, React 19, Vite, TypeScript, Tailwind 4, shadcn/ui, TanStack Query 5, zustand 5, Octocrab 0.54, rusqlite 0.40, tokio 1.53, yarn 4.5.1, Apache-2.0.

**Spec:** `docs/superpowers/specs/2026-08-19-headstate-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Read-only.** v1 performs no GitHub write actions: no merge, comment, approve, close, or queue mutation. Any task adding a mutating API call is out of scope.
- **Auth.** The token comes from `gh auth token` at startup, held in memory only. Never written to SQLite, never logged, never sent anywhere but `api.github.com`. No `GITHUB_TOKEN` fallback in v1.
- **Published-artifact privacy.** No private or employer repository name, PR title, URL, or org name may appear anywhere in this repository -- README, screenshots, issue text, test fixtures, code comments, or commit messages. All fixtures use synthetic data in the `octocat/hello-world` style. CI enforces this by owner allow-list (Task 4); never by a deny-list, which would have to name what it excludes.
- **No live API in tests.** No test may contact `api.github.com`. Rust client tests use a local mock HTTP server; frontend tests use fixtures.
- **Versions.** Tauri 2.11, Octocrab 0.54, rusqlite 0.40, React 19, Tailwind 4, yarn 4.5.1. Node 24, Rust 1.93.
- **Lint gates are errors.** `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `tsc --noEmit`, `eslint`, and `knip` must all pass before any commit that ends a task.
- **Actions pinned.** Every third-party GitHub Action is pinned to a full commit SHA with a trailing comment naming the release.
- **Platform.** macOS only in v1. Tray icons are template images (pure black + alpha, filename ending in `Template`).
- **Product copy.** The app name is `Headstate`; the tagline is `Your work. Your pull requests. One clear status.`

---

## File Structure

**Rust core (`src-tauri/src/`)**

| File | Responsibility |
|---|---|
| `lib.rs` | Tauri builder, plugin/state registration, tray setup |
| `auth.rs` | Run `gh auth token`, build Octocrab client, typed `AuthError` |
| `github/query.rs` | GraphQL document constants |
| `github/model.rs` | `PullRequest`, `CiState`, `MergeState`, `ReviewState`, `Stats` |
| `github/map.rs` | GraphQL JSON → model; the `UNKNOWN` mergeable rule |
| `github/client.rs` | `GitHubClient`: fetch_prs, fetch_stats; mockable base URL |
| `poll.rs` | tokio interval, focus-aware cadence, emits `prs-updated` |
| `store/schema.rs` | Numbered migrations, `open_db` |
| `store/cache.rs` | Snapshot read/write |
| `store/history.rs` | Merge-event records for week/month counters |
| `commands.rs` | Tauri commands: `get_cached`, `refresh_now`, `get_stats`, `get_auth_state`, `get_settings`, `set_settings` |
| `tray.rs` | Tray icon, menu, badge text, close-to-tray |

**Frontend (`src/`)**

| File | Responsibility |
|---|---|
| `api/tauri.ts` | Typed `invoke` wrappers |
| `api/hooks.ts` | TanStack Query hooks + `prs-updated` listener |
| `types/pr.ts` | TS mirrors of the Rust model |
| `store/filters.ts` | zustand: filters, selected repo, view |
| `store/wizard.ts` | zustand: wizard step + selections |
| `lib/derive.ts` | Pure derivations: priorities, stale, counts |
| `lib/nudge.ts` | The four output formatters |
| `lib/labels.ts` | GitHub label color → readable foreground |
| `lib/time.ts` | Relative time ("2 days ago") |
| `components/` | `PrList`, `PrRow`, `FilterBar`, `PrioritiesStrip`, `RepoSidebar`, `Dashboard`, `StatCard`, `NudgeWizard`, `AuthGate` |
| `splash.ts` | Splash dismissal, app-driven |

**Fixtures:** `src/fixtures/prs.ts` and `src-tauri/tests/fixtures/*.json` — synthetic only.

---

## Milestone 1 — Foundation

### Task 1: Scaffold the Tauri + React app

**Files:**
- Create: `package.json`, `.yarnrc.yml`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `.gitignore`, `Makefile`

**Interfaces:**
- Consumes: nothing
- Produces: a running `yarn tauri dev`; `Makefile` targets `dev`, `build`, `test`, `lint`, `fmt`

- [ ] **Step 1: Initialize the frontend package**

```bash
cd /path/to/headstate
yarn init -2
yarn set version 4.5.1
printf 'nodeLinker: node-modules\n' > .yarnrc.yml
yarn add react@^19 react-dom@^19 @tauri-apps/api@^2 @tanstack/react-query@^5 zustand@^5
yarn add -D vite@^8 @vitejs/plugin-react@^6 typescript@~5.8 @types/react@^19 @types/react-dom@^19 \
  tailwindcss@^4 @tailwindcss/vite@^4 @tauri-apps/cli@^2 vitest@^4 @vitest/coverage-v8@^4 \
  jsdom@^30 @testing-library/react@^16 @testing-library/dom@^10 \
  eslint@^10 @eslint/js@^10 typescript-eslint@^8 eslint-plugin-react-hooks@^7 \
  eslint-plugin-react-refresh@^0.5 globals@^17 knip@^6
```

- [ ] **Step 2: Add package.json scripts**

```json
{
  "name": "headstate",
  "private": true,
  "version": "0.1.0",
  "packageManager": "yarn@4.5.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "test": "vitest run",
    "lint": "eslint ."
  }
}
```

- [ ] **Step 3: Configure Vite for Tauri**

Create `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed port and fails if it is taken.
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    coverage: { provider: "v8", reporter: ["text", "json-summary"] },
  },
});
```

- [ ] **Step 4: Scaffold the Rust side**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "headstate"
version = "0.1.0"
license = "Apache-2.0"
description = "Your work. Your pull requests. One clear status."
repository = "https://github.com/pktstorm/headstate"
edition = "2021"

[lib]
name = "headstate_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.11", features = ["tray-icon", "image-png"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
octocrab = "0.54"
rusqlite = { version = "0.40", features = ["bundled"] }
tokio = { version = "1.53", features = ["full"] }
thiserror = "2"
chrono = { version = "0.4", features = ["serde"] }

[dev-dependencies]
tempfile = "3"
wiremock = "0.6"
```

- [ ] **Step 5: Configure the Tauri window**

Create `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Headstate",
  "version": "0.1.0",
  "identifier": "com.pktstorm.headstate",
  "build": {
    "beforeDevCommand": "yarn dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "yarn build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Headstate",
        "width": 1400,
        "height": 900,
        "minWidth": 1000,
        "minHeight": 640,
        "label": "main",
        "theme": "Dark",
        "backgroundColor": "#0d1117"
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ]
  }
}
```

- [ ] **Step 6: Add the Makefile**

```makefile
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
	yarn tsc --noEmit
	yarn eslint .
	yarn knip

fmt:
	cd src-tauri && cargo fmt

icons:
	python3 scripts/make-icons.py
```

- [ ] **Step 7: Verify it runs**

Run: `make dev`
Expected: a dark 1400×900 window titled "Headstate" opens.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Tauri + React + Tailwind app"
```

---

### Task 2: Generate the app and tray icons

**Files:**
- Create: `scripts/make-icons.py`, `src-tauri/icons/*`, `public/splash.png`
- Modify: `Makefile` (already has the `icons` target from Task 1)

**Interfaces:**
- Consumes: the splash artwork at `~/Downloads/Headstate-Splash-1600x1000.png`
- Produces: `src-tauri/icons/icon.icns` and `trayTemplate{,@2x,@3x}.png`

- [ ] **Step 1: Write the icon generation script**

The app icon needs Apple's continuous-curvature squircle baked in — macOS does not mask app icons the way iOS does, and a plain rounded rect reads visibly wrong in the Dock. Art occupies the inner 824×824 of a 1024 canvas.

Create `scripts/make-icons.py`:

```python
#!/usr/bin/env python3
"""Generate macOS app and tray icons from the Headstate splash art.

Two very different targets:

* App icon: 1024x1024 sRGB PNG with alpha. macOS does NOT mask app icons
  (unlike iOS), so the squircle is baked in here -- and it must be Apple's
  continuous-curvature squircle, not a CSS-style rounded rect, or it reads
  wrong beside every other Dock icon. Art fills the inner 824x824.

* Tray icon: a template image. Pure black artwork plus alpha, no color at
  all. The `Template` filename suffix is what tells macOS to invert it for
  light/dark menu bars and highlight it on click.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

SPLASH = Path.home() / "Downloads" / "Headstate-Splash-1600x1000.png"
ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
PUBLIC = Path(__file__).resolve().parent.parent / "public"

CANVAS = 1024
ART = 824


def squircle_mask(size: int, radius_ratio: float = 0.2225) -> Image.Image:
    """Apple's icon shape, approximated by a superellipse.

    n=5 matches the macOS Big Sur+ icon curvature far better than a
    circular-corner rounded rectangle does.
    """
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    n = 5.0
    half = size * 2
    pts = []
    steps = 2048
    for i in range(steps):
        t = 2.0 * 3.141592653589793 * i / steps
        import math
        c, s = math.cos(t), math.sin(t)
        x = half * (abs(c) ** (2.0 / n)) * (1 if c >= 0 else -1)
        y = half * (abs(s) ** (2.0 / n)) * (1 if s >= 0 else -1)
        pts.append((half + x, half + y))
    draw.polygon(pts, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def crop_glyph(splash: Image.Image) -> Image.Image:
    """Cut the branch mark out of the splash, above the wordmark.

    The source splash is a flat, fully-opaque RGB(A) image -- there is no
    transparency around the glyph. A naive crop therefore carries its own
    near-black background rectangle as opaque pixels, which shows up as a
    visible seam on the app icon and turns the tray silhouette into a solid
    black square. Key the near-black background out to alpha=0 so only the
    glyph strokes/nodes survive.
    """
    w, h = splash.size
    # The mark sits centered in the upper ~62% of the 1600x1000 art.
    box = (int(w * 0.32), int(h * 0.13), int(w * 0.68), int(h * 0.66))
    glyph = splash.crop(box).convert("RGBA")
    px = glyph.load()
    gw, gh = glyph.size
    bg_thresh = 45  # max(r, g, b) below this is background, not glyph.
    for y in range(gh):
        for x in range(gw):
            r, g, b, a = px[x, y]
            if max(r, g, b) <= bg_thresh:
                px[x, y] = (r, g, b, 0)
    return glyph


def make_app_icon(glyph: Image.Image) -> None:
    bg = Image.new("RGBA", (CANVAS, CANVAS), (13, 17, 23, 255))
    art = glyph.copy()
    art.thumbnail((ART, ART), Image.LANCZOS)
    bg.paste(art, ((CANVAS - art.width) // 2, (CANVAS - art.height) // 2), art)
    bg.putalpha(squircle_mask(CANVAS))
    ICONS.mkdir(parents=True, exist_ok=True)
    bg.save(ICONS / "icon.png")
    print(f"wrote {ICONS / 'icon.png'} ({CANVAS}x{CANVAS})")


def make_tray_icons(glyph: Image.Image) -> None:
    """Template image: silhouette in black, everything else transparent."""
    for scale, name in ((1, "trayTemplate.png"), (2, "trayTemplate@2x.png"),
                        (3, "trayTemplate@3x.png")):
        size = 22 * scale
        g = glyph.copy().convert("RGBA")
        g.thumbnail((size, size), Image.LANCZOS)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(g, ((size - g.width) // 2, (size - g.height) // 2), g)
        # Any pixel with meaningful alpha becomes opaque black.
        px = out.load()
        for y in range(size):
            for x in range(size):
                r, gg, b, a = px[x, y]
                px[x, y] = (0, 0, 0, 255 if a > 40 else 0)
        out.save(ICONS / name)
        print(f"wrote {ICONS / name} ({size}x{size})")


def main() -> int:
    if not SPLASH.exists():
        print(f"missing splash art: {SPLASH}", file=sys.stderr)
        return 1
    splash = Image.open(SPLASH).convert("RGBA")
    PUBLIC.mkdir(parents=True, exist_ok=True)
    splash.save(PUBLIC / "splash.png")
    glyph = crop_glyph(splash)
    make_app_icon(glyph)
    make_tray_icons(glyph)
    print("\nNow run: yarn tauri icon src-tauri/icons/icon.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run it**

```bash
python3 -m pip install --quiet Pillow
make icons
yarn tauri icon src-tauri/icons/icon.png
```

Expected: `icon.icns`, sized PNGs, and three `trayTemplate` files in `src-tauri/icons/`.

- [ ] **Step 3: Verify the tray icons are true template images**

```bash
python3 - <<'EOF'
from PIL import Image
for n in ("trayTemplate.png", "trayTemplate@2x.png", "trayTemplate@3x.png"):
    im = Image.open(f"src-tauri/icons/{n}").convert("RGBA")
    colors = {p[:3] for p in im.getdata() if p[3] > 0}
    assert colors <= {(0, 0, 0)}, f"{n} has non-black pixels: {colors}"
    print(f"{n}: {im.size} OK - pure black + alpha")
EOF
```

Expected: three OK lines. A failure here means the template rule is violated and macOS will render the tray icon wrong.

- [ ] **Step 4: Commit**

```bash
git add scripts/make-icons.py src-tauri/icons public/splash.png
git commit -m "feat: generate macOS app and tray template icons"
```

---

### Task 3: Splash screen

**Files:**
- Modify: `index.html`
- Create: `src/splash.ts`, `src/splash.test.ts`

**Interfaces:**
- Consumes: `public/splash.png` from Task 2
- Produces: `dismissSplash(doc?: Document, fadeMs?: number): void`

- [ ] **Step 1: Write the failing test**

Create `src/splash.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { dismissSplash } from "./splash";

function withSplash(): Document {
  const doc = document.implementation.createHTMLDocument("t");
  const el = doc.createElement("div");
  el.id = "splash";
  doc.body.appendChild(el);
  return doc;
}

describe("dismissSplash", () => {
  it("removes the splash element after the fade", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400);
    vi.advanceTimersByTime(600);
    expect(doc.getElementById("splash")).toBeNull();
    vi.useRealTimers();
  });

  it("is safe to call when no splash exists", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(() => dismissSplash(doc)).not.toThrow();
  });

  it("is safe to call twice", () => {
    vi.useFakeTimers();
    const doc = withSplash();
    dismissSplash(doc, 400);
    expect(() => dismissSplash(doc, 400)).not.toThrow();
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `yarn vitest run src/splash.test.ts`
Expected: FAIL — cannot resolve `./splash`.

- [ ] **Step 3: Implement**

Create `src/splash.ts`:

```ts
/// Dismiss the launch splash defined in `index.html`.
///
/// The splash lives in static HTML rather than React because `<body>` is
/// empty until React mounts, and the webview paints its own default white
/// in the meantime. Dismissal is app-driven, not timed: a fixed delay would
/// either uncover an empty UI on a slow machine or linger on a fast one.

const SPLASH_ID = "splash";
const HIDING = "headstate-hiding";

/// Must match the CSS transition duration in `index.html`.
const FADE_MS = 400;

export function dismissSplash(doc: Document = document, fadeMs: number = FADE_MS): void {
  const el = doc.getElementById(SPLASH_ID);
  if (!el || el.classList.contains(HIDING)) return;

  el.classList.add(HIDING);

  const remove = () => el.remove();
  // `transitionend` never fires for an unrendered element -- a background
  // window, or prefers-reduced-motion disabling the transition. The timeout
  // guarantees removal either way. Removal matters: a fixed inset-0 element
  // left in place swallows every click even at zero opacity.
  el.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, fadeMs + 100);
}
```

- [ ] **Step 4: Add the splash markup**

In `index.html`, inside `<body>` before the React root:

```html
<div id="splash">
  <img src="/splash.png" alt="Headstate" />
</div>
<style>
  #splash {
    position: fixed; inset: 0; z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    background: #0d1117; opacity: 1; transition: opacity 400ms ease;
  }
  #splash img { width: 100%; height: 100%; object-fit: cover; }
  #splash.headstate-hiding { opacity: 0; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { #splash { transition: none; } }
</style>
```

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run src/splash.test.ts`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add index.html src/splash.ts src/splash.test.ts
git commit -m "feat: app-driven splash screen"
```

---

### Task 4: CI pipeline

**Files:**
- Create: `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `eslint.config.js`, `knip.json`, `src-tauri/deny.toml`, `scripts/check-privacy.sh`

**Interfaces:**
- Consumes: the Makefile targets from Task 1
- Produces: a green CI run on every PR

- [ ] **Step 1: Write the composite setup action**

Create `.github/actions/setup/action.yml`:

```yaml
name: setup
description: Node, yarn, and Rust with caching
inputs:
  rust-components:
    description: Extra rustup components, comma separated
    required: false
    default: ""
runs:
  using: composite
  steps:
    - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
      with:
        node-version: "24"
    - shell: bash
      run: corepack enable && yarn install --immutable
    - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable
      with:
        toolchain: stable
        components: ${{ inputs.rust-components }}
    - uses: Swatinem/rust-cache@98c8021b550208e191a6a3145459bfc9fb29c4c0 # v2.8.1
      with:
        workspaces: src-tauri
```

- [ ] **Step 2: Write the privacy guard**

This enforces the Global Constraint that no employer repo names reach published files.

Create `scripts/check-privacy.sh`:

```bash
#!/usr/bin/env bash
# Headstate is a public repo. At runtime it queries every org the user can
# see -- that is the product. But committed files must never name a private
# or employer repository, because a leak here is permanent and public.
#
# This is an ALLOW-list, deliberately. A deny-list would have to spell out
# the very names it exists to keep out, putting them in the repo in plain
# text and defeating itself. An allow-list also catches owners nobody
# thought to enumerate.
#
# Two patterns are scanned, both anchored so they cannot match ordinary
# prose. An earlier unanchored `owner/repo` pattern matched things like
# `api/hooks.ts`, `read/write`, and `5000/hour` -- a gate that cries wolf
# gets disabled, so anchoring is load-bearing, not tidiness.
#   1. github.com/<owner>/<repo>   -- any GitHub URL
#   2. <owner>/<repo>#<number>     -- the PR/issue shorthand
set -euo pipefail

# The only repository owners this project legitimately references.
# `org` and `owner` are the generic placeholders used in format examples
# (`- [org/repo#123] Title`), not real accounts.
ALLOWED='octocat|pktstorm|tauri-apps|shadcn-ui|rust-lang|actions|dtolnay|Swatinem|org|owner'

# Lockfiles are machine-generated dependency graphs naming hundreds of
# upstream repos; they are not a leak vector for private names.
EXCLUDES=(':!scripts/check-privacy.sh' ':!yarn.lock' ':!src-tauri/Cargo.lock')

urls=$(git grep -hoIE 'github\.com/[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+' \
         -- "${EXCLUDES[@]}" 2>/dev/null \
       | sed -E 's#.*github\.com/##' || true)

refs=$(git grep -hoIE '[A-Za-z0-9][-A-Za-z0-9_.]*/[A-Za-z0-9][-A-Za-z0-9_.]+#[0-9]+' \
         -- "${EXCLUDES[@]}" 2>/dev/null \
       | sed -E 's/#[0-9]+$//' || true)

found=$(printf '%s\n%s\n' "$urls" "$refs" \
        | grep -vE '^[[:space:]]*$' \
        | grep -vE "^($ALLOWED)/" \
        | sort -u || true)

if [ -n "$found" ]; then
  echo "ERROR: repository references with a non-allow-listed owner:"
  echo "$found" | sed 's/^/  /'
  echo
  echo "Use synthetic fixtures (octocat/hello-world), or add the owner to"
  echo "ALLOWED in this script if it is a legitimate public dependency."
  exit 1
fi

echo "privacy check: clean"
```

Make it executable: `chmod +x scripts/check-privacy.sh`

- [ ] **Step 3: Write the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# Least privilege by default; jobs needing more say so themselves.
permissions:
  contents: read

# Third-party actions are pinned to full commit SHAs, not floating tags.
# A tag is mutable: whoever controls the action repo can repoint it at new
# code that then runs with this job's permissions. The trailing comment
# records which release each SHA is, since a bare SHA is unreadable.

jobs:
  lint:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup
        with:
          rust-components: clippy, rustfmt
      - name: Privacy guard
        run: ./scripts/check-privacy.sh
      - name: Rust formatting
        working-directory: src-tauri
        run: cargo fmt --check
      - name: Typecheck
        run: yarn tsc --noEmit
      - name: ESLint
        run: yarn eslint .
      - name: Knip
        run: yarn knip
      - name: Clippy
        working-directory: src-tauri
        run: cargo clippy --all-targets -- -D warnings

  test-rust:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup
      - name: Rust tests
        working-directory: src-tauri
        run: cargo test
      # Tests share a process, so state-touching changes can fail
      # intermittently. One green run does not prove a race is absent.
      - name: Race check
        working-directory: src-tauri
        run: |
          for i in $(seq 1 10); do
            cargo test --lib -- --test-threads=8 || { echo "FAILED ON ITERATION $i"; exit 1; }
          done

  test-frontend:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup
      - name: Frontend tests
        run: yarn vitest run

  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup
      - name: Build the app bundle
        run: yarn tauri build --bundles app

  supply-chain:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup
      - name: Install cargo-deny
        run: cargo install cargo-deny --locked
      - name: cargo-deny
        working-directory: src-tauri
        run: cargo deny check
      - name: Yarn audit
        run: yarn npm audit --environment production --severity high
```

- [ ] **Step 4: Add eslint, knip, and deny configs**

`eslint.config.js`:

```js
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "coverage"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
);
```

`knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["src/main.tsx", "vite.config.ts"],
  "project": ["src/**/*.{ts,tsx}"],
  "ignoreDependencies": [
    "@tanstack/react-query",
    "@tauri-apps/api",
    "lucide-react",
    "zustand",
    "@testing-library/dom",
    "@testing-library/react",
    "tailwindcss"
  ]
}
```

**Why the long `ignoreDependencies`:** these are installed in Task 1 but not
imported until Tasks 8-20. Without the ignores, knip reports six unused
dependencies and CI stays red from Task 4 until Task 20 -- and a permanently
red gate is an ignored gate. `tailwindcss` is a genuine false positive: it is
imported from CSS (`@import "tailwindcss"`), which knip does not follow.
Verified: `yarn knip` exits 0 with this config against the Task 1-3 tree.

`src-tauri/deny.toml`:

```toml
# Scoped to macOS: the full cross-platform graph reports findings from
# GTK/X11/Windows crates that never compile here, and a permanently red
# gate is an ignored gate.
targets = [
  { triple = "aarch64-apple-darwin" },
  { triple = "x86_64-apple-darwin" },
]

[advisories]
version = 2

[licenses]
version = 2
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause",
         "BSD-3-Clause", "ISC", "Unicode-3.0", "Zlib", "MPL-2.0", "CC0-1.0"]

[bans]
multiple-versions = "warn"
wildcards = "deny"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

- [ ] **Step 5: Verify locally**

Run: `make lint && ./scripts/check-privacy.sh`
Expected: all gates pass, "privacy check: clean".

- [ ] **Step 6: Commit**

```bash
git add .github scripts/check-privacy.sh eslint.config.js knip.json src-tauri/deny.toml
git commit -m "ci: lint, test, build, supply-chain, and privacy gates"
```

---

### Task 5: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the Tauri bundle config from Task 1
- Produces: a GitHub Release with `.dmg` and `.app.tar.gz` on every `v*` tag

- [ ] **Step 1: Write the workflow**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup

      # Universal so one download runs on both Apple Silicon and Intel.
      - name: Add Intel target
        run: rustup target add x86_64-apple-darwin

      - name: Build universal bundle
        run: yarn tauri build --target universal-apple-darwin --bundles app,dmg

      - name: Publish release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle
          tar -czf "Headstate-${GITHUB_REF_NAME}.app.tar.gz" -C "$BUNDLE/macos" Headstate.app
          gh release create "$GITHUB_REF_NAME" \
            --title "Headstate ${GITHUB_REF_NAME}" \
            --generate-notes \
            "Headstate-${GITHUB_REF_NAME}.app.tar.gz" \
            "$BUNDLE"/dmg/*.dmg
```

- [ ] **Step 2: Validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish universal macOS bundles on tagged releases"
```

**Note:** the app is unsigned in v1. The release notes must tell users to run
`xattr -dr com.apple.quarantine /Applications/Headstate.app` on first launch, or
Gatekeeper will refuse to open it. Signing and notarization are deferred.

---

## Milestone 2 — Data layer

### Task 6: Authentication via `gh auth token`

**Files:**
- Create: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub enum AuthError { GhNotFound, GhNotLoggedIn(String), Io(std::io::Error) }`
  - `pub fn read_token_from(output: std::process::Output) -> Result<String, AuthError>`
  - `pub fn read_token() -> Result<String, AuthError>`
  - `pub fn build_client(token: &str) -> Result<octocrab::Octocrab, AuthError>`

- [ ] **Step 1: Write the failing tests**

Splitting the pure parsing out of the subprocess call is what makes this
testable without spawning `gh`.

Create the test module at the bottom of `src-tauri/src/auth.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn trims_the_token() {
        let t = read_token_from(output(0, "gho_abc123\n", "")).unwrap();
        assert_eq!(t, "gho_abc123");
    }

    #[test]
    fn reports_logged_out() {
        let err = read_token_from(output(1, "", "not logged in")).unwrap_err();
        assert!(matches!(err, AuthError::GhNotLoggedIn(_)));
    }

    #[test]
    fn empty_stdout_is_logged_out_not_a_valid_token() {
        let err = read_token_from(output(0, "   \n", "")).unwrap_err();
        assert!(matches!(err, AuthError::GhNotLoggedIn(_)));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test auth`
Expected: FAIL — `read_token_from` not found.

- [ ] **Step 3: Implement**

```rust
//! Authentication.
//!
//! The token comes from `gh auth token` and is held in memory only: never
//! written to SQLite, never logged, never sent anywhere but api.github.com.
//! Delegating credential storage to `gh` means Headstate carries no
//! credential-handling code of its own.

use std::process::{Command, Output};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("the GitHub CLI (gh) is not installed or not on PATH")]
    GhNotFound,
    #[error("gh is installed but not logged in: {0}")]
    GhNotLoggedIn(String),
    #[error("failed to run gh: {0}")]
    Io(#[from] std::io::Error),
}

/// Parse `gh auth token` output. Split from the subprocess call so it can be
/// tested without spawning anything.
pub fn read_token_from(out: Output) -> Result<String, AuthError> {
    if !out.status.success() {
        return Err(AuthError::GhNotLoggedIn(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // A zero exit with empty stdout would otherwise become an empty bearer
    // token and fail much later as a confusing 401.
    if token.is_empty() {
        return Err(AuthError::GhNotLoggedIn("gh returned an empty token".into()));
    }
    Ok(token)
}

pub fn read_token() -> Result<String, AuthError> {
    let out = Command::new("gh").args(["auth", "token"]).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AuthError::GhNotFound
        } else {
            AuthError::Io(e)
        }
    })?;
    read_token_from(out)
}

pub fn build_client(token: &str) -> Result<octocrab::Octocrab, AuthError> {
    octocrab::Octocrab::builder()
        .personal_token(token.to_string())
        .build()
        .map_err(|e| AuthError::GhNotLoggedIn(e.to_string()))
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test auth`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/lib.rs
git commit -m "feat: authenticate via gh auth token"
```

---

### Task 7: The PR model and GraphQL mapping

**Files:**
- Create: `src-tauri/src/github/mod.rs`, `src-tauri/src/github/model.rs`, `src-tauri/src/github/query.rs`, `src-tauri/src/github/map.rs`, `src-tauri/tests/fixtures/search.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub struct PullRequest { number: u64, title: String, url: String, repo: String, author: String, is_draft: bool, created_at: DateTime<Utc>, updated_at: DateTime<Utc>, ci: CiState, merge: MergeState, review: ReviewState, in_merge_queue: bool, labels: Vec<Label>, comment_count: u64 }`
  - `pub enum CiState { Success, Failure, Pending, None }`
  - `pub enum MergeState { Mergeable, Conflicted, Checking }`
  - `pub enum ReviewState { Approved, ChangesRequested, ReviewRequired, None }`
  - `pub struct Label { name: String, color: String }`
  - `pub fn map_search(v: &serde_json::Value) -> Vec<PullRequest>`
  - `pub const PRS_QUERY: &str`

- [ ] **Step 1: Create the synthetic fixture**

Per the Global Constraints, fixtures must be synthetic. Create
`src-tauri/tests/fixtures/search.json`:

```json
{
  "search": {
    "issueCount": 3,
    "nodes": [
      {
        "number": 42,
        "title": "Add retry to the fetch client",
        "url": "https://github.com/octocat/hello-world/pull/42",
        "isDraft": false,
        "createdAt": "2026-08-18T10:00:00Z",
        "updatedAt": "2026-08-18T12:00:00Z",
        "author": { "login": "octocat" },
        "repository": { "nameWithOwner": "octocat/hello-world" },
        "mergeable": "MERGEABLE",
        "reviewDecision": "APPROVED",
        "isInMergeQueue": false,
        "totalCommentsCount": 2,
        "labels": { "nodes": [{ "name": "enhancement", "color": "a2eeef" }] },
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
      },
      {
        "number": 43,
        "title": "Fix flaky timezone test",
        "url": "https://github.com/octocat/hello-world/pull/43",
        "isDraft": true,
        "createdAt": "2026-08-17T10:00:00Z",
        "updatedAt": "2026-08-17T10:30:00Z",
        "author": { "login": "octocat" },
        "repository": { "nameWithOwner": "octocat/hello-world" },
        "mergeable": "CONFLICTING",
        "reviewDecision": "CHANGES_REQUESTED",
        "isInMergeQueue": false,
        "totalCommentsCount": 5,
        "labels": { "nodes": [{ "name": "bug", "color": "d73a4a" }] },
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
      },
      {
        "number": 7,
        "title": "Bump the parser dependency",
        "url": "https://github.com/octocat/spoon-knife/pull/7",
        "isDraft": false,
        "createdAt": "2026-08-16T09:00:00Z",
        "updatedAt": "2026-08-16T09:00:00Z",
        "author": { "login": "octocat" },
        "repository": { "nameWithOwner": "octocat/spoon-knife" },
        "mergeable": "UNKNOWN",
        "reviewDecision": null,
        "isInMergeQueue": true,
        "totalCommentsCount": 0,
        "labels": { "nodes": [] },
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": null } }] }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

The `UNKNOWN` case is the one that matters most — mapping it to `Conflicted`
would flash a false "needs rebase" on every push.

In `src-tauri/src/github/map.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::{CiState, MergeState, ReviewState};

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap()
    }

    #[test]
    fn maps_all_prs() {
        assert_eq!(map_search(&fixture()).len(), 3);
    }

    #[test]
    fn maps_a_green_approved_pr() {
        let prs = map_search(&fixture());
        let pr = &prs[0];
        assert_eq!(pr.number, 42);
        assert_eq!(pr.repo, "octocat/hello-world");
        assert_eq!(pr.author, "octocat");
        assert_eq!(pr.ci, CiState::Success);
        assert_eq!(pr.merge, MergeState::Mergeable);
        assert_eq!(pr.review, ReviewState::Approved);
        assert_eq!(pr.labels.len(), 1);
        assert_eq!(pr.labels[0].name, "enhancement");
    }

    #[test]
    fn maps_a_conflicted_failing_draft() {
        let pr = map_search(&fixture()).into_iter().find(|p| p.number == 43).unwrap();
        assert!(pr.is_draft);
        assert_eq!(pr.ci, CiState::Failure);
        assert_eq!(pr.merge, MergeState::Conflicted);
        assert_eq!(pr.review, ReviewState::ChangesRequested);
        assert_eq!(pr.comment_count, 5);
    }

    /// GitHub computes mergeability lazily and returns UNKNOWN right after a
    /// push. Mapping that to Conflicted would show a false "needs rebase".
    #[test]
    fn unknown_mergeable_maps_to_checking_never_conflicted() {
        let pr = map_search(&fixture()).into_iter().find(|p| p.number == 7).unwrap();
        assert_eq!(pr.merge, MergeState::Checking);
        assert_ne!(pr.merge, MergeState::Conflicted);
    }

    /// A PR with no CI configured has no rollup at all.
    #[test]
    fn missing_status_rollup_maps_to_none() {
        let pr = map_search(&fixture()).into_iter().find(|p| p.number == 7).unwrap();
        assert_eq!(pr.ci, CiState::None);
        assert!(pr.in_merge_queue);
    }

    #[test]
    fn malformed_nodes_are_skipped_not_panicked_on() {
        let v = serde_json::json!({"search": {"nodes": [{"number": 1}, null]}});
        assert_eq!(map_search(&v).len(), 0);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test github::map`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the model**

`src-tauri/src/github/model.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiState { Success, Failure, Pending, None }

/// Three states, not two. `Checking` exists because GitHub computes
/// mergeability lazily and reports UNKNOWN until it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeState { Mergeable, Conflicted, Checking }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState { Approved, ChangesRequested, ReviewRequired, None }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label { pub name: String, pub color: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    pub is_draft: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ci: CiState,
    pub merge: MergeState,
    pub review: ReviewState,
    pub in_merge_queue: bool,
    pub labels: Vec<Label>,
    pub comment_count: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stats {
    pub merged_week: u64,
    pub merged_month: u64,
    pub in_merge_queue: u64,
    pub needs_attention: u64,
    pub awaiting_review: u64,
    pub ready_to_queue: u64,
    pub blocked_by_comments: u64,
}
```

- [ ] **Step 5: Implement the query**

`src-tauri/src/github/query.rs`:

```rust
/// One query returns every open PR with everything the UI needs: CI rollup,
/// mergeability, review decision, merge-queue membership, and labels.
/// Measured at 27 PRs in ~2.9s for 2 rate-limit points of 5000/hour.
pub const PRS_QUERY: &str = r#"
query($q: String!) {
  rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt
        author { login }
        repository { nameWithOwner }
        mergeable reviewDecision isInMergeQueue totalCommentsCount
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}"#;

/// The dashboard counters, as one aliased query costing 1 point.
/// `$week` and `$month` are ISO dates.
pub const STATS_QUERY: &str = r#"
query($week: String!, $month: String!) {
  merged_week: search(query: $week, type: ISSUE) { issueCount }
  merged_month: search(query: $month, type: ISSUE) { issueCount }
}"#;
```

- [ ] **Step 6: Implement the mapping**

`src-tauri/src/github/map.rs`:

```rust
use super::model::{CiState, Label, MergeState, PullRequest, ReviewState};
use chrono::{DateTime, Utc};
use serde_json::Value;

fn ts(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    v[key].as_str()?.parse::<DateTime<Utc>>().ok()
}

fn ci_state(node: &Value) -> CiState {
    let state = node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str();
    match state {
        Some("SUCCESS") => CiState::Success,
        Some("FAILURE") | Some("ERROR") => CiState::Failure,
        Some("PENDING") | Some("EXPECTED") => CiState::Pending,
        // No rollup at all means the repo runs no checks on this PR.
        _ => CiState::None,
    }
}

fn merge_state(node: &Value) -> MergeState {
    match node["mergeable"].as_str() {
        Some("MERGEABLE") => MergeState::Mergeable,
        Some("CONFLICTING") => MergeState::Conflicted,
        // UNKNOWN and anything unrecognised. Never Conflicted: GitHub
        // reports UNKNOWN while it computes, and a false conflict warning
        // would fire on every push.
        _ => MergeState::Checking,
    }
}

fn review_state(node: &Value) -> ReviewState {
    match node["reviewDecision"].as_str() {
        Some("APPROVED") => ReviewState::Approved,
        Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
        Some("REVIEW_REQUIRED") => ReviewState::ReviewRequired,
        _ => ReviewState::None,
    }
}

fn labels(node: &Value) -> Vec<Label> {
    node["labels"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    Some(Label {
                        name: l["name"].as_str()?.to_string(),
                        color: l["color"].as_str().unwrap_or("cccccc").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn map_node(node: &Value) -> Option<PullRequest> {
    Some(PullRequest {
        number: node["number"].as_u64()?,
        title: node["title"].as_str()?.to_string(),
        url: node["url"].as_str()?.to_string(),
        repo: node["repository"]["nameWithOwner"].as_str()?.to_string(),
        author: node["author"]["login"].as_str().unwrap_or("unknown").to_string(),
        is_draft: node["isDraft"].as_bool().unwrap_or(false),
        created_at: ts(node, "createdAt")?,
        updated_at: ts(node, "updatedAt")?,
        ci: ci_state(node),
        merge: merge_state(node),
        review: review_state(node),
        in_merge_queue: node["isInMergeQueue"].as_bool().unwrap_or(false),
        labels: labels(node),
        comment_count: node["totalCommentsCount"].as_u64().unwrap_or(0),
    })
}

/// Map a search response. Note the response passed here is Octocrab's
/// already-unwrapped `data` object, so `search` is at the top level.
/// Nodes that fail to map are skipped rather than failing the whole poll:
/// one malformed PR should not blank the list.
pub fn map_search(v: &Value) -> Vec<PullRequest> {
    v["search"]["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(map_node).collect())
        .unwrap_or_default()
}
```

- [ ] **Step 7: Run the tests**

Run: `cd src-tauri && cargo test github`
Expected: 6 passing.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/github src-tauri/tests/fixtures
git commit -m "feat: PR model and GraphQL mapping with lazy-mergeable handling"
```

---

### Task 8: The GitHub client

**Files:**
- Create: `src-tauri/src/github/client.rs`
- Modify: `src-tauri/src/github/mod.rs`

**Interfaces:**
- Consumes: `PRS_QUERY`, `STATS_QUERY`, `map_search` (Task 7); `build_client` (Task 6)
- Produces:
  - `pub struct GitHubClient { octocrab: Octocrab }`
  - `pub fn new(octocrab: Octocrab) -> GitHubClient`
  - `pub async fn fetch_prs(&self) -> Result<Vec<PullRequest>, ClientError>`
  - `pub async fn fetch_stats(&self, now: DateTime<Utc>) -> Result<Stats, ClientError>`

- [ ] **Step 1: Write the failing test against a mock server**

No test may contact the live API. `wiremock` gives a local server that
Octocrab can be pointed at.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client_for(server: &MockServer) -> GitHubClient {
        let oc = octocrab::Octocrab::builder()
            .base_uri(server.uri())
            .unwrap()
            .personal_token("test-token".to_string())
            .build()
            .unwrap();
        GitHubClient::new(oc)
    }

    #[tokio::test]
    async fn fetch_prs_maps_the_response() {
        let server = MockServer::start().await;
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": body
            })))
            .mount(&server)
            .await;

        let prs = client_for(&server).await.fetch_prs().await.unwrap();
        assert_eq!(prs.len(), 3);
        assert_eq!(prs[0].number, 42);
    }

    #[tokio::test]
    async fn an_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server).await.fetch_prs().await.is_err());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test github::client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```rust
use super::map::map_search;
use super::model::{PullRequest, Stats};
use super::query::{PRS_QUERY, STATS_QUERY};
use chrono::{DateTime, Duration, Utc};
use octocrab::Octocrab;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("GitHub request failed: {0}")]
    Api(#[from] octocrab::Error),
}

pub struct GitHubClient {
    octocrab: Octocrab,
}

impl GitHubClient {
    pub fn new(octocrab: Octocrab) -> Self {
        Self { octocrab }
    }

    /// Every open PR authored by the viewer, with CI, mergeability, review
    /// decision, and merge-queue state.
    ///
    /// Octocrab unwraps the GraphQL `data` envelope, so the value returned
    /// here has `search` at its top level rather than under `data`.
    pub async fn fetch_prs(&self) -> Result<Vec<PullRequest>, ClientError> {
        let v: serde_json::Value = self
            .octocrab
            .graphql(&json!({
                "query": PRS_QUERY,
                "variables": { "q": "is:pr is:open author:@me" }
            }))
            .await?;
        Ok(map_search(&v))
    }

    /// The two historical counters. The other five dashboard numbers are
    /// derived from the PR list in the frontend and cost no extra request.
    pub async fn fetch_stats(&self, now: DateTime<Utc>) -> Result<Stats, ClientError> {
        let week = (now - Duration::days(7)).format("%Y-%m-%d").to_string();
        let month = (now - Duration::days(30)).format("%Y-%m-%d").to_string();
        let v: serde_json::Value = self
            .octocrab
            .graphql(&json!({
                "query": STATS_QUERY,
                "variables": {
                    "week": format!("is:pr author:@me is:merged merged:>={week}"),
                    "month": format!("is:pr author:@me is:merged merged:>={month}"),
                }
            }))
            .await?;
        Ok(Stats {
            merged_week: v["merged_week"]["issueCount"].as_u64().unwrap_or(0),
            merged_month: v["merged_month"]["issueCount"].as_u64().unwrap_or(0),
            ..Stats::default()
        })
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test github::client`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/github/client.rs src-tauri/src/github/mod.rs
git commit -m "feat: GitHub client with mock-server tests"
```

---

### Task 9: SQLite store

**Files:**
- Create: `src-tauri/src/store/mod.rs`, `src-tauri/src/store/schema.rs`, `src-tauri/src/store/cache.rs`, `src-tauri/src/store/history.rs`

**Interfaces:**
- Consumes: `PullRequest` (Task 7)
- Produces:
  - `pub fn open_db(path: &Path) -> Result<Connection, StoreError>`
  - `pub fn save_snapshot(conn: &Connection, prs: &[PullRequest]) -> Result<(), StoreError>`
  - `pub fn load_snapshot(conn: &Connection) -> Result<Vec<PullRequest>, StoreError>`
  - `pub fn record_merges(conn: &Connection, prs: &[PullRequest], seen_at: DateTime<Utc>) -> Result<(), StoreError>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::model::{CiState, Label, MergeState, PullRequest, ReviewState};
    use chrono::Utc;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn sample() -> PullRequest {
        PullRequest {
            number: 42,
            title: "Add retry to the fetch client".into(),
            url: "https://github.com/octocat/hello-world/pull/42".into(),
            repo: "octocat/hello-world".into(),
            author: "octocat".into(),
            is_draft: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            ci: CiState::Success,
            merge: MergeState::Mergeable,
            review: ReviewState::Approved,
            in_merge_queue: false,
            labels: vec![Label { name: "bug".into(), color: "d73a4a".into() }],
            comment_count: 2,
        }
    }

    #[test]
    fn round_trips_a_snapshot() {
        let conn = db();
        save_snapshot(&conn, &[sample()]).unwrap();
        let loaded = load_snapshot(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].number, 42);
        assert_eq!(loaded[0].labels[0].name, "bug");
    }

    #[test]
    fn a_snapshot_replaces_the_previous_one() {
        let conn = db();
        save_snapshot(&conn, &[sample()]).unwrap();
        save_snapshot(&conn, &[]).unwrap();
        assert_eq!(load_snapshot(&conn).unwrap().len(), 0);
    }

    #[test]
    fn loading_from_an_empty_db_returns_empty_not_an_error() {
        assert_eq!(load_snapshot(&db()).unwrap().len(), 0);
    }

    #[test]
    fn migrations_are_idempotent() {
        let conn = db();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(load_snapshot(&conn).unwrap().len(), 0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schema**

`src-tauri/src/store/schema.rs`:

```rust
use rusqlite::Connection;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialisation error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Numbered migrations from the first commit, so v0.1 installs stay
/// upgradable rather than needing the database deleted.
const MIGRATIONS: &[&str] = &[
    // 1: the snapshot cache and the merge history.
    "CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        fetched_at TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS merge_history (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        merged_at TEXT NOT NULL,
        PRIMARY KEY (repo, number)
     );",
];

pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}

pub fn open_db(path: &Path) -> Result<Connection, StoreError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}
```

- [ ] **Step 4: Implement the cache**

`src-tauri/src/store/cache.rs`:

```rust
use super::schema::StoreError;
use crate::github::model::PullRequest;
use rusqlite::Connection;

/// The whole snapshot is one JSON row. At ~30 PRs this is a few hundred KB,
/// so a normalised schema would buy nothing and cost migrations later.
pub fn save_snapshot(conn: &Connection, prs: &[PullRequest]) -> Result<(), StoreError> {
    let payload = serde_json::to_string(prs)?;
    conn.execute(
        "INSERT INTO snapshot (id, payload, fetched_at) VALUES (1, ?1, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET payload = ?1, fetched_at = datetime('now')",
        [&payload],
    )?;
    Ok(())
}

pub fn load_snapshot(conn: &Connection) -> Result<Vec<PullRequest>, StoreError> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM snapshot WHERE id = 1", [], |r| r.get(0))
        .ok();
    match payload {
        Some(p) => Ok(serde_json::from_str(&p)?),
        None => Ok(Vec::new()),
    }
}
```

- [ ] **Step 5: Implement the history**

`src-tauri/src/store/history.rs`:

```rust
use super::schema::StoreError;
use crate::github::model::PullRequest;
use chrono::{DateTime, Utc};
use rusqlite::Connection;

/// Record PRs that have left the open set, so week/month counters survive
/// offline and can become trend charts later without a schema rewrite.
/// GitHub search remains authoritative for the displayed numbers.
pub fn record_merges(
    conn: &Connection,
    prs: &[PullRequest],
    seen_at: DateTime<Utc>,
) -> Result<(), StoreError> {
    for pr in prs {
        conn.execute(
            "INSERT OR IGNORE INTO merge_history (repo, number, merged_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![pr.repo, pr.number, seen_at.to_rfc3339()],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && cargo test store`
Expected: 4 passing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/store
git commit -m "feat: SQLite snapshot cache and merge history"
```

---

### Task 10: Polling and Tauri commands

**Files:**
- Create: `src-tauri/src/poll.rs`, `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `GitHubClient` (Task 8), store functions (Task 9), `read_token`/`build_client` (Task 6)
- Produces:
  - Tauri commands `get_cached`, `refresh_now`, `get_stats`, `get_auth_state`
  - Event `prs-updated` emitted to the webview
  - `pub fn interval_for(focused: bool) -> Duration`

- [ ] **Step 1: Write the failing test for cadence**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_faster_when_focused() {
        assert_eq!(interval_for(true), std::time::Duration::from_secs(60));
        assert_eq!(interval_for(false), std::time::Duration::from_secs(300));
    }

    /// 60s focused is 60 polls/hour at 2 points each, against a 5000/hour
    /// budget. If this ever regresses to a few seconds, the app would start
    /// competing with the user's own gh usage for rate limit.
    #[test]
    fn focused_cadence_stays_well_inside_the_rate_limit() {
        let per_hour = 3600 / interval_for(true).as_secs();
        assert!(per_hour * 2 < 500, "polling budget too aggressive");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test poll`
Expected: FAIL — `interval_for` not found.

- [ ] **Step 3: Implement polling**

```rust
//! Background polling.
//!
//! Polling lives in Rust rather than React so it continues while the window
//! is hidden to the tray -- which is what makes the tray badge meaningful.

use crate::github::client::GitHubClient;
use crate::store::{cache::save_snapshot, schema::open_db};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const FOCUSED: Duration = Duration::from_secs(60);
pub const BACKGROUND: Duration = Duration::from_secs(300);

pub fn interval_for(focused: bool) -> Duration {
    if focused { FOCUSED } else { BACKGROUND }
}

/// Spawn the poll loop. Each tick fetches, writes the snapshot, and emits
/// `prs-updated`; the frontend invalidates its query on that event.
pub fn spawn(app: AppHandle, client: Arc<GitHubClient>, focused: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match client.fetch_prs().await {
                Ok(prs) => {
                    if let Ok(path) = app.path().app_data_dir() {
                        if let Ok(conn) = open_db(&path.join("headstate.db")) {
                            let _ = save_snapshot(&conn, &prs);
                        }
                    }
                    let _ = app.emit("prs-updated", &prs);
                }
                // A failed poll leaves the last snapshot in place rather
                // than blanking the UI; the next tick retries.
                Err(e) => {
                    let _ = app.emit("poll-error", e.to_string());
                }
            }
            tokio::time::sleep(interval_for(focused.load(Ordering::Relaxed))).await;
        }
    });
}
```

- [ ] **Step 4: Implement the commands**

`src-tauri/src/commands.rs`:

```rust
use crate::github::client::GitHubClient;
use crate::github::model::{PullRequest, Stats};
use crate::store::{cache::load_snapshot, schema::open_db};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(serde::Serialize)]
pub struct AuthState { pub ok: bool, pub message: String }

fn db_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("headstate.db")
}

/// The cached snapshot, so the window paints real content at launch rather
/// than a spinner.
#[tauri::command]
pub fn get_cached(app: AppHandle) -> Result<Vec<PullRequest>, String> {
    let conn = open_db(&db_path(&app)).map_err(|e| e.to_string())?;
    load_snapshot(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_now(
    client: State<'_, Arc<GitHubClient>>,
) -> Result<Vec<PullRequest>, String> {
    client.fetch_prs().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stats(client: State<'_, Arc<GitHubClient>>) -> Result<Stats, String> {
    client
        .fetch_stats(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auth_state(state: State<'_, AuthState>) -> AuthState {
    AuthState { ok: state.ok, message: state.message.clone() }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test`
Expected: all passing, including the two new poll tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/poll.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: background polling and Tauri commands"
```

---

### Task 11: Tray icon and close-to-tray

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the `trayTemplate` icons from Task 2
- Produces: `pub fn setup_tray(app: &AppHandle) -> tauri::Result<()>`, `pub fn badge_text(needs_attention: u64) -> Option<String>`

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_badge_when_nothing_needs_attention() {
        assert_eq!(badge_text(0), None);
    }

    #[test]
    fn badge_shows_the_count() {
        assert_eq!(badge_text(3).as_deref(), Some("3"));
    }

    /// A three-digit badge would widen the menu bar item enough to shove
    /// neighbouring icons around.
    #[test]
    fn large_counts_are_capped() {
        assert_eq!(badge_text(150).as_deref(), Some("99+"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test tray`
Expected: FAIL — `badge_text` not found.

- [ ] **Step 3: Implement**

```rust
//! Tray icon and window behaviour.
//!
//! The tray glyph is a macOS template image: pure black plus alpha, with a
//! filename ending in `Template`. That suffix is what makes macOS invert it
//! for light and dark menu bars and highlight it on click. It therefore
//! cannot carry colour, so attention is signalled by badge text instead.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

pub fn badge_text(needs_attention: u64) -> Option<String> {
    match needs_attention {
        0 => None,
        n if n > 99 => Some("99+".to_string()),
        n => Some(n.to_string()),
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Headstate", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Headstate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/trayTemplate@2x.png"
        ))?)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "refresh" => {
                let _ = app.emit_to("main", "refresh-requested", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 4: Wire close-to-tray in `lib.rs`**

```rust
.on_window_event(|window, event| {
    // Closing hides to the tray rather than quitting, so polling keeps
    // running and the badge stays live. Quit is explicit, from the tray
    // menu or Cmd-Q.
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
})
```

- [ ] **Step 5: Run the tests and verify manually**

Run: `cd src-tauri && cargo test tray` — expect 3 passing.
Run: `make dev`, close the window, confirm the app stays in the tray and
"Show Headstate" restores it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "feat: tray icon with close-to-tray"
```

---

## Milestone 3 — PR list

### Task 12: Frontend types, API layer, and auth gate

**Files:**
- Create: `src/types/pr.ts`, `src/api/tauri.ts`, `src/api/hooks.ts`, `src/components/AuthGate.tsx`, `src/fixtures/prs.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: the Tauri commands from Task 10
- Produces:
  - `type PullRequest`, `CiState`, `MergeState`, `ReviewState`, `Label`, `Stats`
  - `usePullRequests(): UseQueryResult<PullRequest[]>`
  - `useStats(): UseQueryResult<Stats>`
  - `PR_FIXTURES: PullRequest[]`

- [ ] **Step 1: Write the types**

`src/types/pr.ts` — these mirror the Rust model exactly; serde uses
lowercase for CI/merge states and snake_case for review states.

```ts
export type CiState = "success" | "failure" | "pending" | "none";
export type MergeState = "mergeable" | "conflicted" | "checking";
export type ReviewState = "approved" | "changes_requested" | "review_required" | "none";

export interface Label { name: string; color: string }

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  is_draft: boolean;
  created_at: string;
  updated_at: string;
  ci: CiState;
  merge: MergeState;
  review: ReviewState;
  in_merge_queue: boolean;
  labels: Label[];
  comment_count: number;
}

export interface Stats {
  merged_week: number;
  merged_month: number;
  in_merge_queue: number;
  needs_attention: number;
  awaiting_review: number;
  ready_to_queue: number;
  blocked_by_comments: number;
}
```

- [ ] **Step 2: Write synthetic fixtures**

`src/fixtures/prs.ts` — synthetic per the Global Constraints. These back
every frontend test.

```ts
import type { PullRequest } from "../types/pr";

export const PR_FIXTURES: PullRequest[] = [
  {
    number: 42,
    title: "Add retry to the fetch client",
    url: "https://github.com/octocat/hello-world/pull/42",
    repo: "octocat/hello-world",
    author: "octocat",
    is_draft: false,
    created_at: "2026-08-18T10:00:00Z",
    updated_at: "2026-08-18T12:00:00Z",
    ci: "success",
    merge: "mergeable",
    review: "approved",
    in_merge_queue: false,
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comment_count: 2,
  },
  {
    number: 43,
    title: "Fix flaky timezone test",
    url: "https://github.com/octocat/hello-world/pull/43",
    repo: "octocat/hello-world",
    author: "octocat",
    is_draft: true,
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:30:00Z",
    ci: "failure",
    merge: "conflicted",
    review: "changes_requested",
    in_merge_queue: false,
    labels: [{ name: "bug", color: "d73a4a" }],
    comment_count: 5,
  },
  {
    number: 7,
    title: "Bump the parser dependency",
    url: "https://github.com/octocat/spoon-knife/pull/7",
    repo: "octocat/spoon-knife",
    author: "octocat",
    is_draft: false,
    created_at: "2026-08-16T09:00:00Z",
    updated_at: "2026-08-16T09:00:00Z",
    ci: "none",
    merge: "checking",
    review: "none",
    in_merge_queue: true,
    labels: [{ name: "dependencies", color: "0366d6" }],
    comment_count: 0,
  },
];
```

- [ ] **Step 3: Implement the API layer**

`src/api/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { PullRequest, Stats } from "../types/pr";

export const getCached = () => invoke<PullRequest[]>("get_cached");
export const refreshNow = () => invoke<PullRequest[]>("refresh_now");
export const getStats = () => invoke<Stats>("get_stats");
export const getAuthState = () => invoke<{ ok: boolean; message: string }>("get_auth_state");
```

`src/api/hooks.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { PullRequest } from "../types/pr";
import { getCached, getStats, refreshNow } from "./tauri";

/// The PR list. Seeded from the SQLite snapshot so the first paint shows
/// real content, then reconciled by the Rust poll loop via `prs-updated`.
/// React never talks to GitHub directly.
export function usePullRequests() {
  const qc = useQueryClient();

  useEffect(() => {
    const un = listen<PullRequest[]>("prs-updated", (e) => {
      qc.setQueryData(["prs"], e.payload);
    });
    return () => { un.then((f) => f()); };
  }, [qc]);

  return useQuery({
    queryKey: ["prs"],
    queryFn: async () => {
      const cached = await getCached();
      // Show the cache immediately; the poll loop supplies fresh data.
      if (cached.length > 0) return cached;
      return refreshNow();
    },
    staleTime: Infinity,
  });
}

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: getStats, staleTime: 60_000 });
}
```

- [ ] **Step 4: Implement the auth gate**

`src/components/AuthGate.tsx` — a real first-run screen, not a generic error.

```tsx
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getAuthState } from "../api/tauri";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: ["auth"], queryFn: getAuthState });

  if (isLoading) return null;
  if (data?.ok) return <>{children}</>;

  return (
    <div className="flex h-screen items-center justify-center bg-[#0d1117] text-[#e6edf3]">
      <div className="max-w-md space-y-4">
        <h1 className="text-xl font-semibold">Headstate needs the GitHub CLI</h1>
        <p className="text-sm text-[#8b949e]">{data?.message}</p>
        <pre className="rounded bg-[#161b22] p-3 text-sm">
          brew install gh{"\n"}gh auth login
        </pre>
        <p className="text-sm text-[#8b949e]">
          Headstate reads your token from <code>gh</code> and keeps it in memory only.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify typecheck**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/types src/api src/components/AuthGate.tsx src/fixtures src/main.tsx
git commit -m "feat: frontend types, API layer, and auth gate"
```

---

### Task 13: Derivations and filter store

**Files:**
- Create: `src/lib/derive.ts`, `src/lib/derive.test.ts`, `src/store/filters.ts`, `src/store/filters.test.ts`, `src/lib/time.ts`, `src/lib/labels.ts`

**Interfaces:**
- Consumes: `PullRequest` (Task 12)
- Produces:
  - `needsAttention(pr): boolean`, `isStale(pr, now, days?): boolean`, `awaitingReview(pr): boolean`, `readyToQueue(pr): boolean`, `blockedByComments(pr): boolean`
  - `applyFilters(prs, filters): PullRequest[]`
  - `deriveStats(prs): Omit<Stats, "merged_week" | "merged_month">`
  - `useFilters()` zustand store with `filters`, `setFilter`, `reset`, `applyPreset`
  - `relativeTime(iso, now): string`
  - `labelForeground(hex): string`

- [ ] **Step 1: Write the failing derivation tests**

`src/lib/derive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import {
  applyFilters, awaitingReview, blockedByComments, deriveStats,
  isStale, needsAttention, readyToQueue,
} from "./derive";

const [approved, broken, checking] = PR_FIXTURES;

describe("needsAttention", () => {
  it("flags failing CI", () => {
    expect(needsAttention(broken)).toBe(true);
  });

  it("does not flag a green PR", () => {
    expect(needsAttention(approved)).toBe(false);
  });

  /// The priorities strip must never cry wolf: a PR whose mergeability
  /// GitHub has not finished computing is not a conflict.
  it("never flags a PR whose merge state is still checking", () => {
    expect(needsAttention(checking)).toBe(false);
  });
});

describe("isStale", () => {
  it("flags a green approved PR untouched for more than 3 days", () => {
    expect(isStale(approved, new Date("2026-08-25T12:00:00Z"))).toBe(true);
  });

  it("does not flag one touched today", () => {
    expect(isStale(approved, new Date("2026-08-18T13:00:00Z"))).toBe(false);
  });

  it("does not flag a PR that is not yet approved", () => {
    expect(isStale(checking, new Date("2026-08-25T12:00:00Z"))).toBe(false);
  });
});

describe("categories", () => {
  it("classifies awaiting review, ready to queue, and blocked", () => {
    expect(readyToQueue(approved)).toBe(true);
    expect(blockedByComments(broken)).toBe(true);
    expect(awaitingReview(approved)).toBe(false);
  });
});

describe("applyFilters", () => {
  it("returns everything by default", () => {
    expect(applyFilters(PR_FIXTURES, {}).length).toBe(3);
  });

  it("filters by repo", () => {
    const out = applyFilters(PR_FIXTURES, { repo: "octocat/spoon-knife" });
    expect(out.map((p) => p.number)).toEqual([7]);
  });

  it("hides drafts when readyOnly is set", () => {
    expect(applyFilters(PR_FIXTURES, { readyOnly: true }).some((p) => p.is_draft)).toBe(false);
  });

  it("includes by label", () => {
    const out = applyFilters(PR_FIXTURES, { includeLabels: ["bug"] });
    expect(out.map((p) => p.number)).toEqual([43]);
  });

  /// Excluding `dependencies` to silence dependabot is the dominant
  /// real-world case for label filtering.
  it("excludes by label", () => {
    const out = applyFilters(PR_FIXTURES, { excludeLabels: ["dependencies"] });
    expect(out.map((p) => p.number)).toEqual([42, 43]);
  });

  it("applies include and exclude together", () => {
    const out = applyFilters(PR_FIXTURES, {
      includeLabels: ["bug", "dependencies"],
      excludeLabels: ["dependencies"],
    });
    expect(out.map((p) => p.number)).toEqual([43]);
  });
});

describe("deriveStats", () => {
  it("counts each category from the list", () => {
    const s = deriveStats(PR_FIXTURES);
    expect(s.needs_attention).toBe(1);
    expect(s.in_merge_queue).toBe(1);
    expect(s.blocked_by_comments).toBe(1);
    expect(s.ready_to_queue).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/lib/derive.test.ts`
Expected: FAIL — cannot resolve `./derive`.

- [ ] **Step 3: Implement**

`src/lib/derive.ts`:

```ts
import type { PullRequest, Stats } from "../types/pr";

export const STALE_DAYS = 3;

export interface Filters {
  repo?: string;
  readyOnly?: boolean;
  draftsOnly?: boolean;
  ci?: PullRequest["ci"];
  review?: PullRequest["review"];
  includeLabels?: string[];
  excludeLabels?: string[];
  needsAttentionOnly?: boolean;
  staleOnly?: boolean;
  inMergeQueueOnly?: boolean;
}

/// Blocked on the author and nobody else: a real conflict, or failing CI.
/// `checking` is deliberately excluded -- GitHub reports UNKNOWN
/// mergeability while it computes, and treating that as a conflict would
/// fire a false warning on every push.
export function needsAttention(pr: PullRequest): boolean {
  return pr.merge === "conflicted" || pr.ci === "failure";
}

export function awaitingReview(pr: PullRequest): boolean {
  return !pr.is_draft && pr.ci === "success" &&
    (pr.review === "none" || pr.review === "review_required");
}

export function readyToQueue(pr: PullRequest): boolean {
  return !pr.is_draft && pr.ci === "success" && pr.review === "approved" && !pr.in_merge_queue;
}

export function blockedByComments(pr: PullRequest): boolean {
  return pr.review === "changes_requested";
}

/// Green, approved, and untouched: the single most nudge-worthy state, and
/// the one no other filter surfaces.
export function isStale(pr: PullRequest, now: Date, days = STALE_DAYS): boolean {
  if (!readyToQueue(pr)) return false;
  const age = now.getTime() - new Date(pr.updated_at).getTime();
  return age > days * 86_400_000;
}

const hasLabel = (pr: PullRequest, names: string[]) =>
  pr.labels.some((l) => names.includes(l.name));

export function applyFilters(prs: PullRequest[], f: Filters): PullRequest[] {
  return prs.filter((pr) => {
    if (f.repo && pr.repo !== f.repo) return false;
    if (f.readyOnly && pr.is_draft) return false;
    if (f.draftsOnly && !pr.is_draft) return false;
    if (f.ci && pr.ci !== f.ci) return false;
    if (f.review && pr.review !== f.review) return false;
    if (f.includeLabels?.length && !hasLabel(pr, f.includeLabels)) return false;
    if (f.excludeLabels?.length && hasLabel(pr, f.excludeLabels)) return false;
    if (f.needsAttentionOnly && !needsAttention(pr)) return false;
    if (f.inMergeQueueOnly && !pr.in_merge_queue) return false;
    if (f.staleOnly && !isStale(pr, new Date())) return false;
    return true;
  });
}

/// Five of the seven dashboard counters come from the list already in
/// memory, so they cost no extra API request. Only the two historical
/// counters need GitHub.
export function deriveStats(
  prs: PullRequest[],
): Omit<Stats, "merged_week" | "merged_month"> {
  return {
    in_merge_queue: prs.filter((p) => p.in_merge_queue).length,
    needs_attention: prs.filter(needsAttention).length,
    awaiting_review: prs.filter(awaitingReview).length,
    ready_to_queue: prs.filter(readyToQueue).length,
    blocked_by_comments: prs.filter(blockedByComments).length,
  };
}
```

- [ ] **Step 4: Write the filter store and its test**

`src/store/filters.ts`:

```ts
import { create } from "zustand";
import type { Filters } from "../lib/derive";

/// zustand holds UI state only. Server data lives in TanStack Query and is
/// never duplicated here.
interface FilterStore {
  filters: Filters;
  view: "list" | "dashboard";
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  applyPreset: (filters: Filters) => void;
  setView: (view: "list" | "dashboard") => void;
  reset: () => void;
}

export const useFilters = create<FilterStore>((set) => ({
  filters: {},
  view: "list",
  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
  // Dashboard cards navigate by replacing the filter set wholesale, so a
  // card click never inherits a filter the user forgot was active.
  applyPreset: (filters) => set({ filters, view: "list" }),
  setView: (view) => set({ view }),
  reset: () => set({ filters: {} }),
}));
```

`src/store/filters.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useFilters } from "./filters";

describe("useFilters", () => {
  beforeEach(() => useFilters.setState({ filters: {}, view: "list" }));

  it("sets an individual filter", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    expect(useFilters.getState().filters.repo).toBe("octocat/hello-world");
  });

  it("a preset replaces the filter set rather than merging", () => {
    useFilters.getState().setFilter("repo", "octocat/hello-world");
    useFilters.getState().applyPreset({ needsAttentionOnly: true });
    expect(useFilters.getState().filters).toEqual({ needsAttentionOnly: true });
  });

  it("a preset switches to the list view", () => {
    useFilters.getState().setView("dashboard");
    useFilters.getState().applyPreset({ staleOnly: true });
    expect(useFilters.getState().view).toBe("list");
  });
});
```

- [ ] **Step 5: Write the time and label helpers**

`src/lib/time.ts`:

```ts
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/// GitHub-style relative time, as shown in the PR metadata line.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / DAY);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}
```

`src/lib/labels.ts`:

```ts
/// GitHub gives label colours as a background hex only, so the foreground
/// has to be computed or dark labels become unreadable.
export function labelForeground(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Relative luminance, per WCAG's simplified sRGB coefficients.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1f2328" : "#ffffff";
}
```

- [ ] **Step 6: Run the tests**

Run: `yarn vitest run src/lib src/store`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add src/lib src/store
git commit -m "feat: PR derivations, filters, and formatting helpers"
```

---

### Task 14: shadcn/ui setup and the PR list

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/components/ui/*`, `src/components/PrRow.tsx`, `src/components/PrList.tsx`, `src/components/PrList.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `applyFilters` (Task 13), `usePullRequests` (Task 12)
- Produces: `<PrList />`, `<PrRow pr={...} />`

- [ ] **Step 1: Initialize shadcn/ui**

```bash
yarn dlx shadcn@latest init -d
yarn dlx shadcn@latest add button badge checkbox dropdown-menu input card dialog separator scroll-area
```

- [ ] **Step 2: Write the failing test**

`src/components/PrList.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { PrList } from "./PrList";

describe("PrList", () => {
  it("renders every PR with its number and title", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText("Add retry to the fetch client")).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
    expect(screen.getByText(/#43/)).toBeDefined();
  });

  it("renders label pills", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText("enhancement")).toBeDefined();
    expect(screen.getByText("bug")).toBeDefined();
  });

  it("marks drafts", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText(/draft/i)).toBeDefined();
  });

  it("shows the open count in the header", () => {
    render(<PrList prs={PR_FIXTURES} />);
    expect(screen.getByText(/3 Open/)).toBeDefined();
  });

  it("renders an empty state rather than a bare list", () => {
    render(<PrList prs={[]} />);
    expect(screen.getByText(/No pull requests/i)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `yarn vitest run src/components/PrList.test.tsx`
Expected: FAIL — cannot resolve `./PrList`.

- [ ] **Step 4: Implement the row**

The visual target is GitHub's own `/pulls` page: orange PR glyph, title with
inline label pills, then a metadata line reading `#N opened <when> by <who>`.

`src/components/PrRow.tsx`:

```tsx
import { Check, GitPullRequest, X } from "lucide-react";
import type { PullRequest } from "../types/pr";
import { labelForeground } from "../lib/labels";
import { relativeTime } from "../lib/time";

function CiGlyph({ pr }: { pr: PullRequest }) {
  if (pr.ci === "success") return <Check className="h-4 w-4 text-[#3fb950]" aria-label="CI passing" />;
  if (pr.ci === "failure") return <X className="h-4 w-4 text-[#f85149]" aria-label="CI failing" />;
  return null;
}

export function PrRow({ pr }: { pr: PullRequest }) {
  return (
    <div className="flex gap-3 border-b border-[#30363d] px-4 py-3 hover:bg-[#161b22]">
      <input type="checkbox" className="mt-1 h-4 w-4" aria-label={`Select PR ${pr.number}`} />
      <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-[#3fb950]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a href={pr.url} target="_blank" rel="noreferrer"
             className="font-semibold text-[#e6edf3] hover:text-[#4493f8]">
            {pr.title}
          </a>
          <CiGlyph pr={pr} />
          {pr.labels.map((l) => (
            <span key={l.name}
                  className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: `#${l.color}`, color: labelForeground(l.color) }}>
              {l.name}
            </span>
          ))}
        </div>
        <div className="mt-1 text-xs text-[#8b949e]">
          #{pr.number} opened {relativeTime(pr.created_at)} by {pr.author}
          {pr.is_draft && <span className="ml-2 rounded border border-[#30363d] px-1.5">Draft</span>}
          {pr.in_merge_queue && <span className="ml-2 text-[#a371f7]">• In merge queue</span>}
          {pr.merge === "conflicted" && <span className="ml-2 text-[#f85149]">• Conflicts</span>}
          {pr.merge === "checking" && <span className="ml-2">• Checking mergeability</span>}
        </div>
      </div>
      <div className="shrink-0 text-xs text-[#8b949e]">{pr.repo}</div>
    </div>
  );
}
```

- [ ] **Step 5: Implement the list**

`src/components/PrList.tsx`:

```tsx
import type { PullRequest } from "../types/pr";
import { PrRow } from "./PrRow";

export function PrList({ prs }: { prs: PullRequest[] }) {
  // Newest first, as specified.
  const sorted = [...prs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="rounded-md border border-[#30363d]">
      <div className="flex items-center justify-between border-b border-[#30363d] bg-[#161b22] px-4 py-3 text-sm">
        <span className="font-semibold text-[#e6edf3]">{sorted.length} Open</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-[#8b949e]">
          No pull requests match these filters.
        </div>
      ) : (
        sorted.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />)
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `yarn vitest run src/components/PrList.test.tsx`
Expected: 5 passing.

- [ ] **Step 7: Commit**

```bash
git add components.json src/components src/lib/utils.ts src/index.css
git commit -m "feat: shadcn/ui foundation and the PR list"
```

---

### Task 15: Filter bar and repo sidebar

**Files:**
- Create: `src/components/FilterBar.tsx`, `src/components/FilterBar.test.tsx`, `src/components/RepoSidebar.tsx`, `src/components/RepoSidebar.test.tsx`

**Interfaces:**
- Consumes: `useFilters` (Task 13)
- Produces: `<FilterBar prs={...} />`, `<RepoSidebar prs={...} />`, `repoCounts(prs): {repo, count}[]`

- [ ] **Step 1: Write the failing tests**

`src/components/RepoSidebar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { RepoSidebar, repoCounts } from "./RepoSidebar";

describe("repoCounts", () => {
  it("counts PRs per repo, most first", () => {
    expect(repoCounts(PR_FIXTURES)).toEqual([
      { repo: "octocat/hello-world", count: 2 },
      { repo: "octocat/spoon-knife", count: 1 },
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(repoCounts([])).toEqual([]);
  });
});

describe("RepoSidebar", () => {
  it("lists only repos that currently have PRs", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    expect(screen.getByText("octocat/hello-world")).toBeDefined();
    expect(screen.getByText("octocat/spoon-knife")).toBeDefined();
  });

  it("always offers an All entry", () => {
    render(<RepoSidebar prs={PR_FIXTURES} />);
    expect(screen.getByText(/All/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/RepoSidebar.test.tsx`
Expected: FAIL — cannot resolve `./RepoSidebar`.

- [ ] **Step 3: Implement the sidebar**

```tsx
import type { PullRequest } from "../types/pr";
import { useFilters } from "../store/filters";

/// Only repos where the user currently has open PRs, busiest first.
export function repoCounts(prs: PullRequest[]): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const pr of prs) counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
  return [...counts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

export function RepoSidebar({ prs }: { prs: PullRequest[] }) {
  const { filters, setFilter } = useFilters();
  const counts = repoCounts(prs);

  return (
    <nav className="w-64 shrink-0 border-r border-[#30363d] p-3">
      <button
        onClick={() => setFilter("repo", undefined)}
        className={`flex w-full justify-between rounded px-3 py-2 text-sm ${
          !filters.repo ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
        }`}
      >
        <span>All repositories</span>
        <span>{prs.length}</span>
      </button>
      {counts.map(({ repo, count }) => (
        <button
          key={repo}
          onClick={() => setFilter("repo", repo)}
          className={`flex w-full justify-between rounded px-3 py-2 text-sm ${
            filters.repo === repo ? "bg-[#1f6feb] text-white" : "text-[#e6edf3] hover:bg-[#161b22]"
          }`}
        >
          <span className="truncate">{repo}</span>
          <span className="ml-2 shrink-0">{count}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Implement the filter bar**

Mirrors GitHub's `Author / Label / Reviews / Sort` row, plus include/exclude
label control which GitHub's own UI lacks.

```tsx
import { Button } from "./ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { PullRequest } from "../types/pr";
import { useFilters } from "../store/filters";

export function FilterBar({ prs }: { prs: PullRequest[] }) {
  const { filters, setFilter, reset } = useFilters();
  const labels = [...new Set(prs.flatMap((p) => p.labels.map((l) => l.name)))].sort();

  const toggle = (key: "includeLabels" | "excludeLabels", name: string) => {
    const current = filters[key] ?? [];
    setFilter(key, current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name]);
  };

  return (
    <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-4 py-2 text-sm">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Label</Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          {labels.map((name) => (
            <DropdownMenuCheckboxItem
              key={name}
              checked={filters.includeLabels?.includes(name) ?? false}
              onCheckedChange={() => toggle("includeLabels", name)}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Exclude label</Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          {labels.map((name) => (
            <DropdownMenuCheckboxItem
              key={name}
              checked={filters.excludeLabels?.includes(name) ?? false}
              onCheckedChange={() => toggle("excludeLabels", name)}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="sm"
              onClick={() => setFilter("readyOnly", !filters.readyOnly)}>
        {filters.readyOnly ? "Ready only ✓" : "Ready only"}
      </Button>
      <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">Clear</Button>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run src/components`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add src/components/FilterBar.tsx src/components/FilterBar.test.tsx \
        src/components/RepoSidebar.tsx src/components/RepoSidebar.test.tsx
git commit -m "feat: filter bar with label include/exclude, and repo sidebar"
```

---

### Task 16: Priorities strip

**Files:**
- Create: `src/components/PrioritiesStrip.tsx`, `src/components/PrioritiesStrip.test.tsx`

**Interfaces:**
- Consumes: `needsAttention` (Task 13)
- Produces: `<PrioritiesStrip prs={...} />`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { PrioritiesStrip } from "./PrioritiesStrip";

describe("PrioritiesStrip", () => {
  it("shows PRs with failing CI or conflicts", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.getByText(/Fix flaky timezone test/)).toBeDefined();
  });

  it("does not show healthy PRs", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.queryByText(/Add retry to the fetch client/)).toBeNull();
  });

  /// The strip is only worth looking at if it never cries wolf. A PR whose
  /// mergeability GitHub has not finished computing is not a conflict.
  it("does not show a PR whose merge state is still checking", () => {
    render(<PrioritiesStrip prs={PR_FIXTURES} />);
    expect(screen.queryByText(/Bump the parser dependency/)).toBeNull();
  });

  it("renders a quiet line when nothing needs attention", () => {
    render(<PrioritiesStrip prs={[PR_FIXTURES[0]]} />);
    expect(screen.getByText(/Nothing blocked/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/PrioritiesStrip.test.tsx`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement**

```tsx
import { AlertTriangle } from "lucide-react";
import type { PullRequest } from "../types/pr";
import { needsAttention } from "../lib/derive";

/// Pinned above the list on every page. Contains only PRs blocked on the
/// author and nobody else. The empty state is one quiet line, not a card:
/// a strip that shouts when nothing is wrong stops being read.
export function PrioritiesStrip({ prs }: { prs: PullRequest[] }) {
  const blocked = prs.filter(needsAttention);

  if (blocked.length === 0) {
    return (
      <p className="px-4 py-2 text-xs text-[#8b949e]">Nothing blocked on you.</p>
    );
  }

  return (
    <section className="mb-4 rounded-md border border-[#f85149]/40 bg-[#f85149]/5">
      <h2 className="flex items-center gap-2 border-b border-[#f85149]/30 px-4 py-2 text-sm font-semibold text-[#f85149]">
        <AlertTriangle className="h-4 w-4" />
        Needs your attention ({blocked.length})
      </h2>
      <ul>
        {blocked.map((pr) => (
          <li key={`${pr.repo}#${pr.number}`} className="px-4 py-2 text-sm">
            <a href={pr.url} target="_blank" rel="noreferrer"
               className="text-[#e6edf3] hover:text-[#4493f8]">
              {pr.title}
            </a>
            <span className="ml-2 text-xs text-[#8b949e]">
              {pr.repo}#{pr.number} —{" "}
              {pr.merge === "conflicted" ? "merge conflicts" : "CI failing"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn vitest run src/components/PrioritiesStrip.test.tsx`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/PrioritiesStrip.tsx src/components/PrioritiesStrip.test.tsx
git commit -m "feat: priorities strip for conflicts and red CI"
```

---

## Milestone 4 — Dashboard

### Task 17: Dashboard with clickable stat cards

**Files:**
- Create: `src/components/Dashboard.tsx`, `src/components/StatCard.tsx`, `src/components/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `deriveStats` (Task 13), `useStats` (Task 12), `applyPreset` (Task 13)
- Produces: `<Dashboard prs={...} stats={...} />`, `<StatCard label value onClick />`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { useFilters } from "../store/filters";
import { Dashboard } from "./Dashboard";

const STATS = { merged_week: 4, merged_month: 12 };

describe("Dashboard", () => {
  beforeEach(() => useFilters.setState({ filters: {}, view: "dashboard" }));

  it("shows the historical counters", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
  });

  it("derives the live counters from the PR list", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getByText(/Needs rebase or red CI/i)).toBeDefined();
    expect(screen.getByText(/In merge queue/i)).toBeDefined();
  });

  it("renders all seven cards", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    expect(screen.getAllByRole("button").length).toBe(7);
  });

  /// Clicking a card is the triage path: it must land the user on the list
  /// already filtered to exactly that card's PRs.
  it("a card click applies its filter and switches to the list", () => {
    render(<Dashboard prs={PR_FIXTURES} stats={STATS} />);
    fireEvent.click(screen.getByText(/Needs rebase or red CI/i));
    expect(useFilters.getState().filters).toEqual({ needsAttentionOnly: true });
    expect(useFilters.getState().view).toBe("list");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/Dashboard.test.tsx`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement the card**

```tsx
import { Card } from "./ui/card";

export function StatCard({
  label, value, tone = "default", onClick,
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "success" | "warn";
  onClick: () => void;
}) {
  const toneClass = {
    default: "text-[#e6edf3]",
    danger: "text-[#f85149]",
    success: "text-[#3fb950]",
    warn: "text-[#d29922]",
  }[tone];

  return (
    <button onClick={onClick} className="text-left">
      <Card className="border-[#30363d] bg-[#161b22] p-4 transition hover:border-[#4493f8]">
        <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
        <div className="mt-1 text-sm text-[#8b949e]">{label}</div>
      </Card>
    </button>
  );
}
```

- [ ] **Step 4: Implement the dashboard**

```tsx
import type { PullRequest } from "../types/pr";
import { deriveStats } from "../lib/derive";
import { useFilters } from "../store/filters";
import { StatCard } from "./StatCard";

/// Seven cards. Five are derived from the PR list already in memory and
/// cost no request; only the two historical counters come from GitHub.
/// Every card is a triage entry point: clicking replaces the filter set and
/// switches to the list, rather than opening a bespoke page per card.
export function Dashboard({
  prs, stats,
}: {
  prs: PullRequest[];
  stats: { merged_week: number; merged_month: number };
}) {
  const derived = deriveStats(prs);
  const { applyPreset } = useFilters();

  return (
    <div className="grid grid-cols-2 gap-4 p-6 lg:grid-cols-4">
      <StatCard label="Merged this week" value={stats.merged_week}
                onClick={() => applyPreset({})} />
      <StatCard label="Merged this month" value={stats.merged_month}
                onClick={() => applyPreset({})} />
      <StatCard label="In merge queue" value={derived.in_merge_queue}
                onClick={() => applyPreset({ inMergeQueueOnly: true })} />
      <StatCard label="Needs rebase or red CI" value={derived.needs_attention} tone="danger"
                onClick={() => applyPreset({ needsAttentionOnly: true })} />
      <StatCard label="Green, awaiting review" value={derived.awaiting_review} tone="success"
                onClick={() => applyPreset({ ci: "success", review: "none", readyOnly: true })} />
      <StatCard label="Approved, needs queueing" value={derived.ready_to_queue} tone="success"
                onClick={() => applyPreset({ ci: "success", review: "approved", readyOnly: true })} />
      <StatCard label="Blocked by comments" value={derived.blocked_by_comments} tone="warn"
                onClick={() => applyPreset({ review: "changes_requested" })} />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run src/components/Dashboard.test.tsx`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard.tsx src/components/StatCard.tsx src/components/Dashboard.test.tsx
git commit -m "feat: dashboard with seven clickable stat cards"
```

---

### Task 18: App shell wiring

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: every component from Tasks 12-17
- Produces: the assembled application

- [ ] **Step 1: Implement the shell**

```tsx
import { useEffect } from "react";
import { usePullRequests, useStats } from "./api/hooks";
import { AuthGate } from "./components/AuthGate";
import { Dashboard } from "./components/Dashboard";
import { FilterBar } from "./components/FilterBar";
import { NudgeWizard } from "./components/NudgeWizard";
import { PrioritiesStrip } from "./components/PrioritiesStrip";
import { PrList } from "./components/PrList";
import { RepoSidebar } from "./components/RepoSidebar";
import { Button } from "./components/ui/button";
import { applyFilters } from "./lib/derive";
import { dismissSplash } from "./splash";
import { useFilters } from "./store/filters";

export default function App() {
  const { data: prs = [], isSuccess } = usePullRequests();
  const { data: stats } = useStats();
  const { filters, view, setView } = useFilters();

  // Splash dismissal is app-driven: it lifts on the first render of real
  // data, not on a timer that would guess wrong on either a slow or a fast
  // machine.
  useEffect(() => {
    if (isSuccess) dismissSplash();
  }, [isSuccess]);

  const visible = applyFilters(prs, filters);

  return (
    <AuthGate>
      <div className="flex h-screen bg-[#0d1117] text-[#e6edf3]">
        <RepoSidebar prs={prs} />
        <main className="flex-1 overflow-auto">
          <header className="flex items-center gap-2 border-b border-[#30363d] px-4 py-3">
            <Button variant={view === "list" ? "default" : "ghost"} size="sm"
                    onClick={() => setView("list")}>Pull requests</Button>
            <Button variant={view === "dashboard" ? "default" : "ghost"} size="sm"
                    onClick={() => setView("dashboard")}>Dashboard</Button>
            <div className="ml-auto"><NudgeWizard prs={prs} /></div>
          </header>

          {view === "dashboard" ? (
            <Dashboard prs={prs} stats={stats ?? { merged_week: 0, merged_month: 0 }} />
          ) : (
            <div className="p-4">
              <PrioritiesStrip prs={prs} />
              <FilterBar prs={prs} />
              <PrList prs={visible} />
            </div>
          )}
        </main>
      </div>
    </AuthGate>
  );
}
```

- [ ] **Step 2: Verify manually**

Run: `make dev`
Expected: splash lifts once data loads; sidebar, list, and dashboard toggle all work.

- [ ] **Step 3: Run all gates**

Run: `make lint && make test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: assemble the app shell"
```

---

## Milestone 5 — Nudge wizard

### Task 19: Nudge formatters

**Files:**
- Create: `src/lib/nudge.ts`, `src/lib/nudge.test.ts`

**Interfaces:**
- Consumes: `PullRequest` (Task 12), `needsAttention`/`awaitingReview` (Task 13)
- Produces:
  - `interface NudgeOptions { grouped?: boolean; annotate?: boolean; slack?: boolean }`
  - `formatNudge(prs: PullRequest[], opts: NudgeOptions): string`
  - `GROUP_THRESHOLD = 3`

- [ ] **Step 1: Write the failing tests**

This output is a product surface that gets pasted into team channels, so the
tests assert exact strings.

```ts
import { describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { formatNudge } from "./nudge";

const [approved, broken, checking] = PR_FIXTURES;

describe("formatNudge", () => {
  it("produces flat markdown bullets by default", () => {
    expect(formatNudge([approved], {})).toBe(
      "- [octocat/hello-world#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
    );
  });

  it("groups under repo headers when asked", () => {
    expect(formatNudge([approved, checking], { grouped: true })).toBe(
      [
        "**octocat/hello-world**",
        "- [#42] Add retry to the fetch client — https://github.com/octocat/hello-world/pull/42",
        "",
        "**octocat/spoon-knife**",
        "- [#7] Bump the parser dependency — https://github.com/octocat/spoon-knife/pull/7",
      ].join("\n"),
    );
  });

  it("annotates status when asked", () => {
    expect(formatNudge([approved], { annotate: true })).toContain("(green, approved)");
    expect(formatNudge([broken], { annotate: true })).toContain("(CI failing)");
  });

  /// Slack's mrkdwn is not markdown: a [text](url) link renders as literal
  /// text there, which is exactly the bad paste this option prevents.
  it("emits Slack mrkdwn links when asked", () => {
    const out = formatNudge([approved], { slack: true });
    expect(out).toContain("<https://github.com/octocat/hello-world/pull/42|octocat/hello-world#42>");
    expect(out).not.toContain("](");
  });

  it("uses Slack bold for group headers in Slack mode", () => {
    const out = formatNudge([approved, checking], { grouped: true, slack: true });
    expect(out).toContain("*octocat/hello-world*");
    expect(out).not.toContain("**octocat/hello-world**");
  });

  it("returns an empty string for no PRs", () => {
    expect(formatNudge([], {})).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/lib/nudge.test.ts`
Expected: FAIL — cannot resolve `./nudge`.

- [ ] **Step 3: Implement**

```ts
import type { PullRequest } from "../types/pr";

export interface NudgeOptions {
  grouped?: boolean;
  annotate?: boolean;
  slack?: boolean;
}

/// Grouping under repo headers is clearer across many repos and noisier for
/// a handful, so it auto-enables at this many distinct repos.
export const GROUP_THRESHOLD = 3;

function annotation(pr: PullRequest): string {
  if (pr.merge === "conflicted") return " (needs rebase)";
  if (pr.ci === "failure") return " (CI failing)";
  if (pr.is_draft) return " (draft)";
  if (pr.ci === "success" && pr.review === "approved") return " (green, approved)";
  if (pr.ci === "success") return " (green, awaiting review)";
  if (pr.ci === "pending") return " (CI running)";
  return "";
}

function line(pr: PullRequest, opts: NudgeOptions, showRepo: boolean): string {
  const ref = showRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
  const note = opts.annotate ? annotation(pr) : "";
  // Slack renders mrkdwn, not markdown: [text](url) shows up as literal
  // text, so the link syntax has to change with the target.
  return opts.slack
    ? `- <${pr.url}|${ref}> ${pr.title}${note}`
    : `- [${ref}] ${pr.title}${note} — ${pr.url}`;
}

export function formatNudge(prs: PullRequest[], opts: NudgeOptions): string {
  if (prs.length === 0) return "";

  if (!opts.grouped) {
    return prs.map((pr) => line(pr, opts, true)).join("\n");
  }

  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  }

  const bold = opts.slack ? "*" : "**";
  return [...byRepo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, list]) =>
      [`${bold}${repo}${bold}`, ...list.map((pr) => line(pr, opts, false))].join("\n"),
    )
    .join("\n\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn vitest run src/lib/nudge.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nudge.ts src/lib/nudge.test.ts
git commit -m "feat: nudge list formatters for markdown and Slack mrkdwn"
```

---

### Task 20: Nudge wizard modal

**Files:**
- Create: `src/components/NudgeWizard.tsx`, `src/components/NudgeWizard.test.tsx`, `src/store/wizard.ts`

**Interfaces:**
- Consumes: `formatNudge` (Task 19), `applyFilters` (Task 13)
- Produces: `<NudgeWizard prs={...} />`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import { NudgeWizard } from "./NudgeWizard";

describe("NudgeWizard", () => {
  it("opens from the trigger button", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    expect(screen.getByText(/Which repositories/i)).toBeDefined();
  });

  /// The generated text gets pasted into team channels, so the user must
  /// see the exact output before it leaves the app.
  it("shows a live preview of the exact output text", () => {
    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("textbox")).toBeDefined();
  });

  it("copies the preview to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<NudgeWizard prs={PR_FIXTURES} />);
    fireEvent.click(screen.getByRole("button", { name: /request reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/NudgeWizard.test.tsx`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import type { PullRequest } from "../types/pr";
import { applyFilters, type Filters } from "../lib/derive";
import { formatNudge, GROUP_THRESHOLD, type NudgeOptions } from "../lib/nudge";
import { repoCounts } from "./RepoSidebar";

export function NudgeWizard({ prs }: { prs: PullRequest[] }) {
  const [step, setStep] = useState(0);
  const [repos, setRepos] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({ readyOnly: true });
  const [opts, setOpts] = useState<NudgeOptions>({ annotate: true });

  const selected = prs.filter((pr) => repos.length === 0 || repos.includes(pr.repo));
  const matched = applyFilters(selected, filters);
  // Grouping helps across many repos and adds noise across few, so it
  // follows the repo count unless the user has said otherwise.
  const grouped = opts.grouped ?? new Set(matched.map((p) => p.repo)).size >= GROUP_THRESHOLD;
  const text = formatNudge(matched, { ...opts, grouped });

  return (
    <Dialog onOpenChange={(open) => !open && setStep(0)}>
      <DialogTrigger asChild>
        <Button size="sm">Request reviews</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Request reviews</DialogTitle></DialogHeader>

        {step === 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Which repositories?</p>
            <p className="text-xs text-[#8b949e]">Select none to include them all.</p>
            {repoCounts(prs).map(({ repo, count }) => (
              <label key={repo} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={repos.includes(repo)}
                  onCheckedChange={(c) =>
                    setRepos(c ? [...repos, repo] : repos.filter((r) => r !== repo))
                  }
                />
                {repo} <span className="text-[#8b949e]">({count})</span>
              </label>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.readyOnly ?? false}
                        onCheckedChange={(c) => setFilters({ ...filters, readyOnly: !!c })} />
              Ready for review only (exclude drafts)
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.ci === "success"}
                        onCheckedChange={(c) =>
                          setFilters({ ...filters, ci: c ? "success" : undefined })} />
              Only PRs with green CI
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.needsAttentionOnly ?? false}
                        onCheckedChange={(c) =>
                          setFilters({ ...filters, needsAttentionOnly: !!c })} />
              Only PRs that are broken or need a rebase
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.staleOnly ?? false}
                        onCheckedChange={(c) => setFilters({ ...filters, staleOnly: !!c })} />
              Only stale PRs (approved and untouched for 3+ days)
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={opts.annotate ?? false}
                          onCheckedChange={(c) => setOpts({ ...opts, annotate: !!c })} />
                Annotate status
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={grouped}
                          onCheckedChange={(c) => setOpts({ ...opts, grouped: !!c })} />
                Group by repo
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={opts.slack ?? false}
                          onCheckedChange={(c) => setOpts({ ...opts, slack: !!c })} />
                Slack format
              </label>
            </div>
            <textarea
              readOnly
              value={text}
              rows={12}
              className="w-full rounded border border-[#30363d] bg-[#0d1117] p-3 font-mono text-xs"
            />
            <p className="text-xs text-[#8b949e]">{matched.length} pull requests</p>
          </div>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          {step < 2 ? (
            <Button onClick={() => setStep(step + 1)}>Next</Button>
          ) : (
            <Button onClick={() => navigator.clipboard.writeText(text)}>Copy</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn vitest run src/components/NudgeWizard.test.tsx`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/NudgeWizard.tsx src/components/NudgeWizard.test.tsx src/store/wizard.ts
git commit -m "feat: nudge wizard with live preview and clipboard copy"
```

---

### Task 21: README and contributor docs

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/dependabot.yml`

**Interfaces:**
- Consumes: everything
- Produces: the public face of the repo

- [ ] **Step 1: Write the README**

Per the Global Constraints, every example uses synthetic repo names. Cover:
what Headstate is, the splash art, install (including the Gatekeeper
`xattr` step, since v1 is unsigned), `gh auth login` as a prerequisite, the
five views, the nudge output formats, and a development section pointing at
the Makefile targets.

- [ ] **Step 2: Write CONTRIBUTING.md**

Must state the privacy rule explicitly, because it is the one project rule a
new contributor cannot infer from the code:

> Headstate is a public repository. Fixtures, screenshots, and documentation
> must use synthetic data (`octocat/hello-world`). Never commit real
> repository names, PR titles, or URLs from a private employer. CI enforces
> this via `scripts/check-privacy.sh`.

Also cover: `make dev`, `make test`, `make lint`, conventional commits, and
that every PR must be green before merge.

- [ ] **Step 3: Write SECURITY.md**

State the token model plainly: Headstate reads the token from `gh auth
token`, holds it in memory only, never persists or logs it, and talks only
to `api.github.com`. v1 is read-only and performs no write operations. Give
a reporting contact.

- [ ] **Step 4: Add dependabot**

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
    groups:
      actions: { patterns: ["*"] }
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: cargo
    directory: "/src-tauri"
    schedule: { interval: weekly }
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
```

- [ ] **Step 5: Verify the privacy gate passes**

Run: `./scripts/check-privacy.sh`
Expected: "privacy check: clean"

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md SECURITY.md .github/dependabot.yml
git commit -m "docs: README, contributing guide, and security policy"
```

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:

| Spec section | Task |
|---|---|
| Stack, scaffold | 1 |
| App + tray icon specs | 2 |
| Splash | 3 |
| CI, privacy policy | 4 |
| Release workflow | 5 |
| Authentication | 6 |
| Model, query, UNKNOWN rule | 7 |
| GitHub client | 8 |
| SQLite snapshot + history | 9 |
| Polling, commands | 10 |
| Tray, close-to-tray | 11 |
| Frontend types, auth gate | 12 |
| Derivations, filters, stale | 13 |
| PR list (GitHub `/pulls` chrome) | 14 |
| Filter bar, label include/exclude, repo sidebar | 15 |
| Priorities strip | 16 |
| Dashboard, seven clickable cards | 17 |
| App shell | 18 |
| Nudge formatters (4 formats) | 19 |
| Nudge wizard | 20 |
| Docs | 21 |

Read-only is enforced as a Global Constraint: no task introduces a mutating
call.

**2. Placeholder scan.** No TBD/TODO. Every code step carries real code.

**3. Type consistency.** `PullRequest` field names are identical across
Rust (`snake_case` via serde) and TypeScript. `MergeState` is
`Mergeable | Conflicted | Checking` in both. `deriveStats` returns exactly
the five non-historical `Stats` fields; `fetch_stats` supplies the other
two. `repoCounts` is defined in Task 15 and reused by Task 20 via import.
`applyPreset` is defined in Task 13 and consumed in Task 17.

**Known gap, deliberate:** the `Checking` re-poll after 5 s described in the
spec is not yet its own task; it is folded into the polling loop's normal
cadence in Task 10. If it proves annoying in daily use, it becomes a
follow-up issue rather than blocking v1.
