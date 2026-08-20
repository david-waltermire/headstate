# Contributing to Headstate

Thanks for taking a look. Headstate is a small, opinionated macOS app —
this doc covers the one rule you can't infer from the code, plus the
day-to-day workflow.

## The privacy rule (read this first)

**Headstate is a public repository.** Fixtures, screenshots, and
documentation must use synthetic data — `octocat/hello-world`,
`octocat/spoon-knife`, and similar, drawn from GitHub's own demo org. Never
commit a real repository name, PR title, branch name, or URL from a private
employer or private codebase. Once something is pushed to a public repo's
history, it's effectively permanent.

CI enforces this on every push and PR via `scripts/check-privacy.sh`, which
scans for `github.com/<owner>/<repo>` URLs, `git@github.com:<owner>/<repo>`
SSH remotes, and `<owner>/<repo>#<number>` issue/PR shorthand.

This script is an **allow-list**, deliberately. A deny-list would have to
spell out the very names it exists to keep out — putting them in the repo
in plain text and defeating itself. An allow-list also catches owners
nobody thought to enumerate ahead of time. If you legitimately need to
reference a new public repository owner (a real upstream dependency, for
example), add it to the `ALLOWED` list at the top of the script rather than
working around the check.

Run the guard locally before you push:

```
./scripts/check-privacy.sh
```

It should print `privacy check: clean`. If it doesn't, fix the reference
(swap in synthetic data) rather than adding the real owner to the
allow-list unless it's genuinely a public, legitimate dependency.

## Workflow

Install dependencies once with `yarn install --immutable`, then use the
Makefile targets for everything:

```
make dev      # run the app locally with live reload
make test     # cargo test + yarn vitest run
make lint     # cargo fmt --check, clippy, tsc, eslint, knip
make fmt      # cargo fmt (writes, doesn't just check)
```

Run `make lint` and `make test` before opening a PR — CI runs the same
checks (plus a build and a supply-chain scan) and every one of them must be
green before merge. There's no fast-tracking a red check.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc.) — look at
`git log` for the pattern the project already uses.

## The `cargo build --release` trap

If you work in `src-tauri/`, do not run `cargo build --release` (or plain
`cargo build`) directly and expect it to produce a runnable app.

`cargo build` only compiles the Rust binary. It has no idea the project
also has a frontend, so it skips Tauri's `beforeBuildCommand` (`yarn
build`), which is what actually compiles the React app into `dist/` and
embeds it in the bundle. The result: a binary that's noticeably smaller
than a real build (no embedded JS/CSS/assets), and if you launch it, the
window opens and renders a blank **white screen** — before any JavaScript
ever loads, because the frontend was never built or embedded in the first
place. There's no error message; it just never shows anything.

This burned a real debugging session, which is why it's called out here
instead of left to be rediscovered. Always build through Tauri:

```
make build            # or: yarn tauri build
```

`cargo test` and `cargo clippy` are fine to run directly from `src-tauri/`
— it's specifically *building the app bundle* that needs to go through
`tauri build`, since only that path runs `beforeBuildCommand`.

## Scope

v1 is read-only by design — no PR mutation of any kind (no merge, comment,
approve, close, or merge-queue action). If you're proposing a change that
would have Headstate write to GitHub, expect that to be a bigger
conversation about scope, not a quick PR.
