/// Every help topic, in one place.
///
/// Content as DATA rather than components, for two reasons. The copy is
/// reviewable as prose without reading JSX around it, and a topic id
/// that does not exist becomes a compile error at the call site rather
/// than an empty Sheet the user opens and closes.
///
/// Markdown because the app already renders it, sanitized, for pull
/// request bodies -- so a table or a list here costs nothing new.
///
/// Written as "what this means for you", NOT copied from the source
/// comments that explain the same rules. A comment says "we do this
/// because X"; help says "this means X". The reasoning behind these
/// rules is in `derive.ts`, `scan.rs` and `docker.ts`, and translating
/// it is the work rather than a formality.
export interface HelpTopic {
  /// Shown as the Sheet's heading. A noun phrase, not a question --
  /// "Worktree safety", not "What is worktree safety?".
  title: string;
  body: string;
}

export const HELP_TOPICS = {
  "needs-attention": {
    title: "What needs your attention",
    body: `A pull request lands here when **it is blocked on you** and nobody else:

- it has **merge conflicts**, or
- its **checks are failing**

Nothing else qualifies, deliberately:

- **Checks still running** do not count — including a re-run after you
  push a fix. A failure that is being re-tested is not a failure yet,
  and nagging you through your own fix is how a list stops being worth
  reading.
- **A missing review** does not count. That is somebody else's move,
  and it appears under *waiting on others* instead.

A conflicted pull request is yours even when it is a draft. You broke
it, draft or not.`,
  },

  "triage-chips": {
    title: "The triage chips",
    body: `These are **filters, not a tally**. Clicking one narrows the list; the
numbers are not meant to add up to the total, and a pull request can
appear under more than one.

*Ready to queue* and *Awaiting review* overlap by design — a pull
request can be both.

**"of N open"** counts every open pull request in view, across the ones
you authored and the ones awaiting your review. The two counts beside
it are subsets of that, chosen by the rules above, so the arithmetic
will not close. That is the intent rather than a defect: a pull request
that is neither blocked on you nor waiting on anyone — a draft, or one
already in the merge queue — belongs in neither.`,
  },

  "pending-reviewers": {
    title: "Who you are waiting on",
    body: `The reviewers who have been **asked and have not yet answered**.

Anyone who has already reviewed is subtracted, so this is who is
outstanding rather than who was ever involved. A comment counts as an
answer: they looked and said something without blocking.

**Seeing nothing here is normal.** It means one of:

- no reviewer has been requested yet
- the repository assigns reviewers instead of requesting reviews — some
  large projects use a bot for this, and then the assignee is shown
- everyone asked has already answered

Silence is not a failure to look. It is the app saying there is nobody
specific to chase.`,
  },
  "worktree-safety": {
    title: "Worktree safety",
    body: `A worktree is **safe** when all three hold: its branch has merged,
nothing is uncommitted, and everything is pushed.

Anything else is reported with what would change it:

| State | What it means | To make it safe |
| --- | --- | --- |
| dirty | uncommitted files | commit or discard them |
| unpushed | commits not on the remote | push the branch |
| never pushed | no upstream at all | push it, or accept losing the work |
| unmerged | the branch has not landed | merge its pull request |

Every one of these is re-checked **at the moment you remove it**, not
from the scan. A worktree that went dirty since the page loaded is
refused rather than deleted.

### When this disagrees with git

If git does not list a branch as merged but this app does, both are
right. A **squash merge** replays your commits as one new commit, so the
originals never become ancestors of the default branch and every
ancestry check says no.

This app compares the branch's whole diff against recent commits on the
default branch instead, which finds the squashed equivalent. Without
that, a measurement on a real machine found ancestry alone recognised
10 of 157 merged worktrees.`,
  },

  "orphaned-worktrees": {
    title: "Orphaned worktrees",
    body: `A worktree whose **repository has been deleted**. The directory is
still on disk, still holding its files, and nothing points at it any
more.

### Why nothing here can be checked

Every safety signal in this view works by running git *inside* the
checkout — is it dirty, has it merged, is it pushed. With the parent
repository gone there is no git to run. Not "we did not check": it
**cannot** be checked, by anything, ever again.

So these are kept out of *Remove safe worktrees* entirely. Everywhere
else in this view the app has verified something before offering to
delete it. Here it has not, and you are the only check.

### What Delete does

Removes the directory outright. There is no verification that the work
inside ever landed anywhere, because that verification is exactly what
is impossible.

If you are unsure, copy the directory somewhere first. Nothing about it
can be recovered afterwards.`,
  },

  "update-checkout": {
    title: "Fast-forward limits",
    body: `Fast-forwards the repository's main checkout to its upstream.

Two deliberate limits:

- **Refused on a dirty tree.** Pulling into uncommitted changes can
  conflict or stop halfway, and recovering from that is not something a
  button should be able to start.
- **Fast-forward only.** A branch that has diverged is reported rather
  than merged. A merge commit created by a background click is not
  something you asked for.

Git's own message is shown either way, including "Already up to date."
when there was nothing to fetch.`,
  },

  "image-states": {
    title: "Stale and superseded images",
    body: `Two overlapping sets, and the difference decides what a bulk removal
takes.

- **superseded** — a newer image exists for the same repository
- **stale** — superseded, *and* nothing is running it, *and* the branch
  it came from has merged

Stale is the safe default. Superseded is wider, and the confirmation
offers it as an opt-in naming exactly how many extra images it adds.

### Images whose use is unknown

Both sets exclude an image the app could not ask about. If \`docker ps\`
cannot be reached, the answer is *unknown*, not *unused* — and treating
unknown as unused is how a bulk removal takes out something a container
needs.`,
  },

  "image-provenance": {
    title: "Where an image came from",
    body: `The app works out what an image was built from two ways:

- a commit-shaped tag, resolved against your local repositories
- the build context and revision recorded by \`docker buildx history\`

Expanding a row shows whichever it found: the commit, its subject, the
directory it was built from, and whether that branch has merged.

### When it shows nothing

**Usually because the image was not built here** — a pulled base image
has no local commit to match. That is ordinary and not a failure.

It can also mean the app is looking in the wrong place: provenance is
resolved against the same directories the Worktrees view scans, so if
every image is unattributed, check that setting.`,
  },

  "build-cache": {
    title: "Build cache health",
    body: `The share of build steps served from cache across your recent builds,
weighted by how many steps each build has — so one trivial target
cannot swing the number.

A cold build is not a problem in itself. A target that **used to be
warm and is not any more** usually means a Dockerfile layer moved, and
everything after it now rebuilds.

Recent builds only, deliberately: averaging months of history hides
exactly the change worth noticing.

### The trade with "clear"

Clearing the build cache reclaims the space beside this number and
turns it cold. The next build of every target starts from nothing.`,
  },

  "stats-sample": {
    title: "What these numbers are drawn from",
    body: `Every figure here comes from a **sample of recent merged pull
requests**, not from all of your history. Three consequences worth
knowing before acting on any of it:

- **p90 is the maximum** for a sample of ten or fewer. A new account's
  single weekend pull request is shown with the authority of a tail
  metric, and it is not one.
- The repository table shows share **of that sample**, not of all time.
- A period with few merges gives a volatile median. It will move a lot
  next week, and the movement will not mean anything.

The sample size is stated beside the figures that depend on it most.`,
  },

  "stats-deltas": {
    title: "Reading the change cards",
    body: `Intake and throughput are different axes, so they are not coloured the
same way.

**"Opened this week +150%"** is rendered neutral, not green. More pull
requests arriving is not an improvement — it is more work. Only the
merge figures are scored as better or worse.

The signal worth watching is the **gap between the two lines** on the
activity chart: opened rising while merged stays flat is a backlog
forming, and neither number says that on its own.`,
  },

  "stats-timezone": {
    title: "UTC day boundaries",
    body: `Days are bucketed in **UTC**, because GitHub's date filters evaluate in
UTC and this chart is built from them.

Totals are unaffected — the shift applies uniformly. What distorts is
the per-day shape near midnight: merging at 6pm Pacific on a Tuesday
lands in Wednesday's bar.

A real limitation rather than a rounding error, and worth knowing
before reading anything into a single day's height.`,
  },

  "scanned-dirs": {
    title: "Scanned directories",
    body: `Where the app looks for git checkouts. It feeds **two** views, which is
not obvious from a setting that appears to be about worktrees:

- **Worktrees** lists every checkout found under these paths
- **Docker** resolves image provenance against these same repositories —
  a commit-shaped tag is matched by asking each repository about it

So a machine configured once works for both, and a machine configured
wrongly breaks both. If Docker images show no provenance at all, this
setting is the first thing to check.`,
  },

  "diagnostic-log": {
    title: "The diagnostic log",
    body: `Off by default. When on, records how long each GitHub request takes and
how much it returned, so a slow view can be diagnosed from evidence
rather than guesswork.

### What it contains

**Counts, timings and durations only.** Never repository names, never
pull request titles, never your token. Error messages from GitHub are
recorded on the Rust side only after they have been scrubbed.

That matters because the point of the log is to send it to someone.

### Where to find it

\`~/Library/Logs/com.pktstorm.headstate/headstate.log\` on macOS.

Safe to leave on — it is noisy rather than expensive — but it is meant
to be turned on while chasing something and off again afterwards.`,
  },

  "poll-interval": {
    title: "How often the app checks GitHub",
    body: `GitHub allows **5,000 rate-limit points per hour**. One poll costs 4, so
even the shortest interval here uses a small fraction of the budget.

Two things the number does not say:

- A **backgrounded window polls at a fifth of this rate**. The interval
  shown is what happens while you are looking at it.
- A manual refresh, and any action that changes a pull request, fetches
  immediately regardless of this setting.

Shortening it costs very little. The reason not to set it very low is
latency on GitHub's side, not the budget.`,
  },

} as const satisfies Record<string, HelpTopic>;

/// Every valid topic id. A call site passing anything else fails to
/// compile, which is the point of keeping this a literal record.
export type HelpTopicId = keyof typeof HELP_TOPICS;
