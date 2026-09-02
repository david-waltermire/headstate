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

  "auto-cleanup": {
    title: "Automatic cleanup reports",
    body: `Runs the same rules the Artifacts view uses and **writes down what it
would have removed** — then stops.

### It cannot delete

There is no removal path in this build. Turning it on gets you a list,
not an action. That is deliberate: enabling a cleanup feature asks you to
trust a rule you have never seen run against your own machine, and no
description substitutes for seeing what it actually picked.

Read a few reports against your real directories. If the list is right,
acting on it is one click in the Artifacts view. If it is wrong, nothing
was lost finding out.

### What it considers

Build output, and **orphaned** virtualenvs only — never stale ones. An
orphan is a fact; a stale virtualenv is a judgement about a project that
still exists, and an unattended pass is the last place to act on a
judgement.

Directories written to in the last few minutes are recorded as
**skipped**, not silently omitted. A build writing into a \`target\` does
not show up in \`git status\`, so this is the only signal there is — and a
directory that keeps being passed over is something you should be able to
see.

### Why the run is capped

A report listing every directory on the machine is one nobody reads,
which is the same as no report.`,
  },
  "stale-venvs": {
    title: "Stale virtualenvs",
    body: `A virtualenv whose project **still exists on disk** but which nothing
has written to in a long time.

Different from an orphan, and the difference is why this is a separate
setting. An orphan is provable: no directory on this machine produces its
name, so nothing can ever use it again. Stale is an inference about what
you intend to do next, and the threshold is a guess.

### What turning this on means

That you are asserting the guess is right for you. Each row shows how
long it has been idle, so the assertion is informed rather than blind.

Removal still re-checks at the moment you act: a virtualenv used since
the list was drawn is refused, and so is one whose age cannot be read.
Being unable to tell how old something is never counts as evidence that
it is disposable.`,
  },
  "poetry-venvs": {
    title: "Poetry virtualenvs, and why there are so many",
    body: `Poetry names each virtualenv after **the absolute path of the project
that created it** — so every worktree gets its own, and deleting the
worktree leaves the virtualenv behind forever.

That is why this list is long. On the machine this feature was built for,
one project that no longer exists on disk at all accounted for 70 of the
90 virtualenvs and 55 GB.

### The three states

**Orphaned** — no directory on this machine hashes to this virtualenv's
name. The path that created it is gone, so nothing can ever use it again.
This is a *fact*, not an estimate, and it is the only state offered for
removal.

**Stale** — the project directory still exists, but nothing inside the
virtualenv has been written to in over 90 days. Shown so you can see it;
never removed automatically, because a project you have not touched since
spring is not the same as one you have abandoned.

**Live** — everything else, including anything that could not be
measured.

### Why "stale" is not offered for removal

Orphaned is provable. Stale is a guess about your intentions, and this
view will not act on a guess. If a stale virtualenv really is finished
with, deleting its project directory makes it an orphan, and then it can
go.

### What is re-checked when you remove

The verdict is re-derived from the filesystem, not taken from the row you
clicked. If a project directory reappeared since the list was built, that
virtualenv is live again and the removal is refused.`,
  },
  "package-updates": {
    title: "What this list shows",
    body: `Runs each package manager this repository uses and reports what is
behind. **It does not apply anything** — the Copy markdown button is the
deliverable, and it carries enough for a Claude session to do the work:
every package, both versions, the manifest to edit, and that ecosystem's
update command.

### Why "Patch only" and not "Safe"

Patch-only is a fact about the version numbers. *Safe* is a claim about
consequences, and nothing here can check whether a patch release broke
something for you. The filter says what it actually does.

### "Could not compare"

Version schemes are not all the same. .NET ships four-part versions,
Python allows epochs and local versions, and some packages publish
strings nothing can order. Those are shown as **unknown** rather than
guessed at.

That matters for the filters: a version wrongly called major would vanish
from "patch and minor", and one wrongly called minor would be offered as
a small change. So the filtered views say how many they are holding back,
because a list that quietly omits them looks complete when it is not.

### If an ecosystem reports an error

That is a check which did **not run** — usually the tool is not on the
PATH a desktop app inherits, which is different from your terminal's. It
is stated rather than shown as an empty list, because "no updates" and
"we could not look" are opposite answers.`,
  },
  "claude-md": {
    title: "CLAUDE.md files and what they cost",
    body: `Every CLAUDE.md in the repository, the files each one imports with
\`@\`, and an estimate of what they cost in context.

### The totals are estimates

The count is characters divided by four. That is the usual rough figure
for prose and it runs low for code blocks and file paths, which these
files are full of. Every number here is labelled *est.* for that reason —
it is a useful comparison between files, not a measurement.

### Why the whole-tree number matters

A 2 KB CLAUDE.md that imports 40 KB of other files costs the 40 KB. The
file's own size tells you almost nothing, which is why the tree total is
shown separately whenever imports add to it.

### Broken and circular imports

Both are **shown**, never dropped. An import pointing at a file that does
not exist is listed as missing, and a file that imports itself through
any chain is marked circular.

Neither is something another tool will tell you about, and quietly
omitting them would make the tree look complete when it is not.

### Read-only

This view does not edit. Seeing what is in these files, and what they
pull in, is the whole of it for now.`,
  },
  "build-artifacts": {
    title: "Build output, and what puts it back",
    body: `Directories a **tool regenerates**: \`target\`, \`node_modules\`,
\`.terraform\`, .NET's \`bin\`/\`obj\`, and gitignored \`dist\`/\`build\`
folders.

That is the whole membership rule, and it is what makes this view safe in
a way the Worktrees view is not. Deleting build output costs a rebuild.
Deleting a worktree with unpushed commits costs the work. Every row here
names the command that restores it.

### Why a folder named \`bin\` might not be listed

Because the name alone proves nothing. A \`bin\` is .NET's build output
only when a project file — \`.csproj\`, \`.fsproj\`, \`.vbproj\` — sits
beside it. Everywhere else \`bin\` usually holds programs a package
*ships*, which nothing regenerates: deleting one breaks the package.

The same rule governs every kind here. A \`target\` needs a
\`Cargo.toml\`, a \`node_modules\` needs a \`package.json\`, and a
\`dist\` must be gitignored. A directory that cannot prove what made it
is left alone.

### Why these are not on the Worktrees page

Build output lives beside your **checkouts**, not inside your worktrees.
On the machine this feature was built for, 108 GB of Rust build output
sat next to main checkouts and only 0.28 GB inside worktrees — so
removing every worktree would not have touched 99.7% of it.

### Sizes arrive after the list

Finding these directories takes about a second; measuring them takes
around a minute. So the list appears first and fills in, and the total
reads "at least" until every repository has answered. A total over a
partial set is not the total.

### "Written recently"

A build writing into a directory does not show up in \`git status\` —
build output is gitignored, so git cannot see it at all. The only
available signal is when the directory was last written, and a row marked
this way may have a build running in it right now.

Removal **refuses** anything written to in the last few minutes, rather
than trusting the list you clicked. Deleting a \`target\` out from under a
running build is the one way this can cost real time instead of a rebuild.

### What is re-checked when you remove

Everything, and from the filesystem rather than from the row. The list
may be minutes old, so before anything is deleted it must still be inside
a scanned folder, still a real directory rather than a symlink, still
recognised as build output, and still idle. A directory that fails any of
those is refused and named in the result — a refusal is the guard
working, not a malfunction.`,
  },
  "bulk-removal": {
    title: "Bulk cleanup, and leaving the page",
    body: `Removals run **on the backend, in one batch** — not one request per
worktree from this page.

### You can navigate away

The work does not belong to this page. Leaving the Worktrees view, or
switching to Docker or Pull requests, does not cancel or pause anything:
the batch runs to completion and the result still arrives as a
notification when it finishes.

What you lose by leaving is only the running count on the button. The
removals themselves are unaffected.

### Why it can take a while

Each worktree is removed with git plumbing, and git has real work to do
per checkout. A repository with fifty worktrees is fifty sequential
operations, so several minutes is normal rather than a sign that
something has stalled.

Progress is reported as a count, not a spinner, so a slow batch is
distinguishable from a hung one.

### Nothing unsafe is removed

Safety is re-checked at deletion time, not just when the list was
scanned. A worktree that became dirty since the scan is refused and
named in the result, so the count of what was actually removed is
always honest.`,
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
