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
SSH remotes, `<owner>/<repo>#<number>` issue/PR shorthand, GitHub
Enterprise Server URLs, `ssh://git@<host>/...git` clone URLs to any host,
employer email addresses, Slack/Atlassian workspace URLs, and
`PREFIX-NNNN`-shaped internal ticket IDs.

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

The guard also refuses to run (exit 2) if you have **untracked files** in
the working tree. `git grep`, which the guard uses, can only see tracked
and staged content — an untracked file is invisible to it, so a "clean"
result while one exists would be false. Run `git add` (or `git add -N` to
stage without changing content) on any new files and re-run the guard.

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

## Cutting a release

Releases are driven entirely by tags. There is nothing to click and no
version to bump by hand:

```
git tag v0.2.0
git push origin v0.2.0
```

That fires `.github/workflows/release.yml`, which:

1. **Stamps the version from the tag** into `package.json`,
   `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The tag is the
   single source of truth — those three files stay at whatever they say in
   `main` and are only rewritten inside the CI job, never committed. Without
   this, tagging `v0.2.0` would ship `Headstate_0.1.0_universal.dmg` and an
   About box reading `0.1.0`.
2. Builds a **universal** binary (Apple Silicon + Intel), so one download
   runs on both.
3. Signs and notarizes it **if** the Apple secrets are present (see below).
   They are not today, so this step is skipped.
4. Creates the GitHub Release with the `.dmg` and a `.app.tar.gz`, and
   generates release notes from the commits since the last tag.

The tag must be `vMAJOR.MINOR.PATCH`. Anything else (`v1.2`, `latest`,
`vfoo`) fails the job early with a clear message rather than publishing a
mislabelled build.

**The release notes adapt to the signing state on their own.** While
releases are unsigned, every release gets the `xattr -dr
com.apple.quarantine` instruction prepended automatically. Once the signing
secrets exist, that text is replaced with a note that the build is signed
and notarized — no edit to the workflow, and no stale instruction left
behind for users to follow unnecessarily.

To undo a bad tag before anyone downloads it, delete it locally and
remotely (`git tag -d v0.2.0 && git push origin :v0.2.0`) and delete the
GitHub Release. Re-tagging the same version works, but only if the release
and tag are both gone first.

## Code signing (not active yet — #23 stays open)

Releases ship **unsigned** today. `.github/workflows/release.yml` has the
signing and notarization steps wired in, guarded on the relevant secrets
existing, but this repository has none of those secrets set, so every
release build currently takes the unsigned path exactly as before —
nothing changed for users. Signing switches on automatically, with no
further workflow edits, the moment these repo secrets are added
(Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export of a **Developer ID Application** certificate (not Apple Distribution, not Apple Development — those don't work for distribution outside the App Store) |
| `APPLE_CERTIFICATE_PASSWORD` | The password the `.p12` was exported with |
| `KEYCHAIN_PASSWORD` | Any password; used only for the throwaway keychain CI creates to hold the imported cert |
| `APPLE_ID` | The Apple ID email used for notarization |
| `APPLE_PASSWORD` | An [app-specific password](https://support.apple.com/en-ca/HT204397) for that Apple ID — not the account password |
| `APPLE_TEAM_ID` | The Apple Developer Team ID (found on the [membership page](https://developer.apple.com/account/#/membership)) |

`APPLE_SIGNING_IDENTITY` is deliberately not listed as a secret to set —
Tauri infers it from the imported `APPLE_CERTIFICATE` at build time, so
there's nothing to hardcode ahead of having a real certificate.

This project doesn't have a Developer ID cert yet: this machine only has
Apple Distribution (App Store submission) and Apple Development (local
testing) certificates, and the one Developer ID-equivalent certificate
available belongs to an employer, not appropriate for a personal public
repo. Getting a Developer ID Application certificate requires its own
paid Apple Developer account. Until that exists, don't close #23 — the
plumbing is ready, but nothing is actually signed.

v1 is read-only by design — no PR mutation of any kind (no merge, comment,
approve, close, or merge-queue action). If you're proposing a change that
would have Headstate write to GitHub, expect that to be a bigger
conversation about scope, not a quick PR.
