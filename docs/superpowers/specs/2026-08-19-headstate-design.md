# Headstate — Design

**Date:** 2026-08-19
**Status:** Approved for planning
**Repo:** `pktstorm/headstate` (public, Apache-2.0)

## Purpose

A macOS desktop app that shows a developer the state of all their open pull
requests at a glance, and helps them ask colleagues for the reviews they need.

Two jobs, in priority order:

1. **Triage.** What of mine is broken, blocked, or waiting on someone?
2. **Nudge.** Produce a clean, pasteable list of PRs needing review, for Slack
   or for Claude Code.

Everything else is deferred. The app is read-only against GitHub in v1: it
never merges, closes, comments, or approves.

## Findings that shaped this design

These were measured against the live GitHub API on 2026-08-19, not assumed.

**One query returns everything.** A single GraphQL request returns every open
PR authored by the user with CI rollup, mergeability, review decision, merge
queue membership, and labels:

- 27 PRs returned in **2.9 s**, costing **2 points** of a 5000/hour budget.
- The dashboard's counters are one further aliased query costing **1 point**.

This is the central architectural fact. A per-PR fetch strategy (`gh pr view`
in a loop) would have meant 27 subprocesses and ~30 s per refresh. It is not
necessary and the design does not use it.

**`gh search prs` is insufficient.** It omits CI status, mergeability, and
review decision — the three fields the product exists to display.

**Octocrab unwraps the GraphQL envelope.** `octocrab.graphql()` returns the
contents of `data`, not the full response. Fields are at the top level of the
returned value; indexing `["data"]` yields null. Verified by spike.

**`mergeable` is computed lazily.** GitHub returns `UNKNOWN` for recently
pushed PRs while it computes the merge base. Treating `UNKNOWN` as "conflicted"
would flash a false "needs rebase" in the priorities strip on every push.

## Stack

Mirrors `~/code/claudron`, with current versions.

| Layer | Choice |
|---|---|
| Shell | Tauri 2.11 |
| UI | React 19, Vite, TypeScript |
| Styling | Tailwind 4, shadcn/ui |
| Server state | TanStack Query 5 |
| UI state | zustand 5 |
| GitHub client | Octocrab 0.54 |
| Storage | rusqlite 0.40 |
| Async | tokio 1.53 |
| Package manager | yarn 4.5.1 |
| License | Apache-2.0 |

**Why Apache-2.0 over MIT.** Equally permissive, but Apache-2.0 carries an
express patent grant and a patent-retaliation clause; MIT is silent on patents.
For a public tool authored by an employee of a company working adjacent to the
domain, that grant is the material difference.

**Why Octocrab over shelling out to `gh`.** No subprocess per poll, real error
types, and a client that can be pointed at a mock server in tests. `gh` remains
a hard runtime requirement for authentication only.

## Authentication

At startup the Rust core runs `gh auth token` once and builds an Octocrab
client from the result.

- The token is held in memory only. It is never written to SQLite, never
  logged, and never sent anywhere except `api.github.com`.
- No OAuth app, no PAT prompt, no credential storage code in Headstate. The
  security surface is delegated entirely to `gh`, which the user already
  trusts.
- If `gh` is absent or logged out, the app shows a first-run screen explaining
  how to install and run `gh auth login`, rather than a generic error.

There is no `GITHUB_TOKEN` env var fallback in v1. One auth path is easier to
document and to reason about.

## Architecture

```
src-tauri/src
├── auth.rs       `gh auth token` -> Octocrab client; typed AuthError
├── github/
│   ├── query.rs  the GraphQL documents
│   ├── model.rs  PullRequest, CiState, MergeState, ReviewState
│   └── map.rs    GraphQL JSON -> model (the UNKNOWN handling lives here)
├── poll.rs       tokio interval; emits `prs-updated` to the webview
├── store/
│   ├── schema.rs versioned migrations
│   ├── cache.rs  latest snapshot
│   └── history.rs merge events, for week/month counters
└── commands.rs   refresh_now, get_cached, get_stats, get_auth_state

src
├── api/          Tauri invoke wrappers + TanStack Query hooks
├── store/        zustand: filters, selected repo, wizard state
├── components/   PrList, PrRow, FilterBar, PrioritiesStrip, RepoSidebar,
│                 Dashboard, StatCard, NudgeWizard
└── lib/          nudge formatters, relative time, label colors
```

**Polling lives in Rust, not React.** The window can be closed to the tray and
the poll continues, which is what makes a tray badge meaningful. React never
fetches from GitHub; it renders the latest snapshot and listens for
`prs-updated`.

**State split.** TanStack Query owns server state (the PR list, the stats).
zustand owns UI state only (active filters, selected repo, wizard step). No
server data is duplicated into zustand.

### Data flow

```
launch
  -> splash paints immediately (static HTML, before React mounts)
  -> Rust reads SQLite snapshot -> UI renders last known state, marked stale
  -> first poll completes -> `prs-updated` -> query invalidated -> UI reconciles
  -> splash dismissed on first render of real data (app-driven, not a timer)
```

Cold start therefore shows real content, not a spinner.

### Polling

- **60 s** while the window is focused.
- **5 min** when hidden to the tray.
- Manual refresh always available; it cancels and restarts the interval.
- Worst case 120 points/hour against 5000. Rate limit is not a design
  constraint, but `rateLimit` is requested in-query and surfaced in Settings so
  a future regression is visible rather than silent.

### The `UNKNOWN` mergeable case

`MergeState` is a three-state enum: `Mergeable`, `Conflicted`, `Checking`.
`UNKNOWN` maps to `Checking`, which:

- renders as a neutral "checking" affordance, never as a conflict,
- is excluded from the priorities strip,
- schedules one follow-up poll of only the affected PRs after 5 s.

If it is still `UNKNOWN` after that retry, it stays `Checking` until the next
regular poll. It never escalates to `Conflicted` by timeout.

## Storage

SQLite via rusqlite, at the Tauri app-data dir.

**Two roles:**

1. **Snapshot cache** — the last poll's PR list, so launch is instant and the
   app is readable offline.
2. **Merge history** — a row per PR observed merged, so "merged this week /
   this month" is answerable locally and can become trend charts later without
   a schema rewrite.

The live counters still come from GitHub search (authoritative, 1 point).
History is the local record, reconciled on each poll. Where they disagree,
GitHub wins.

Schema changes go through numbered migrations in `store/schema.rs` from the
first commit, so v0.1 users are upgradable.

## Views

### 1. PR list

A faithful port of GitHub's `<org>/<repo>/pulls` chrome:

- Checkbox column, orange PR glyph.
- Title, with label pills inline at the end of the title line.
- Metadata line: `#N opened <relative time> by <author>` plus review state.
- CI result as a check or × glyph at the end of the title line.
- Filter bar: Author, Label, Projects, Milestones, Reviews, Sort.
- Ordered newest first by default.

Dark theme first, matching the screenshot and the splash art.

### 2. Priorities strip

Pinned above the list on every page. Contains only PRs that are **blocked on
the user and on nobody else**:

- merge conflicts (`Conflicted`, never `Checking`),
- failing CI.

Empty state is a single quiet line, not a card. The strip must be worth
looking at; if it cries wolf it will be ignored.

### 3. Repo sidebar

Only repos where the user currently has open PRs, each with a count badge.
Selecting one filters the list. An "All" entry is always first and is the
default.

### 4. Dashboard

shadcn dashboard layout. Seven stat cards:

| Card | Source |
|---|---|
| Merged this week | search `is:merged merged:>=<7d>` |
| Merged this month | search `is:merged merged:>=<30d>` |
| In merge queue | `isInMergeQueue` |
| Needs rebase or red CI | `Conflicted` or CI failing |
| Green, awaiting review | CI success, `reviewDecision` null |
| Green, approved, needs queueing | CI success, `APPROVED`, not in queue |
| Blocked by comments | `CHANGES_REQUESTED` |

Every card is clickable. Clicking applies the corresponding filter set and
navigates to the list — it does not open a bespoke page per card. One list
view, many entry points.

### 5. Nudge wizard

Modal, stepping through: which repos, drafts or ready-only, CI state, label
include/exclude, review state.

Output, all four formats confirmed with the user:

- Markdown bullets: `- [org/repo#123] Title — https://url`
- Grouped under `**org/repo**` headers, auto-enabled at 3 or more distinct
  repos and overridable by the user
- Status annotations: `(green, awaiting review)`, `(needs rebase)`
- Slack mrkdwn toggle: `<url|text>` rather than `[text](url)`

The final step shows a **live preview of the exact text** and a copy button.
This text gets pasted into team channels; the user sees it before it leaves the
app.

### Label filtering

Include **and** exclude, because the dominant real-world case is excluding
`dependencies` to hide dependabot noise. Label pills render in their GitHub
colors, with a computed foreground for contrast.

### Stale detection

A PR that is green and approved and whose `updatedAt` is more than 3 days old
is the single most nudge-worthy state, and no other filter surfaces it. The
3-day threshold is the default and is user-configurable in Settings.

## Tray and window behaviour

- Tray icon always present.
- Closing the window hides to tray; it does not quit. Quit is explicit, from
  the tray menu or ⌘Q.
- Tray menu: show/hide, refresh now, counts summary, quit.
- The tray glyph is a macOS **template image** and therefore carries no color.
  Attention is signalled by a separate badge, not by recoloring the glyph.

## Assets

### Splash

`~/Downloads/Headstate-Splash-1600x1000.png`, 1600×1000. Rendered by static
HTML in `index.html` so it paints before React mounts, and dismissed by the app
on first real render rather than on a timer.

### App icon

Source: one **1024×1024 PNG, sRGB, with alpha**.

- macOS does **not** mask app icons the way iOS does. The squircle must be
  baked into the source art, and it must be Apple's continuous-curvature
  squircle — a plain `border-radius` rounded rect reads visibly wrong beside
  other Dock icons.
- Art occupies roughly the inner **824×824** of the 1024 canvas, centered,
  with the remainder transparent padding.
- `yarn tauri icon <source>` generates the full `.icns`/`.ico` set and all
  PNG sizes.

### Tray icon

Different rules from the app icon:

- **22×22 pt**: ship `trayTemplate.png` (22 px), `@2x` (44 px), `@3x` (66 px).
- **Template image**: pure black artwork, alpha for everything else, **no
  color**. The filename must end in `Template` — that suffix is what tells
  macOS to invert it for light/dark menu bars and highlight it when clicked.
- The splash mark's green/amber/red nodes cannot appear here. The tray glyph is
  the branch outline alone, solid black.

Both derived programmatically from the splash art by a script in `scripts/`, so
they are reproducible rather than hand-exported.

## Privacy of published artifacts

The app at runtime queries **every org and repo the user can access**, with no
allow-list. That is the product.

Separately, and as a docs policy: **no private or employer repository names,
PR titles, URLs, or org names may appear anywhere in this repository** --
README, screenshots, issue text, test fixtures, comments, or commit messages.
All published artifacts use synthetic fixture data (`octocat/hello-world`
style).

This is enforced by an allow-list, not a deny-list: CI scans for any
`owner/repo` reference or github.com URL and fails unless the owner is one of
the handful this project legitimately names. A deny-list would have to spell
out the very names it exists to keep out, which would defeat itself.

## Testing

- **Rust**: unit tests over the GraphQL→model mapping, including the `UNKNOWN`
  path; store migrations; poll interval logic. Octocrab pointed at a local mock
  server for client tests. No test hits the live API.
- **Frontend**: vitest + Testing Library over filter logic, the nudge
  formatters (exact string assertions — this output is a product surface), and
  component rendering from fixtures.
- Fixtures are synthetic, per the policy above.

## CI/CD

**`ci.yml`** — on PRs to main and pushes to main:

- lint: `cargo fmt --check`, `clippy --all-targets -D warnings`, `tsc --noEmit`,
  `eslint`, `knip`
- test-rust: `cargo test`, plus a repeated run to catch races
- test-frontend: `vitest run`
- build: `tauri build --bundles app`
- supply-chain: `cargo deny check`, `yarn npm audit`
- coverage: reported to the job summary, not gated — a threshold invites tests
  written to satisfy a number
- artifact-privacy: grep gate for the policy above

**`release.yml`** — on `v*` tags: universal macOS binary, GitHub Release,
`.dmg` and `.app.tar.gz` uploaded.

Third-party actions pinned to full commit SHAs with a trailing comment naming
the release. Least-privilege `permissions` at workflow level.

## Out of scope for v1

Write actions of any kind (merge, comment, approve, close). Non-macOS
platforms. PRs where the user is a reviewer rather than the author. Notifications.
Trend charts. Multi-account support.

## Milestones

1. **Foundation** — scaffold, CI, license, icons, splash, tray
2. **Data layer** — auth, GraphQL client, model, polling, SQLite
3. **PR list** — list, filters, labels, repo sidebar, priorities strip
4. **Dashboard** — shadcn layout, seven cards, click-through filtering
5. **Nudge wizard** — steps, four output formats, preview, clipboard
