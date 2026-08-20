# Stats Page Design

**Date:** 2026-08-20
**Status:** Approved

## Problem

As developers lean on automated PR composition, three problems appear:

1. **Scatter.** Many PRs across many repositories, easy to lose track of.
2. **Justification.** Needing to show concrete progress to justify the tooling spend.
3. **Trend.** Wanting to see improvement over time, not just a snapshot.

The current Stats page shows seven scalar cards derived from open PRs. Open
PRs are a snapshot: they say nothing about throughput, velocity, or trend,
and they cannot answer any of the three questions above. Every merged PR --
the entire record of work completed -- is invisible to the app today.

## Approach

Add a history-oriented Stats page backed by two new GraphQL queries, and
accumulate a longer local series in the SQLite table that already exists.

### Why aliased day-buckets rather than pagination

A raw time series would page over merged PRs: at ~571 merged in a month and
100 per page, that is 6+ sequential requests per refresh.

GraphQL `search` aliases were measured against the live API instead. A query
carrying 28 aliases returned `cost: 1, remaining: 4931` -- **aliased search
counts cost one point regardless of alias count.**

There is, however, an undocumented ceiling on how many concurrent `search`
aliases one query may carry. Measured against the live API: 28-36 aliases
succeed 5/5; 44 and 46 fail INTERMITTENTLY (44 succeeded once then failed
twice, 46 failed once then succeeded twice); 60 fails outright with a 502
Bad Gateway. It is a server-side timeout rather than a documented limit, so
the series is fetched in 15-day chunks (36 aliases including the period
comparisons) instead of retrying into it. A 30-day range is therefore two
requests and two points -- still far cheaper than the 6+ paginated requests
a raw time series would need.

This is the central design decision: it makes a daily chart cheaper than the
snapshot query the app already runs, and removes pagination entirely.

### Rate-limit budget

| Query | Points | Cadence |
|---|---|---|
| Existing PR snapshot | 2 | every 60s |
| `HISTORY_QUERY` (2 chunks at 30 days) | 2 | Stats view, cached 5 min |
| `MERGED_DETAIL_QUERY` (100 PRs) | 1 | Stats view, cached 5 min |

Against a 5000/hour budget this is immaterial. Both new queries run only
while the Stats view is open, so the common case -- the list view -- costs
exactly what it costs today.

## Data

### Backend

`HistoryPoint { date: String, opened: u64, merged: u64 }` -- one per day.

`PeriodDelta { current: u64, previous: u64 }` -- percent change is computed
in the frontend, which must handle a zero `previous` (report "new" rather
than dividing by zero).

`MergedDetail` aggregates the last 100 merged PRs:
- `cycle_time_hours: Vec<f64>` -- from `createdAt` to `mergedAt`
- `additions`, `deletions`, `changed_files: u64`
- `review_count`, `comment_count: u64`
- `repo_counts: Vec<RepoCount>`

All fields were verified present on the live API before this spec was
written. Measured baseline: 1,396 merged PRs total; median cycle time under
1 hour, p90 2 hours; 59,139 lines across the last 100 merged PRs, median 324
per PR.

### Partial-day correctness

The current day is incomplete: a period ending "now" is always compared
against full periods before it, which systematically flatters the trend
downward. Measured example: day 13 of the live series showed 8 PRs against a
14-day mean near 40, purely because the day was young.

**Rule:** period comparisons exclude the current partial day. The chart
still plots today (the shape is informative) but the delta cards do not
count it, and the UI labels the window it used.

### Local accumulation

The existing `merge_history` table -- created but never written to -- stores
each day's counts as they are observed, so the series extends past the
30-day live window the longer the app runs. Live data is authoritative for
the last 30 days; stored rows serve only the period beyond it.

## UI

Top to bottom:

1. **Four delta cards** -- merged this week, opened this week, merged this
   month, median cycle time. Each shows direction, percent, and the
   comparison window in words.
2. **Area chart** -- opened vs merged daily, stacked gradient fills,
   7/14/30-day toggle.
3. **Three insight cards** -- cycle time (median, p90), code volume (lines,
   median PR size, files), review burden (reviews and comments per PR).
4. **Repo distribution table** -- merge count per repo with inline bars,
   each row clicking through to that repo's filtered list.

### Colors

The `--chart-1..5` variables in `index.css` are all zero-chroma
(`oklch(... 0 0)`), so two series drawn from them would be indistinguishable
greys. Two semantic colors are added, matching the GitHub palette the app
already uses: merged `#3fb950` (green), opened `#58a6ff` (blue).

### Card primitives

`card.tsx` carries only the `Card` export; knip trimmed the unused
sub-components. New cards compose plain markup on that primitive rather than
reintroducing `CardHeader`/`CardTitle`/`CardContent`, which knip would flag
again immediately.

## Testing

- Percent-change maths, including `previous == 0` and the partial-day exclusion.
- Percentile maths on known inputs, including a single-element series.
- Query construction: 30 days yields 60 aliases with correct date bounds.
- Response mapping against a recorded fixture, asserting the `data`-less
  envelope octocrab produces (matching the existing `fetch_stats` test).
- Empty history renders an empty state, not a broken chart.

## Constraints

- No employer or organization names anywhere in the repository, including
  fixtures and screenshots. `scripts/check-privacy.sh` gates this.
- Read-only. No mutations.
- Auth token stays in memory; never persisted, logged, or included in errors.
