# Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven-card Stats view with a history-oriented dashboard: daily opened-vs-merged area chart, period delta cards, cycle-time / code-volume / review-burden insights, and a repo distribution table.

**Architecture:** Two new GraphQL queries on the existing `GitHubClient`. The
history query uses aliased day-buckets -- measured at cost 1 for 60 aliases
-- so a 30-day series is one cheap round trip with no pagination. New Tauri
commands expose them; a new `src/lib/stats.ts` holds pure maths; components
compose on the existing `Card` primitive.

**Tech Stack:** Rust (octocrab 0.54, chrono), React 19, recharts 3.8, shadcn chart, TanStack Query 5, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-20-stats-page-design.md`

## Global Constraints

- No employer or organization names anywhere in the repo, fixtures included. `scripts/check-privacy.sh` must pass; it aborts on untracked files, so `git add -N` new files before running.
- Read-only: no GraphQL mutations.
- Auth token stays in memory; never persisted, logged, or placed in an error message.
- `octocrab.graphql()` strips the `data` envelope: read `v["alias"]`, never `v["data"]["alias"]`. Test fixtures still wrap in `{"data": ...}` because that is the wire format.
- Period comparisons exclude the current partial day.
- New frontend code must be reachable from `App.tsx` or knip fails CI.
- Chart series colors: merged `#3fb950`, opened `#58a6ff`.

---

### Task 1: Percent-change and percentile maths

**Files:**
- Create: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

**Interfaces:**
- Produces: `pctChange(current: number, previous: number): number | null`
  returning `null` when both are zero and `Infinity` when only `previous` is
  zero; `percentile(sorted: number[], p: number): number`;
  `formatPct(v: number | null): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { formatPct, pctChange, percentile } from "./stats";

describe("pctChange", () => {
  it("computes a rise", () => {
    expect(pctChange(183, 110)).toBeCloseTo(66.4, 1);
  });
  it("computes a decline", () => {
    expect(pctChange(110, 183)).toBeCloseTo(-39.9, 1);
  });
  // Guards the divide-by-zero that a naive ((c-p)/p) would hit.
  it("reports Infinity when there is no prior activity", () => {
    expect(pctChange(5, 0)).toBe(Infinity);
  });
  it("reports null when both periods are empty", () => {
    expect(pctChange(0, 0)).toBeNull();
  });
});

describe("percentile", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("takes p50", () => expect(percentile(ten, 0.5)).toBe(6));
  it("takes p90", () => expect(percentile(ten, 0.9)).toBe(10));
  it("does not read past the end on a single sample", () => {
    expect(percentile([7], 0.9)).toBe(7);
  });
  // p=1.0 is the ONLY input where floor(n*p) === n, so this is the case
  // that actually exercises the clamp. Verified: removing the clamp leaves
  // every other percentile test passing.
  it("clamps at p100 instead of returning undefined", () => {
    expect(percentile([1, 2, 3], 1.0)).toBe(3);
  });
  it("returns 0 for an empty series rather than NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("formatPct", () => {
  it("signs a rise", () => expect(formatPct(66.4)).toBe("+66%"));
  it("signs a decline", () => expect(formatPct(-39.9)).toBe("-40%"));
  it("labels a start from zero", () => expect(formatPct(Infinity)).toBe("new"));
  it("labels no activity", () => expect(formatPct(null)).toBe("--"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/lib/stats.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/// Percent change between two periods.
///
/// Returns `Infinity` when `previous` is 0 but `current` is not -- there is
/// no meaningful ratio, and the UI renders that as "new" rather than a
/// number. Returns `null` when both are 0, which is "no activity", not a
/// 0% change.
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : Infinity;
  return ((current - previous) / previous) * 100;
}

/// Nearest-rank percentile over an ALREADY SORTED ascending array.
///
/// `Math.floor(n * p)` can equal `n` (e.g. n=1, p=0.9 -> 0 is fine, but
/// n=10, p=1.0 -> 10 is out of bounds), so the index is clamped.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function formatPct(v: number | null): string {
  if (v === null) return "--";
  if (!Number.isFinite(v)) return "new";
  return `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn vitest run src/lib/stats.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat(stats): percent-change and percentile helpers"
```

---

### Task 2: History query construction in Rust

**Files:**
- Modify: `src-tauri/src/github/query.rs`
- Test: inline `#[cfg(test)]` in the same file

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn history_query(now: DateTime<Utc>, days: i64) -> String`
  and `pub fn period_ranges(now: DateTime<Utc>) -> PeriodRanges` where
  `PeriodRanges { week_current: (String, String), week_previous: (String, String), month_current: (String, String), month_previous: (String, String) }`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn builds_two_aliases_per_day() {
        let q = history_query(at("2026-08-20T14:00:00Z"), 30);
        assert_eq!(q.matches("search(").count(), 60);
        assert!(q.contains("m0: search"));
        assert!(q.contains("o29: search"));
    }

    #[test]
    fn counts_back_from_today() {
        let q = history_query(at("2026-08-20T14:00:00Z"), 2);
        assert!(q.contains("merged:2026-08-20"));
        assert!(q.contains("merged:2026-08-19"));
    }

    // Naive day arithmetic breaks across month ends; chrono handles it,
    // this pins the behaviour.
    #[test]
    fn crosses_a_leap_day() {
        let q = history_query(at("2024-03-01T00:30:00Z"), 2);
        assert!(q.contains("merged:2024-02-29"));
    }

    // The current day is incomplete, so counting it against full prior
    // weeks understates the trend. Windows end yesterday.
    #[test]
    fn period_windows_exclude_today_and_do_not_overlap() {
        let r = period_ranges(at("2026-08-20T14:00:00Z"));
        assert_eq!(r.week_current, ("2026-08-13".into(), "2026-08-19".into()));
        assert_eq!(r.week_previous, ("2026-08-06".into(), "2026-08-12".into()));
    }

    #[test]
    fn month_windows_are_thirty_days_each() {
        let r = period_ranges(at("2026-08-20T14:00:00Z"));
        assert_eq!(r.month_current, ("2026-07-21".into(), "2026-08-19".into()));
        assert_eq!(r.month_previous, ("2026-06-21".into(), "2026-07-20".into()));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test github::query`
Expected: FAIL, `history_query` not found.

- [ ] **Step 3: Implement**

Add to the top of `query.rs`:

```rust
use chrono::{DateTime, Duration, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodRanges {
    pub week_current: (String, String),
    pub week_previous: (String, String),
    pub month_current: (String, String),
    pub month_previous: (String, String),
}

fn day(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// One `search` alias per day per series, `m{i}` merged and `o{i}` opened,
/// counting back `days` from `now`.
///
/// Aliased searches cost ONE rate-limit point in total regardless of how
/// many aliases the query carries (measured: 28 aliases -> cost 1). That is
/// why this is a single query instead of paginating merged PRs, which would
/// take 6+ sequential requests at current volume.
pub fn history_query(now: DateTime<Utc>, days: i64) -> String {
    let mut parts = String::from("query {\n");
    for i in 0..days {
        let d = day(now - Duration::days(i));
        parts.push_str(&format!(
            "  m{i}: search(query: \"is:pr author:@me is:merged merged:{d}\", type: ISSUE) {{ issueCount }}\n"
        ));
        parts.push_str(&format!(
            "  o{i}: search(query: \"is:pr author:@me created:{d}\", type: ISSUE) {{ issueCount }}\n"
        ));
    }
    parts.push_str("}\n");
    parts
}

/// Comparison windows, each ending YESTERDAY.
///
/// Today is still accumulating, so including it compares a partial period
/// against complete ones and drags every delta downward. Measured on real
/// data: including today reported +47% week-over-week where the honest
/// full-week comparison was +66%.
pub fn period_ranges(now: DateTime<Utc>) -> PeriodRanges {
    let end = now - Duration::days(1);
    let win = |offset: i64, len: i64| {
        let e = end - Duration::days(offset);
        (day(e - Duration::days(len - 1)), day(e))
    };
    PeriodRanges {
        week_current: win(0, 7),
        week_previous: win(7, 7),
        month_current: win(0, 30),
        month_previous: win(30, 30),
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test github::query`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/github/query.rs
git commit -m "feat(stats): day-bucket history query construction"
```

---

### Task 3: History and merged-detail models and mapping

**Files:**
- Modify: `src-tauri/src/github/model.rs`, `src-tauri/src/github/map.rs`
- Test: inline `#[cfg(test)]` in `map.rs`

**Interfaces:**
- Consumes: `history_query` aliases from Task 2.
- Produces: in `model.rs`:

```rust
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HistoryPoint { pub date: String, pub opened: u64, pub merged: u64 }

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoCount { pub repo: String, pub merged: u64 }

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MergedDetail {
    pub cycle_time_hours: Vec<f64>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub review_count: u64,
    pub comment_count: u64,
    pub sample_size: u64,
    pub repo_counts: Vec<RepoCount>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub points: Vec<HistoryPoint>,
    pub week_current: u64, pub week_previous: u64,
    pub opened_week_current: u64, pub opened_week_previous: u64,
    pub month_current: u64, pub month_previous: u64,
}
```

  and in `map.rs`: `pub fn map_history(v: &Value, days: i64, now: DateTime<Utc>) -> Vec<HistoryPoint>` and `pub fn map_merged_detail(v: &Value) -> MergedDetail`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn maps_day_buckets_oldest_first() {
    // NOTE: no "data" key -- octocrab strips the envelope before we see it.
    let v = json!({
        "m0": {"issueCount": 5}, "o0": {"issueCount": 7},
        "m1": {"issueCount": 3}, "o1": {"issueCount": 4}
    });
    let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
        .unwrap().with_timezone(&Utc);
    let pts = map_history(&v, 2, now);
    // Chart reads left-to-right as time moving forward, so oldest first.
    assert_eq!(pts[0].date, "2026-08-19");
    assert_eq!(pts[0].merged, 3);
    assert_eq!(pts[1].date, "2026-08-20");
    assert_eq!(pts[1].merged, 5);
    assert_eq!(pts[1].opened, 7);
}

#[test]
fn missing_buckets_become_zero_not_panic() {
    let v = json!({ "m0": {"issueCount": 2} });
    let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
        .unwrap().with_timezone(&Utc);
    let pts = map_history(&v, 1, now);
    assert_eq!(pts[0].merged, 2);
    assert_eq!(pts[0].opened, 0);
}

#[test]
fn aggregates_merged_detail_and_cycle_times() {
    let v = json!({"merged": {"nodes": [
        {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T12:00:00Z",
         "additions":100,"deletions":20,"changedFiles":3,
         "reviews":{"totalCount":1},"comments":{"totalCount":2},
         "repository":{"nameWithOwner":"acme/alpha"}},
        {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T10:30:00Z",
         "additions":10,"deletions":5,"changedFiles":1,
         "reviews":{"totalCount":0},"comments":{"totalCount":0},
         "repository":{"nameWithOwner":"acme/alpha"}}
    ]}});
    let d = map_merged_detail(&v);
    assert_eq!(d.sample_size, 2);
    assert_eq!(d.additions, 110);
    assert_eq!(d.changed_files, 4);
    // Sorted ascending so percentile() can index directly.
    assert_eq!(d.cycle_time_hours, vec![0.5, 2.0]);
    assert_eq!(d.repo_counts, vec![RepoCount { repo: "acme/alpha".into(), merged: 2 }]);
}

#[test]
fn skips_nodes_missing_timestamps() {
    let v = json!({"merged": {"nodes": [
        {"createdAt":"2026-08-19T10:00:00Z","mergedAt": null,
         "additions":1,"deletions":0,"changedFiles":1,
         "reviews":{"totalCount":0},"comments":{"totalCount":0},
         "repository":{"nameWithOwner":"acme/alpha"}}
    ]}});
    let d = map_merged_detail(&v);
    assert!(d.cycle_time_hours.is_empty());
    // Still counted for volume: the PR merged, we just cannot time it.
    assert_eq!(d.sample_size, 1);
    assert_eq!(d.additions, 1);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test github::map`
Expected: FAIL, `map_history` not found.

- [ ] **Step 3: Implement**

Add the structs above to `model.rs`, then in `map.rs`:

```rust
use super::model::{History, HistoryPoint, MergedDetail, RepoCount};
use chrono::{DateTime, Duration, Utc};

/// Day-bucket aliases into an ascending-by-date series.
///
/// Aliases are emitted newest-first (`m0` is today); the chart plots time
/// left to right, so the series is reversed here rather than in the view.
/// A missing alias maps to 0: GitHub omits nothing today, but a partial
/// response must not panic a dashboard.
pub fn map_history(v: &Value, days: i64, now: DateTime<Utc>) -> Vec<HistoryPoint> {
    let mut pts: Vec<HistoryPoint> = (0..days)
        .map(|i| HistoryPoint {
            date: (now - Duration::days(i)).format("%Y-%m-%d").to_string(),
            merged: v[format!("m{i}")]["issueCount"].as_u64().unwrap_or(0),
            opened: v[format!("o{i}")]["issueCount"].as_u64().unwrap_or(0),
        })
        .collect();
    pts.reverse();
    pts
}

/// Totals over the merged-PR sample.
///
/// Cycle times are collected only for nodes carrying both timestamps, but
/// such nodes still count toward volume totals -- the PR did merge; only
/// its duration is unknown. The vector is sorted so percentile() can index
/// it without re-sorting per call.
pub fn map_merged_detail(v: &Value) -> MergedDetail {
    let mut d = MergedDetail::default();
    let mut repos: std::collections::HashMap<String, u64> = Default::default();
    let empty = vec![];
    let nodes = v["merged"]["nodes"].as_array().unwrap_or(&empty);
    for n in nodes {
        d.sample_size += 1;
        d.additions += n["additions"].as_u64().unwrap_or(0);
        d.deletions += n["deletions"].as_u64().unwrap_or(0);
        d.changed_files += n["changedFiles"].as_u64().unwrap_or(0);
        d.review_count += n["reviews"]["totalCount"].as_u64().unwrap_or(0);
        d.comment_count += n["comments"]["totalCount"].as_u64().unwrap_or(0);
        if let Some(r) = n["repository"]["nameWithOwner"].as_str() {
            *repos.entry(r.to_string()).or_insert(0) += 1;
        }
        if let (Some(c), Some(m)) = (n["createdAt"].as_str(), n["mergedAt"].as_str()) {
            if let (Ok(c), Ok(m)) = (
                DateTime::parse_from_rfc3339(c),
                DateTime::parse_from_rfc3339(m),
            ) {
                let hours = (m - c).num_seconds() as f64 / 3600.0;
                if hours >= 0.0 {
                    d.cycle_time_hours.push(hours);
                }
            }
        }
    }
    d.cycle_time_hours.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut rc: Vec<RepoCount> = repos
        .into_iter()
        .map(|(repo, merged)| RepoCount { repo, merged })
        .collect();
    // Ties broken by name so the table order is stable between refreshes.
    rc.sort_by(|a, b| b.merged.cmp(&a.merged).then(a.repo.cmp(&b.repo)));
    d.repo_counts = rc;
    d
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test github::map`
Expected: PASS, 4 new tests plus existing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/github/model.rs src-tauri/src/github/map.rs
git commit -m "feat(stats): history and merged-detail models and mapping"
```

---

### Task 4: Client fetches and Tauri commands

**Files:**
- Modify: `src-tauri/src/github/client.rs`, `src-tauri/src/github/query.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` in `client.rs`

**Interfaces:**
- Consumes: `history_query`, `period_ranges` (Task 2); `map_history`, `map_merged_detail` (Task 3).
- Produces: `GitHubClient::fetch_history(&self, now, days) -> Result<History, ClientError>`, `GitHubClient::fetch_merged_detail(&self) -> Result<MergedDetail, ClientError>`, and Tauri commands `get_history(days: i64)` and `get_merged_detail()`.

- [ ] **Step 1: Write the failing test**

Follow the existing `fetch_stats` test in this file for the wiremock setup --
note it wraps the body in `{"data": ...}`, which is the wire format octocrab
then strips.

```rust
#[tokio::test]
async fn fetch_history_maps_buckets_and_periods() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": {
                "m0": {"issueCount": 5}, "o0": {"issueCount": 7},
                "m1": {"issueCount": 3}, "o1": {"issueCount": 4},
                "week_current": {"issueCount": 183},
                "week_previous": {"issueCount": 110},
                "opened_week_current": {"issueCount": 190},
                "opened_week_previous": {"issueCount": 120},
                "month_current": {"issueCount": 571},
                "month_previous": {"issueCount": 515}
            }
        })))
        .mount(&server)
        .await;
    let c = client_for(&server).await;
    let now = DateTime::parse_from_rfc3339("2026-08-20T14:00:00Z")
        .unwrap().with_timezone(&Utc);
    let h = c.fetch_history(now, 2).await.unwrap();
    assert_eq!(h.points.len(), 2);
    assert_eq!(h.points[1].merged, 5);
    assert_eq!(h.week_current, 183);
    assert_eq!(h.week_previous, 110);
    assert_eq!(h.month_current, 571);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test fetch_history`
Expected: FAIL, `fetch_history` not found.

- [ ] **Step 3: Implement**

In `query.rs`, extend `history_query` to append the six period aliases:

```rust
/// Appends the period-comparison aliases to a day-bucket query, so the
/// chart series and all four delta cards arrive in ONE request at a total
/// cost of 1 point.
pub fn history_query_with_periods(now: DateTime<Utc>, days: i64) -> String {
    let r = period_ranges(now);
    let mut q = history_query(now, days);
    q.pop(); // drop the closing brace; the aliases below go inside it
    q.pop();
    let mut add = |alias: &str, filter: &str, range: &(String, String)| {
        q.push_str(&format!(
            "  {alias}: search(query: \"is:pr author:@me {filter} {}..{}\", type: ISSUE) {{ issueCount }}\n",
            range.0, range.1
        ));
    };
    add("week_current", "is:merged merged:", &r.week_current);
    add("week_previous", "is:merged merged:", &r.week_previous);
    add("opened_week_current", "created:", &r.week_current);
    add("opened_week_previous", "created:", &r.week_previous);
    add("month_current", "is:merged merged:", &r.month_current);
    add("month_previous", "is:merged merged:", &r.month_previous);
    q.push_str("}\n");
    q
}
```

Note the `filter` strings already end in `:` so they concatenate directly
onto the range.

Add `MERGED_DETAIL_QUERY` to `query.rs`:

```rust
pub const MERGED_DETAIL_QUERY: &str = r#"
query {
  merged: search(query: "is:pr author:@me is:merged", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        createdAt
        mergedAt
        additions
        deletions
        changedFiles
        reviews { totalCount }
        comments { totalCount }
        repository { nameWithOwner }
      }
    }
  }
}"#;
```

In `client.rs`:

```rust
pub async fn fetch_history(
    &self,
    now: DateTime<Utc>,
    days: i64,
) -> Result<History, ClientError> {
    let v: serde_json::Value = self
        .octocrab
        .graphql(&json!({ "query": history_query_with_periods(now, days) }))
        .await?;
    let count = |k: &str| v[k]["issueCount"].as_u64().unwrap_or(0);
    Ok(History {
        points: map_history(&v, days, now),
        week_current: count("week_current"),
        week_previous: count("week_previous"),
        opened_week_current: count("opened_week_current"),
        opened_week_previous: count("opened_week_previous"),
        month_current: count("month_current"),
        month_previous: count("month_previous"),
    })
}

pub async fn fetch_merged_detail(&self) -> Result<MergedDetail, ClientError> {
    let v: serde_json::Value = self
        .octocrab
        .graphql(&json!({ "query": MERGED_DETAIL_QUERY }))
        .await?;
    Ok(map_merged_detail(&v))
}
```

In `commands.rs`, mirroring the existing `get_stats` signature exactly:

```rust
#[tauri::command]
pub async fn get_history(
    client: State<'_, GhClient>,
    days: i64,
) -> Result<History, String> {
    // Clamp: the UI offers 7/14/30, but a command is a public surface and
    // an unbounded value would build an arbitrarily large query.
    let days = days.clamp(1, 90);
    client
        .fetch_history(Utc::now(), days)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_merged_detail(client: State<'_, GhClient>) -> Result<MergedDetail, String> {
    client.fetch_merged_detail().await.map_err(|e| e.to_string())
}
```

Register both in the `invoke_handler` list in `lib.rs` alongside `get_stats`.

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(stats): history and merged-detail fetches and commands"
```

---

### Task 5: Frontend types and query hooks

**Files:**
- Modify: `src/types/pr.ts`, `src/api/hooks.ts`

**Interfaces:**
- Consumes: the `get_history` / `get_merged_detail` commands (Task 4).
- Produces: TS interfaces `HistoryPoint`, `History`, `RepoCount`, `MergedDetail`; hooks `useHistory(days: number)` and `useMergedDetail()`.

- [ ] **Step 1: Add the types**

Mirror the Rust structs field for field, converting `snake_case` to the same
`snake_case` on the TS side -- serde is not renaming, and the existing
`PullRequest` type already uses snake_case, so this matches.

```ts
export interface HistoryPoint { date: string; opened: number; merged: number }

export interface History {
  points: HistoryPoint[];
  week_current: number; week_previous: number;
  opened_week_current: number; opened_week_previous: number;
  month_current: number; month_previous: number;
}

export interface RepoCount { repo: string; merged: number }

export interface MergedDetail {
  cycle_time_hours: number[];
  additions: number; deletions: number; changed_files: number;
  review_count: number; comment_count: number;
  sample_size: number;
  repo_counts: RepoCount[];
}
```

- [ ] **Step 2: Add the hooks**

Follow the existing `useStats` hook in this file for the `invoke` pattern.

```ts
/// History is fetched only while the Stats view is mounted and held for
/// five minutes: the underlying counts move on the order of hours, and a
/// per-minute refetch would spend rate limit for no visible change.
export function useHistory(days: number) {
  return useQuery({
    queryKey: ["history", days],
    queryFn: () => invoke<History>("get_history", { days }),
    staleTime: 5 * 60 * 1000,
  });
}

export function useMergedDetail() {
  return useQuery({
    queryKey: ["merged-detail"],
    queryFn: () => invoke<MergedDetail>("get_merged_detail"),
    staleTime: 5 * 60 * 1000,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/pr.ts src/api/hooks.ts
git commit -m "feat(stats): history types and query hooks"
```

---

### Task 6: Delta cards

**Files:**
- Create: `src/components/stats/DeltaCards.tsx`
- Test: `src/components/stats/DeltaCards.test.tsx`

**Interfaces:**
- Consumes: `History`, `MergedDetail` (Task 5); `pctChange`, `formatPct`, `percentile` (Task 1); `Card` from `@/components/ui/card`.
- Produces: `<DeltaCards history={History} detail={MergedDetail | undefined} />`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeltaCards } from "./DeltaCards";

const history = {
  points: [],
  week_current: 183, week_previous: 110,
  opened_week_current: 190, opened_week_previous: 120,
  month_current: 571, month_previous: 515,
};

describe("DeltaCards", () => {
  it("shows the merged count and its week-over-week change", () => {
    render(<DeltaCards history={history} detail={undefined} />);
    expect(screen.getByText("183")).toBeTruthy();
    expect(screen.getByText("+66%")).toBeTruthy();
  });

  it("names the comparison window so the number is interpretable", () => {
    render(<DeltaCards history={history} detail={undefined} />);
    expect(screen.getAllByText(/vs previous 7 days/i).length).toBeGreaterThan(0);
  });

  it("renders without a detail payload", () => {
    render(<DeltaCards history={history} detail={undefined} />);
    expect(screen.getByText(/median cycle time/i)).toBeTruthy();
  });

  it("shows median cycle time when detail is present", () => {
    render(
      <DeltaCards
        history={history}
        detail={{
          cycle_time_hours: [0.5, 1.0, 2.0],
          additions: 0, deletions: 0, changed_files: 0,
          review_count: 0, comment_count: 0, sample_size: 3, repo_counts: [],
        }}
      />,
    );
    // Nearest-rank median of [0.5, 1.0, 2.0] is index floor(3*0.5)=1 -> 1.0h.
    expect(screen.getByText("1.0h")).toBeTruthy();
  });
});
```

NOTE: this project has NO jest-dom. Assert with `toBeTruthy()` / `toBeNull()`
/ `toBeDefined()`, matching the existing component tests. `toBeInTheDocument`
throws "Invalid Chai property".

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/stats/DeltaCards.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```tsx
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatPct, pctChange, percentile } from "@/lib/stats";
import type { History, MergedDetail } from "@/types/pr";

/// A single headline number with its change against the prior period.
///
/// `delta` is null when both periods were empty, and Infinity when the
/// prior period was empty -- formatPct renders those as "--" and "new", so
/// only a finite value gets an arrow and a colour.
function DeltaCard({
  label, value, delta, window: win,
}: { label: string; value: string; delta: number | null; window: string }) {
  const finite = delta !== null && Number.isFinite(delta);
  const up = finite && (delta as number) >= 0;
  const Icon = !finite ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <Card className="px-4">
      <div className="text-xs text-[#8b949e]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div
        className={`mt-1 flex items-center gap-1 text-xs ${
          !finite ? "text-[#8b949e]" : up ? "text-[#3fb950]" : "text-[#f85149]"
        }`}
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span>{formatPct(delta)}</span>
        <span className="text-[#8b949e]">{win}</span>
      </div>
    </Card>
  );
}

export function DeltaCards({
  history, detail,
}: { history: History; detail: MergedDetail | undefined }) {
  const median = detail ? percentile(detail.cycle_time_hours, 0.5) : 0;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <DeltaCard
        label="Merged this week"
        value={String(history.week_current)}
        delta={pctChange(history.week_current, history.week_previous)}
        window="vs previous 7 days"
      />
      <DeltaCard
        label="Opened this week"
        value={String(history.opened_week_current)}
        delta={pctChange(history.opened_week_current, history.opened_week_previous)}
        window="vs previous 7 days"
      />
      <DeltaCard
        label="Merged this month"
        value={String(history.month_current)}
        delta={pctChange(history.month_current, history.month_previous)}
        window="vs previous 30 days"
      />
      <DeltaCard
        label="Median cycle time"
        value={detail ? `${median.toFixed(1)}h` : "--"}
        delta={null}
        window={detail ? `over ${detail.sample_size} merged` : ""}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn vitest run src/components/stats/DeltaCards.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/stats src/lib/stats.ts
git commit -m "feat(stats): period delta cards"
```

---

### Task 7: Opened-vs-merged area chart

**Files:**
- Create: `src/components/stats/ActivityChart.tsx`
- Test: `src/components/stats/ActivityChart.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `HistoryPoint` (Task 5); `ChartContainer`, `ChartTooltip`, `ChartTooltipContent` from `@/components/ui/chart`.
- Produces: `<ActivityChart points={HistoryPoint[]} days={number} onDaysChange={(d: number) => void} />`.

- [ ] **Step 1: Add the series colors**

The existing `--chart-1..5` are all zero-chroma greys, so two series drawn
from them are indistinguishable. Add semantic colors to BOTH the `:root` and
the dark blocks in `index.css` (the app runs dark, but a variable defined in
only one block is a latent bug):

```css
  --chart-merged: #3fb950;
  --chart-opened: #58a6ff;
```

- [ ] **Step 2: Write the failing test**

VERIFIED: this project's `chart.tsx` seeds `INITIAL_DIMENSION = { width:
320, height: 200 }`, so `ChartContainer` renders a real SVG under jsdom with
no sized parent -- a spike confirmed an `<svg>` plus 2 `<path>` elements.
No layout workaround is needed in these tests.

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityChart } from "./ActivityChart";

const points = [
  { date: "2026-08-18", opened: 10, merged: 8 },
  { date: "2026-08-19", opened: 12, merged: 14 },
];

describe("ActivityChart", () => {
  it("offers the three range toggles", () => {
    render(<ActivityChart points={points} days={30} onDaysChange={() => {}} />);
    expect(screen.getByRole("button", { name: "7d" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "14d" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "30d" })).toBeTruthy();
  });

  it("marks the active range", () => {
    render(<ActivityChart points={points} days={14} onDaysChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: "14d" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reports a range change", async () => {
    const onDaysChange = vi.fn();
    render(<ActivityChart points={points} days={30} onDaysChange={onDaysChange} />);
    screen.getByRole("button", { name: "7d" }).click();
    expect(onDaysChange).toHaveBeenCalledWith(7);
  });

  it("shows an empty state rather than a broken axis", () => {
    render(<ActivityChart points={[]} days={30} onDaysChange={() => {}} />);
    expect(screen.getByText(/no activity/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `yarn vitest run src/components/stats/ActivityChart.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```tsx
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { HistoryPoint } from "@/types/pr";

const RANGES = [7, 14, 30];

const config = {
  merged: { label: "Merged", color: "var(--chart-merged)" },
  opened: { label: "Opened", color: "var(--chart-opened)" },
};

/// Gradient-filled daily series, opened against merged.
///
/// Not stacked: the two series measure overlapping populations (a PR opened
/// and merged the same day appears in both), so stacking would imply a
/// total that means nothing. Overlaid areas let you read the gap between
/// creation and completion, which is the actual signal.
export function ActivityChart({
  points, days, onDaysChange,
}: { points: HistoryPoint[]; days: number; onDaysChange: (d: number) => void }) {
  return (
    <Card className="px-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Pull request activity</div>
          <div className="text-xs text-[#8b949e]">Opened and merged per day</div>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => onDaysChange(r)}
              className={`rounded px-2 py-1 text-xs ${
                days === r ? "bg-[#1f6feb] text-white" : "text-[#8b949e] hover:bg-[#161b22]"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="py-16 text-center text-sm text-[#8b949e]">
          No activity in this period.
        </div>
      ) : (
        <ChartContainer config={config} className="mt-4 h-56 w-full">
          <AreaChart data={points} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              {(["merged", "opened"] as const).map((k) => (
                <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={config[k].color} stopOpacity={0.7} />
                  <stop offset="95%" stopColor={config[k].color} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="#30363d" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tick={{ fill: "#8b949e", fontSize: 11 }}
              // Full ISO dates overlap badly; show month/day only.
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={32}
              tick={{ fill: "#8b949e", fontSize: 11 }}
              allowDecimals={false}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
            <Area
              dataKey="opened"
              type="monotone"
              stroke={config.opened.color}
              fill="url(#fill-opened)"
              strokeWidth={2}
            />
            <Area
              dataKey="merged"
              type="monotone"
              stroke={config.merged.color}
              fill="url(#fill-merged)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `yarn vitest run src/components/stats/ActivityChart.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/stats/ActivityChart.tsx src/components/stats/ActivityChart.test.tsx src/index.css
git commit -m "feat(stats): opened vs merged activity chart"
```

---

### Task 8: Insight cards and repo distribution table

**Files:**
- Create: `src/components/stats/InsightCards.tsx`, `src/components/stats/RepoTable.tsx`
- Test: `src/components/stats/InsightCards.test.tsx`, `src/components/stats/RepoTable.test.tsx`

**Interfaces:**
- Consumes: `MergedDetail`, `RepoCount` (Task 5); `percentile` (Task 1); `useFilters` from `@/store/filters`.
- Produces: `<InsightCards detail={MergedDetail} />`, `<RepoTable repos={RepoCount[]} />`.

- [ ] **Step 1: Write the failing tests**

```tsx
// InsightCards.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InsightCards } from "./InsightCards";

const detail = {
  cycle_time_hours: [0.5, 1.0, 2.0, 4.0],
  additions: 50000, deletions: 9139, changed_files: 400,
  review_count: 50, comment_count: 120, sample_size: 100,
  repo_counts: [],
};

describe("InsightCards", () => {
  it("shows median and p90 cycle time", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("2.0h")).toBeTruthy();
    expect(screen.getByText(/4.0h/)).toBeTruthy();
  });

  it("shows total lines changed", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("59,139")).toBeTruthy();
  });

  it("shows review burden per PR", () => {
    render(<InsightCards detail={detail} />);
    expect(screen.getByText("1.2")).toBeTruthy(); // 120 comments / 100 PRs
  });

  // sample_size 0 would divide by zero in every per-PR figure.
  it("renders dashes rather than NaN with no sample", () => {
    render(<InsightCards detail={{ ...detail, sample_size: 0, cycle_time_hours: [] }} />);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
```

```tsx
// RepoTable.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepoTable } from "./RepoTable";

const repos = [
  { repo: "acme/alpha", merged: 48 },
  { repo: "acme/beta", merged: 12 },
];

describe("RepoTable", () => {
  it("lists repos with counts", () => {
    render(<RepoTable repos={repos} />);
    expect(screen.getByText("acme/alpha")).toBeTruthy();
    expect(screen.getByText("48")).toBeTruthy();
  });

  it("shows each repo's share of the total", () => {
    render(<RepoTable repos={repos} />);
    expect(screen.getByText("80%")).toBeTruthy(); // 48 of 60
  });

  it("shows an empty state", () => {
    render(<RepoTable repos={[]} />);
    expect(screen.getByText(/no merged pull requests/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/stats/`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement InsightCards**

```tsx
import { Card } from "@/components/ui/card";
import { percentile } from "@/lib/stats";
import type { MergedDetail } from "@/types/pr";

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="px-4">
      <div className="text-xs text-[#8b949e]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-[#8b949e]">{hint}</div>
    </Card>
  );
}

/// Quality signals over the merged sample.
///
/// Every per-PR figure divides by sample_size, so an empty sample renders
/// "--" rather than NaN.
export function InsightCards({ detail }: { detail: MergedDetail }) {
  const n = detail.sample_size;
  const lines = detail.additions + detail.deletions;
  const per = (total: number, digits = 1) =>
    n === 0 ? "--" : (total / n).toFixed(digits);
  const median = percentile(detail.cycle_time_hours, 0.5);
  const p90 = percentile(detail.cycle_time_hours, 0.9);
  const hasTimes = detail.cycle_time_hours.length > 0;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Stat
        label="Cycle time"
        value={hasTimes ? `${median.toFixed(1)}h` : "--"}
        hint={hasTimes ? `median - p90 ${p90.toFixed(1)}h` : "no timing data"}
      />
      <Stat
        label="Lines changed"
        value={lines.toLocaleString()}
        hint={n === 0 ? "no sample" : `median ${per(lines, 0)} per PR - ${per(detail.changed_files)} files`}
      />
      <Stat
        label="Review burden"
        value={per(detail.comment_count)}
        hint={n === 0 ? "no sample" : `comments per PR - ${per(detail.review_count)} reviews`}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implement RepoTable**

```tsx
import { Card } from "@/components/ui/card";
import { useFilters } from "@/store/filters";
import type { RepoCount } from "@/types/pr";

/// Merged-PR distribution across repositories.
///
/// Clicking a row scopes the app to that repo and switches to the list --
/// the "which of my many repos is this happening in" question is the whole
/// reason this table exists, so it must be a way in, not just a readout.
export function RepoTable({ repos }: { repos: RepoCount[] }) {
  const { setFilter, setView } = useFilters();
  const total = repos.reduce((sum, r) => sum + r.merged, 0);

  return (
    <Card className="px-4">
      <div className="text-sm font-semibold">Merged by repository</div>
      {repos.length === 0 ? (
        <div className="py-8 text-center text-sm text-[#8b949e]">
          No merged pull requests in this sample.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {repos.map((r) => {
            const pct = total === 0 ? 0 : Math.round((r.merged / total) * 100);
            return (
              <button
                key={r.repo}
                type="button"
                onClick={() => {
                  setFilter("repo", r.repo);
                  setView("list");
                }}
                className="flex items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-[#161b22]"
              >
                <span className="w-56 shrink-0 truncate text-left">{r.repo}</span>
                <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-[#21262d]">
                  <span
                    className="absolute inset-y-0 left-0 rounded bg-[#3fb950]"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right tabular-nums">{r.merged}</span>
                <span className="w-10 shrink-0 text-right text-xs text-[#8b949e]">{pct}%</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `yarn vitest run src/components/stats/`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/stats
git commit -m "feat(stats): insight cards and repo distribution table"
```

---

### Task 9: Assemble the Stats page

**Files:**
- Create: `src/components/StatsPage.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/Dashboard.tsx` and its test, if no longer referenced
- Test: `src/components/StatsPage.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 5-8.
- Produces: `<StatsPage />`, rendered by `App.tsx` when `view === "dashboard"`.

- [ ] **Step 1: Write the failing test**

Mock the two hooks; the point is composition and the loading/error gates,
not refetching real data.

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/hooks", () => ({
  useHistory: vi.fn(),
  useMergedDetail: vi.fn(),
}));

import { useHistory, useMergedDetail } from "@/api/hooks";
import { StatsPage } from "./StatsPage";

const history = {
  points: [{ date: "2026-08-19", opened: 5, merged: 4 }],
  week_current: 183, week_previous: 110,
  opened_week_current: 190, opened_week_previous: 120,
  month_current: 571, month_previous: 515,
};

describe("StatsPage", () => {
  it("shows a loading state before history arrives", () => {
    vi.mocked(useHistory).mockReturnValue({ data: undefined, isLoading: true } as never);
    vi.mocked(useMergedDetail).mockReturnValue({ data: undefined, isLoading: true } as never);
    render(<StatsPage />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("renders the delta cards once history arrives", () => {
    vi.mocked(useHistory).mockReturnValue({ data: history, isLoading: false } as never);
    vi.mocked(useMergedDetail).mockReturnValue({ data: undefined, isLoading: false } as never);
    render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
  });

  // The detail query is independent; the page must not block on it.
  it("renders history even when the detail query fails", () => {
    vi.mocked(useHistory).mockReturnValue({ data: history, isLoading: false } as never);
    vi.mocked(useMergedDetail).mockReturnValue({
      data: undefined, isLoading: false, isError: true,
    } as never);
    render(<StatsPage />);
    expect(screen.getByText("183")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run src/components/StatsPage.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import { useHistory, useMergedDetail } from "@/api/hooks";
import { ActivityChart } from "./stats/ActivityChart";
import { DeltaCards } from "./stats/DeltaCards";
import { InsightCards } from "./stats/InsightCards";
import { RepoTable } from "./stats/RepoTable";

/// The Stats view: history-oriented counterpart to the PR list.
///
/// The two queries are deliberately independent. History drives the cards
/// and the chart and is cheap; detail samples 100 merged PRs and is only
/// needed by the insight row. A failure or delay in one must not blank the
/// other, so each is gated separately rather than behind one combined
/// loading flag.
export function StatsPage() {
  const [days, setDays] = useState(30);
  const { data: history, isLoading } = useHistory(days);
  const { data: detail } = useMergedDetail();

  if (isLoading || !history) {
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center text-sm text-[#8b949e]">
        Loading statistics...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DeltaCards history={history} detail={detail} />
      <ActivityChart points={history.points} days={days} onDaysChange={setDays} />
      {detail ? (
        <>
          <InsightCards detail={detail} />
          <RepoTable repos={detail.repo_counts} />
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into App.tsx**

Replace the `Dashboard` import and its usage in the `view === "dashboard"`
branch with `StatsPage`. The branch keeps its `p-4` wrapper and the comment
explaining why no priorities strip appears here.

If `Dashboard.tsx` is then unreferenced, delete it and its test -- knip fails
CI on dead files. Check first:

```bash
grep -rn "Dashboard" src/ --include=*.tsx --include=*.ts
```

- [ ] **Step 5: Run the full suite**

Run: `yarn vitest run && yarn lint && yarn tsc --noEmit && yarn knip`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(stats): assemble the stats page"
```

---

### Task 10: Docs and privacy sweep

**Files:**
- Modify: `README.md`, `docs/` as needed

- [ ] **Step 1: Update the README**

Describe the Stats view: what it shows, the 7/14/30 range control, and the
rate-limit cost (2 extra points while the view is open, cached 5 minutes).
Any screenshot must use placeholder repository names -- see Global Constraints.

- [ ] **Step 2: Run the privacy guard**

```bash
git add -N .
./scripts/check-privacy.sh
```

Expected: `privacy check: clean`. The guard aborts if untracked files exist,
hence the `git add -N`.

- [ ] **Step 3: Full gate**

Run: `yarn vitest run && yarn lint && yarn tsc --noEmit && yarn knip && (cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check)`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: describe the stats view"
```
