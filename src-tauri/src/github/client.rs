//! The GitHub client: wraps octocrab's GraphQL transport with the two
//! queries the product needs, and maps their responses into typed Rust.
//!
//! Reads by default; writes only on explicit user action. The mutation
//! transport is `graphql_mutation` below, used solely by `mutate.rs`.

use super::map::{
    map_cycle_trend, map_detail, map_history, map_list, map_merged_detail, map_rate_limit,
    map_search, map_total, map_viewer,
};
use super::model::{CycleTrend, History, MergedDetail, Periods, PrDetail, PullRequest, Stats};
use super::query::{
    cycle_trend_query, history_query_range, history_query_range_with_periods, periods_query,
    COUNT_QUERY, HISTORY_CHUNK_DAYS, MERGED_DETAIL_QUERY, PRS_QUERY, PR_DETAIL_QUERY, STATS_QUERY,
};
use chrono::{DateTime, Duration, Utc};
use octocrab::Octocrab;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("GitHub request failed: {0}")]
    Api(#[from] octocrab::Error),
    /// GitHub answered with something that is not JSON.
    ///
    /// A reported log showed every poll failing with "Serde Error:
    /// expected value at line 1 column 1" -- octocrab's message for a
    /// body it could not parse -- while the line above it, from
    /// octocrab's own logging, read "failed with status 502 Bad
    /// Gateway". The status was the actionable fact and the user only
    /// ever saw the parse failure, which sent three fixes after the
    /// wrong thing.
    #[error("GitHub could not answer (it returned a {0} rather than data). This usually clears on its own.")]
    NotJson(String),
    /// A concurrent chunk task panicked or was cancelled. Surfaced rather
    /// than ignored: silently dropping a chunk would render a short series
    /// that looks like real data.
    #[error("history fetch task failed: {0}")]
    Join(String),
    /// The request exceeded its wall-clock ceiling. Distinct from a
    /// transport error so the banner can say "timed out" rather than
    /// something generic the user cannot act on.
    #[error("GitHub request timed out after {0}s")]
    Timeout(u64),
    /// The response carried GraphQL errors and no usable data.
    #[error("GitHub GraphQL error: {0}")]
    Graphql(String),
    /// The hourly budget is exhausted. Distinct so the banner can say to
    /// wait rather than implying a network fault the user might chase.
    #[error("GitHub rate limit reached — polling will resume automatically ({0})")]
    RateLimited(String),
}

impl ClientError {
    /// Whether waiting is likely to fix this on its own.
    ///
    /// Transport failures are the common case and almost always recover:
    /// measured on a real log, 5 of 164 polls failed with SendRequest and
    /// EVERY one succeeded on the next tick. A Wi-Fi hiccup, a DNS blip,
    /// a laptop waking up.
    ///
    /// Auth and rate limits are the opposite: the next tick will fail the
    /// same way, so the user needs to know now. Rate limiting is listed
    /// as NOT transient for that reason -- it resolves eventually, but
    /// not within a poll or two, and its message tells the user to wait
    /// rather than chase a network fault.
    pub fn is_transient(&self) -> bool {
        match self {
            // The request never reached GitHub, or the response never
            // came back. Retrying is exactly the right response.
            ClientError::Timeout(_) => true,
            ClientError::Api(e) => is_transport_error(e),
            // A panicked chunk task is a bug, not weather.
            ClientError::Join(_) => false,
            // GraphQL errors mean the server answered and objected: a
            // malformed query, a missing field, a permissions problem.
            // The next identical request objects identically.
            ClientError::Graphql(_) => false,
            ClientError::RateLimited(_) => false,
            // Same reasoning as a parse failure from octocrab: the
            // server gave up rather than objected, so the next tick may
            // well succeed.
            ClientError::NotJson(_) => true,
        }
    }
}

/// Whether an octocrab error is a transport failure rather than a reply.
///
/// Octocrab wraps hyper/reqwest failures in `Service`, which is what a
/// dropped connection surfaces as -- the "client error (SendRequest)"
/// the banner was showing. An HTTP status means GitHub answered, which is
/// a different situation even when the status is a server error.
fn is_transport_error(e: &octocrab::Error) -> bool {
    match e {
        octocrab::Error::Service { .. } | octocrab::Error::Hyper { .. } => true,
        // A body that will not parse is the same network fault as a
        // dropped connection, not GitHub objecting to anything.
        //
        // Reported from a fresh install: two banners within 30 seconds,
        // "client error (SendRequest)" and "expected value at line 1
        // column 1". The first was already suppressed as weather; the
        // second fell through to `_ => false`, was treated as
        // actionable, and surfaced immediately -- so the same fault
        // alarmed the user because half of it happened to arrive as a
        // parse failure. serde's "expected value at line 1 column 1" is
        // its message for an EMPTY or non-JSON body: a truncated
        // response, a captive portal, a proxy answering with HTML.
        //
        // The trade, stated so it is a decision and not an oversight: a
        // PERSISTENT parse failure -- GitHub changing a field type --
        // now takes two ticks to report rather than one. That is the
        // same trade `Service` already accepts, and the alternative is
        // alarming every user whose network hiccups once.
        octocrab::Error::Serde { .. } | octocrab::Error::Json { .. } => true,
        // 5xx is the server having a bad time, which the next tick may
        // well survive. 4xx is us being wrong, and repeating will not
        // help.
        octocrab::Error::GitHub { source, .. } => source.status_code.is_server_error(),
        _ => false,
    }
}

/// Pull requests per search alias.
///
/// 100 is GitHub's page maximum, and what the app has always asked for.
/// MEASURED live: 100 costs 6 rate-limit points, 50 costs 3, 25 costs 2 --
/// so halving the page halves the spend as well as the server-side work.
const PAGE_SIZE: u32 = 25;

/// Page sizes for the MERGED-DETAIL query, which is a different shape
/// and keeps its ladder: it fetches far fewer fields per item, so it
/// does not hit the timeout the PR search does, and a smaller sample
/// there costs accuracy rather than completeness.
const PAGE_FULL: u32 = 100;
const PAGE_REDUCED: u32 = 50;

/// A ceiling on how many pages one search will fetch.
///
/// 10 pages is 250 pull requests, far past any real review queue. It
/// exists so a pathological `issueCount` cannot fan out into hundreds of
/// concurrent requests.
const MAX_PAGES: u32 = 10;

/// The cursor for a given offset.
///
/// GitHub's search cursors are base64 of `cursor:<offset>` -- VERIFIED
/// against the live API, where a constructed `cursor:25` returns exactly
/// the items that a `first: 27` query holds at positions 26 and 27.
///
/// This is undocumented, which is why a page that fails is treated as a
/// short list rather than an error: if the encoding ever changes, the
/// symptom is a shortfall the UI already reports, not a broken view.
fn offset_cursor(offset: u32) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(format!("cursor:{offset}"))
}

/// The two searches the app runs, named once so the poll path and the
/// review path cannot drift apart.
const AUTHORED_OPEN: &str = "is:pr is:open author:@me";
const REVIEW_REQUESTED: &str = "is:pr is:open review-requested:@me";

/// Whether GitHub gave up rather than objected.
///
/// A 502, or a body that will not parse -- which is what a 502 looks
/// like from the client, since its body is empty or HTML and serde
/// fails on byte one. Both mean "try asking for less"; a 401 or a
/// malformed query means "asking again changes nothing".
fn server_gave_up(e: &ClientError) -> bool {
    match e {
        ClientError::NotJson(_) => true,
        ClientError::Api(octocrab::Error::GitHub { source, .. }) => {
            source.status_code.is_server_error()
        }
        ClientError::Api(octocrab::Error::Serde { .. } | octocrab::Error::Json { .. }) => true,
        _ => false,
    }
}

/// `Clone` is cheap: `Octocrab` is an `Arc` internally, so a clone
/// shares the same connection pool rather than opening another. That is
/// what lets the paged search spawn its requests concurrently.
#[derive(Clone)]
pub struct GitHubClient {
    octocrab: Octocrab,
}

/// How many fields GitHub refused on the last request, or 0.
///
/// A module-level counter rather than a return value: the partial-data
/// path is buried in a shared helper that every query goes through, and
/// threading an extra channel out of all of them would touch every
/// signature to carry one advisory number.
///
/// Read and cleared by the poll loop after each fetch, so a later
/// complete response stops reporting a shortfall that no longer exists.
pub static REFUSED_FIELDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// How many fields GitHub refused, read off the response it came with.
///
/// `graphql_partial_ok` stashes the count under a key the mapper
/// ignores, so it travels with its own response rather than through
/// shared state that the next request would overwrite.
fn refused_fields(v: &serde_json::Value) -> usize {
    v["__refused"].as_u64().unwrap_or(0) as usize
}

impl GitHubClient {
    pub fn new(octocrab: Octocrab) -> Self {
        Self { octocrab }
    }

    /// Run a GraphQL document, keeping `data` on a PARTIAL success.
    ///
    /// `Octocrab::graphql` deserializes into `GraphqlResponse`, an untagged
    /// enum whose `Err` variant is declared FIRST -- so a 200 carrying both
    /// `data` and a non-empty `errors` array matches `Err` and the usable
    /// `data` is dropped, even though octocrab's own field doc says
    /// "GraphQL returns `data` even in the case of a partial success."
    ///
    /// GitHub returns exactly that when one repository's resolver fails:
    /// every other PR node is present and good. Discarding them meant one
    /// bad repo blanked the whole list and skipped the snapshot write --
    /// defeating `map_search`'s own "one malformed PR should not blank the
    /// list" rule one layer above where it was enforced.
    ///
    /// Errors are only fatal when NO data came back at all.
    async fn graphql_partial_ok(
        &self,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        graphql_partial_ok(&self.octocrab, body).await
    }

    /// One attempt at the PR query, then a smaller one if GitHub gave up.
    ///
    /// MEASURED against the live API: `first: 100` costs 6 rate-limit
    /// points and ~6s; `first: 50` costs 3 and ~4s. On an account whose
    /// pull requests carry many labels and review threads, the full page
    /// makes GitHub time out resolving nested fields -- it answers 502,
    /// or 200 with `RESOURCE_LIMITS_EXCEEDED` errors alongside partial
    /// data.
    ///
    /// A reported log showed EVERY poll failing that way for over an
    /// hour, so the list never populated at all. Half a list beats none:
    /// the truncation is already surfaced by `prs-truncated`, so the UI
    /// says "showing 50 of N" rather than quietly claiming that is
    /// everything.
    ///
    /// Only ONE retry, and only when the failure says the server gave
    /// up. Retrying a 401 or a malformed query would just spend the
    /// budget twice for the same answer.
    /// One search, with a smaller page if GitHub gives up on the first.
    ///
    /// The retry is only for a failure that means the SERVER gave up --
    /// a 5xx or an unparseable body. A 401 or a malformed query means
    /// asking again changes nothing and would spend the budget twice.
    async fn search_page_with_fallback(
        &self,
        query: &str,
    ) -> Result<serde_json::Value, ClientError> {
        // First page at PAGE_SIZE, which also tells us the true total.
        let first = self.search_page(query, PAGE_SIZE, None).await?;
        let total = first["authored"]["issueCount"].as_u64().unwrap_or(0) as u32;
        if total <= PAGE_SIZE {
            return Ok(first);
        }

        // The REST of the pages, all at once.
        //
        // Search cursors are base64 of `cursor:<offset>` -- verified
        // against the live API: a constructed `cursor:25` returns
        // exactly the items a `first: 27` query has at positions 26-27.
        // That means pages do not have to be chained; they can be
        // requested simultaneously, and GitHub shows no contention
        // between concurrent queries.
        let pages = total.div_ceil(PAGE_SIZE).min(MAX_PAGES);
        // Issued together, awaited together. `join_all` would need
        // another crate; a Vec of futures polled by `select`-free
        // sequential await would serialise them, which is the thing this
        // exists to avoid. Spawning is what actually overlaps them.
        let mut handles = Vec::new();
        for i in 1..pages {
            let cursor = offset_cursor(i * PAGE_SIZE);
            let q = query.to_string();
            let client = self.clone();
            handles.push(tokio::spawn(async move {
                client.search_page(&q, PAGE_SIZE, Some(cursor)).await
            }));
        }
        let mut rest = Vec::new();
        for h in handles {
            rest.push(h.await.unwrap_or(Err(ClientError::Graphql(
                "a search page did not complete".into(),
            ))));
        }

        let mut merged = first;
        for page in rest {
            match page {
                Ok(v) => {
                    if let Some(nodes) = v["authored"]["nodes"].as_array() {
                        if let Some(into) = merged["authored"]["nodes"].as_array_mut() {
                            into.extend(nodes.iter().cloned());
                        }
                    }
                }
                // A failed page is a SHORT list, not a failed fetch. The
                // caller already reports a shortfall by comparing what
                // arrived against `issueCount`, and discarding the pages
                // that did arrive would turn a partial answer into no
                // answer -- the mistake v3.2.5 made.
                Err(e) => log::warn!("a page of the search failed ({e}); the list will be short"),
            }
        }
        Ok(merged)
    }

    /// One search, one request.
    async fn search_page(
        &self,
        query: &str,
        first: u32,
        after: Option<String>,
    ) -> Result<serde_json::Value, ClientError> {
        self.graphql_partial_ok(&json!({
            "query": PRS_QUERY,
            "variables": { "q": query, "first": first, "after": after },
        }))
        .await
    }

    /// Every open PR authored by the viewer, with CI, mergeability, review
    /// decision, and merge-queue state.
    ///
    /// Octocrab unwraps the GraphQL `data` envelope, so the value returned
    /// here has `search` at its top level rather than under `data`.
    pub async fn fetch_prs(&self) -> Result<Vec<PullRequest>, ClientError> {
        let v = self.search_page_with_fallback(AUTHORED_OPEN).await?;
        Ok(map_search(&v))
    }

    /// PRs awaiting the user's review.
    ///
    /// Rides along in PRS_QUERY at zero extra rate-limit cost. Kept a
    /// separate call rather than folded into `fetch_prs`'s return type so
    /// the snapshot cache, poll loop and existing commands keep their
    /// shapes; the poll loop fetches both in one request via
    /// `fetch_prs_and_reviewing`.
    /// Fails rather than returning an empty list GitHub did not mean.
    ///
    /// When GitHub refuses fields it nulls the NODES, and the mapper
    /// drops any it cannot render -- so a heavily refused page maps to
    /// ZERO pull requests. Returning that as success caches an empty
    /// list as a valid answer, and because the query is fresh for a
    /// minute, coming back to the view shows "No open pull requests"
    /// indefinitely rather than refetching. That is the reported
    /// behaviour: the first load shows a short list, and every return
    /// after it shows nothing.
    ///
    /// An error is honest here and, unlike an empty success, retries.
    fn reject_empty_after_refusals(
        prs: Vec<PullRequest>,
        refused: usize,
    ) -> Result<Vec<PullRequest>, ClientError> {
        if prs.is_empty() && refused > 0 {
            return Err(ClientError::Graphql(format!(
                "GitHub refused {refused} field(s) and returned no usable pull requests. \
                 This usually clears on the next refresh."
            )));
        }
        Ok(prs)
    }

    pub async fn fetch_reviewing(&self) -> Result<Vec<PullRequest>, ClientError> {
        self.fetch_reviewing_with_shortfall()
            .await
            .map(|(prs, _)| prs)
    }

    /// The review list, plus how many pull requests are MISSING from it.
    ///
    /// The shortfall is a second return value rather than an error: the
    /// pull requests that did arrive are real and worth showing, and
    /// blanking the list over an incomplete one is exactly the
    /// regression v3.5.1 had to undo.
    pub async fn fetch_reviewing_with_shortfall(
        &self,
    ) -> Result<(Vec<PullRequest>, u64), ClientError> {
        // Its OWN request, not both lists. It used to call
        // `fetch_prs_and_reviewing`, so opening To review paid for the
        // authored list as well -- and on a reported account with 40
        // authored and 71 review-requested, that is 111 pull requests
        // fully populated in one query when 71 were wanted.
        //
        // Same shrinking fallback as the authored path: 71 items is
        // nearly twice 40, which is why My pull requests recovered on
        // that account and To review did not.
        // Read the counter for THIS request, before anything else can
        // touch it. Reading it later would race the next poll, and in
        // the test suite it raced other tests.
        // DIAGNOSTIC LOGGING (Settings > diagnostic log).
        let started = std::time::Instant::now();
        let v = self.search_page_with_fallback(REVIEW_REQUESTED).await?;
        // Counted from THIS response, not from shared state. A global
        // counter raced the next poll -- and, in the test suite, other
        // tests running in parallel.
        let mapped = map_list(&v, "authored");
        crate::diag!(
            "[diag] fetch_reviewing total {}ms mapped={}",
            started.elapsed().as_millis(),
            mapped.len()
        );
        // The 100 -> 50 fallback returns a SHORT list, and everything
        // downstream presents it as a complete one. The v3.5.3 log on a
        // real machine caught the consequence: a fallback answered with
        // 50 pull requests when the count was 62, and twelve simply
        // vanished -- no error, no banner, nothing to distinguish
        // 50-of-50 from 50-of-62. That is the "numbers are off" report.
        //
        // Reported as a shortfall rather than an error: the 50 that did
        // arrive are real and worth showing, and blanking the list over
        // an incomplete one is the exact regression v3.5.1 had to undo.
        let total = v["authored"]["issueCount"].as_u64().unwrap_or(0);
        let short = total.saturating_sub(mapped.len() as u64);
        if short > 0 {
            log::warn!(
                "the review list is short: {} of {total} pull requests \
                 (GitHub could not answer the full query)",
                mapped.len()
            );
        }
        let refused = refused_fields(&v);
        Self::reject_empty_after_refusals(mapped, refused).map(|prs| {
            let short = total.saturating_sub(prs.len() as u64);
            (prs, short)
        })
    }

    /// How many pull requests await the user's review.
    ///
    /// A COUNT, not a list. The sidebar badge needs a number, and
    /// fetching 100 fully populated pull requests to render one was the
    /// largest wasted request in the app -- it ran on EVERY view,
    /// including Docker and Worktrees, which show no pull requests at
    /// all. MEASURED: 1 rate-limit point and ~0.9s, against 6 and ~4s
    /// for the list.
    pub async fn count_reviewing(&self) -> Result<u64, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({
                "query": COUNT_QUERY,
                "variables": { "q": REVIEW_REQUESTED },
            }))
            .await?;
        Ok(v["matching"]["issueCount"].as_u64().unwrap_or(0))
    }

    /// Both lists, as two CONCURRENT requests.
    ///
    /// Two requests rather than one aliased query: the aliased form made
    /// every caller pay for both searches, so opening To review fetched
    /// the authored list too. Concurrent, so the wall-clock is one
    /// request rather than the sum.
    pub async fn fetch_prs_and_reviewing(
        &self,
    ) -> Result<(Vec<PullRequest>, Vec<PullRequest>), ClientError> {
        // DIAGNOSTIC LOGGING (Settings > diagnostic log). These two run
        // concurrently, so a total far above the slower of the two
        // means they are NOT actually overlapping -- which would point
        // at connection-pool or rate-limiter serialization rather than
        // at either query.
        let started = std::time::Instant::now();
        let (authored, reviewing) = tokio::join!(
            self.search_page_with_fallback(AUTHORED_OPEN),
            self.search_page_with_fallback(REVIEW_REQUESTED),
        );
        crate::diag!(
            "[diag] fetch_prs_and_reviewing both searches settled in {}ms",
            started.elapsed().as_millis()
        );
        // Both map from the `authored` alias: the query has one search,
        // named that whatever it is searching for.
        Ok((
            map_list(&authored?, "authored"),
            map_list(&reviewing?, "authored"),
        ))
    }

    /// Median cycle time this week against last, in one request.
    pub async fn fetch_cycle_trend(&self, now: DateTime<Utc>) -> Result<CycleTrend, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": cycle_trend_query(now) }))
            .await?;
        Ok(map_cycle_trend(&v))
    }

    /// Run a mutation, treating ANY error as failure.
    ///
    /// Deliberately unlike `graphql_partial_ok`, which keeps `data` when
    /// errors accompany it. That is right for a read -- 26 good PR nodes
    /// beat none -- and wrong for a write: "partly merged" is not a
    /// state, and reporting success while GitHub complained would be the
    /// worst possible outcome for an action the user cannot undo.
    ///
    /// The GitHub message is passed through verbatim: "base branch was
    /// modified" is display-ready and more useful than anything this
    /// layer could substitute.
    /// POST to a REST path with no body and no useful response.
    ///
    /// The one REST write the app makes (re-running failed CI) has no
    /// GraphQL equivalent. The endpoint answers 201 with an EMPTY body,
    /// which is not valid JSON -- so this reads the response as raw
    /// bytes and discards them rather than trying to deserialise
    /// nothing, which is what a plain `post::<_, T>` would do and fail.
    pub(super) async fn rest_post(&self, path: &str) -> Result<(), ClientError> {
        self.octocrab._post(path, None::<&()>).await?;
        Ok(())
    }

    /// A REST POST that CARRIES a body and returns the response.
    ///
    /// Creating a pull request needs both: the request describes what to
    /// open, and the response holds the URL -- which is the only thing
    /// the user actually wants back.
    pub(super) async fn rest_post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let response = self.octocrab._post(path, Some(body)).await?;
        // `_post` returns the raw response; the JSON has to be read from
        // it. A body that will not parse is an error rather than an
        // empty object: silently returning nothing would lose the URL
        // and look like success.
        let parsed: serde_json::Value = self.octocrab.body_to_string(response).await.map_or_else(
            |_| serde_json::Value::Null,
            |text| serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
        );
        Ok(parsed)
    }

    /// Like `graphql_mutation`, but hands back the `data` object.
    ///
    /// Most mutations only need "did it fail", so `graphql_mutation`
    /// discards the payload. A review is different: the response carries
    /// the state the review actually landed in, and that is the only way
    /// to distinguish an approval from one GitHub filed as PENDING.
    pub(super) async fn graphql_mutation_data(
        &self,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        self.graphql_mutation_inner(body).await
    }

    pub(super) async fn graphql_mutation(
        &self,
        body: &serde_json::Value,
    ) -> Result<(), ClientError> {
        self.graphql_mutation_inner(body).await.map(|_| ())
    }

    async fn graphql_mutation_inner(
        &self,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let raw: serde_json::Value = self.octocrab.post("/graphql", Some(body)).await?;

        if let Some(errs) = raw.get("errors").and_then(|e| e.as_array()) {
            if !errs.is_empty() {
                let msg = errs
                    .iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(ClientError::Graphql(if msg.is_empty() {
                    "GitHub refused the change".to_string()
                } else {
                    msg
                }));
            }
        }

        // A response with neither errors nor data means something is
        // wrong with our request shape; do not report success for it.
        match raw.get("data") {
            Some(d) if !d.is_null() => Ok(d.clone()),
            _ => Err(ClientError::Graphql(
                "GitHub returned no result for the change".into(),
            )),
        }
    }

    /// Everything the detail view needs, in one request at cost 1.
    ///
    /// `repo` is `owner/name`; it is split here rather than by the caller
    /// so a malformed value fails in one place with a clear message.
    pub async fn fetch_pr_detail(&self, repo: &str, number: u64) -> Result<PrDetail, ClientError> {
        let (owner, name) = repo
            .split_once('/')
            .ok_or_else(|| ClientError::Graphql(format!("malformed repository: {repo}")))?;
        let v = self
            .graphql_partial_ok(&json!({
                "query": PR_DETAIL_QUERY,
                "variables": { "owner": owner, "repo": name, "number": number }
            }))
            .await?;
        Ok(map_detail(&v, repo))
    }

    /// The PR list together with GitHub's own match count.
    ///
    /// `PRS_QUERY` is `first: 100` with no pagination, and it already
    /// selects `issueCount` -- nothing read it. Above 100 open PRs the
    /// list, the sidebar, and the priorities strip all reported 100 with
    /// the remainder invisible; the strip in particular is designed never
    /// to have a false negative, and silently dropping PR 118 breaks that
    /// promise. Returning the total lets the UI say "showing 100 of 137"
    /// instead of quietly lying.
    /// The authenticated user's login.
    ///
    /// Its own tiny query rather than plumbed out of the poll pipeline:
    /// the login never changes for a session, so the UI asks once and
    /// caches it forever, and threading a rarely-changing string through
    /// every poll and the SQLite snapshot would cost more than it saves.
    pub async fn fetch_viewer(&self) -> Result<String, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": "query { viewer { login } }" }))
            .await?;
        map_viewer(&v).ok_or_else(|| ClientError::Graphql("no viewer login in response".into()))
    }

    pub async fn fetch_prs_with_total(&self) -> Result<(Vec<PullRequest>, u64), ClientError> {
        let started = std::time::Instant::now();
        let v = self.search_page_with_fallback(AUTHORED_OPEN).await?;
        // How long GitHub took, and what it was asked for. A slow
        // response is the leading indicator of the timeout that follows,
        // and neither was recorded anywhere. Counts and timings only --
        // never repository names or titles.
        let elapsed = started.elapsed();
        if elapsed > std::time::Duration::from_secs(5) {
            log::warn!("the pull request query took {:.1}s", elapsed.as_secs_f32());
        }
        // Warn before the budget is actually gone, so the user learns
        // about it from a message rather than from a wall of failures.
        if let Some((remaining, reset)) = map_rate_limit(&v) {
            if remaining < 500 {
                log::warn!("GitHub rate limit low: {remaining} remaining, resets at {reset}");
            }
        }
        Ok((map_search(&v), map_total(&v)))
    }

    /// The two historical counters. The other five dashboard numbers are
    /// derived from the PR list in the frontend and cost no extra request.
    pub async fn fetch_stats(&self, now: DateTime<Utc>) -> Result<Stats, ClientError> {
        let week = (now - Duration::days(7)).format("%Y-%m-%d").to_string();
        let month = (now - Duration::days(30)).format("%Y-%m-%d").to_string();
        let v = self
            .graphql_partial_ok(&json!({
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

    /// The chart's daily merged/opened series plus all four period-delta
    /// cards, in one request built by `history_query_with_periods`.
    /// Day-bucket chunks, fetched CONCURRENTLY and merged.
    ///
    /// GitHub evaluates search aliases serially, so one large query is slow
    /// (measured: 30 aliases = 7.8s). Small chunks in parallel finish in
    /// roughly the time of the slowest one -- 30 days dropped from 17s to
    /// ~3s. Chunk count is bounded by `days / HISTORY_CHUNK_DAYS`, so at the
    /// 90-day clamp this is 18 concurrent requests at 1 point each.
    async fn fetch_history_values(
        &self,
        now: DateTime<Utc>,
        days: i64,
        with_periods: bool,
    ) -> Result<serde_json::Value, ClientError> {
        let mut set = tokio::task::JoinSet::new();
        let mut start = 0;
        while start < days {
            let len = (days - start).min(HISTORY_CHUNK_DAYS);
            let q = if start == 0 && with_periods {
                history_query_range_with_periods(now, start, len)
            } else {
                history_query_range(now, start, len)
            };
            let oc = self.octocrab.clone();
            set.spawn(async move { graphql_partial_ok(&oc, &json!({ "query": q })).await });
            start += len;
        }

        let mut merged = serde_json::Map::new();
        while let Some(joined) = set.join_next().await {
            // A panicked task would otherwise be swallowed and show up as a
            // silently short series, so it is surfaced as an error.
            let chunk = joined.map_err(|e| ClientError::Join(e.to_string()))??;
            if let Some(obj) = chunk.as_object() {
                // Alias indices are absolute, so chunks merge in any
                // completion order without renumbering or clobbering.
                for (k, val) in obj {
                    merged.insert(k.clone(), val.clone());
                }
            }
        }
        Ok(serde_json::Value::Object(merged))
    }

    /// Just the period comparisons -- one small request so the delta cards
    /// can render without waiting on the daily series.
    pub async fn fetch_periods(&self, now: DateTime<Utc>) -> Result<Periods, ClientError> {
        let v = self
            .graphql_partial_ok(&json!({ "query": periods_query(now) }))
            .await?;
        let count = |k: &str| v[k]["issueCount"].as_u64().unwrap_or(0);
        Ok(Periods {
            week_current: count("week_current"),
            week_previous: count("week_previous"),
            opened_week_current: count("opened_week_current"),
            opened_week_previous: count("opened_week_previous"),
            month_current: count("month_current"),
            month_previous: count("month_previous"),
        })
    }

    pub async fn fetch_history(
        &self,
        now: DateTime<Utc>,
        days: i64,
    ) -> Result<History, ClientError> {
        // Chunked because GitHub 502s on a query with too many concurrent
        // `search` aliases -- see HISTORY_CHUNK_DAYS. The first chunk also
        // carries the six period aliases, so a 30-day fetch is six requests
        // and two rate-limit points rather than one request that fails.
        let v = self.fetch_history_values(now, days, true).await?;
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

    /// A sample of the most recent merged PRs, for the insight cards.
    /// The merged-PR sample behind the insight cards.
    ///
    /// The most expensive query the app makes: `additions`, `deletions`
    /// and `changedFiles` are computed per pull request, so GitHub
    /// calculates a diff for each of 100. MEASURED live at 6.5s, against
    /// 2.7s for the same query without those three fields -- they are
    /// roughly 60% of it, and a reported log showed this query returning
    /// 124 RESOURCE_LIMITS_EXCEEDED errors.
    ///
    /// The fields stay: the insight cards genuinely display them. The
    /// SAMPLE shrinks on failure instead, and only on failure -- halving
    /// it moved the mean from 321 to 356 lines in one measurement, which
    /// is a real accuracy cost to pay only when the alternative is no
    /// answer at all.
    pub async fn fetch_merged_detail(&self) -> Result<MergedDetail, ClientError> {
        let v = match self.merged_detail_page(PAGE_FULL).await {
            Err(e) if server_gave_up(&e) => {
                log::warn!(
                    "GitHub could not answer a {PAGE_FULL}-item merged query ({e}); \
                     retrying with {PAGE_REDUCED} -- the averages will be over a smaller sample"
                );
                self.merged_detail_page(PAGE_REDUCED).await?
            }
            other => other?,
        };
        Ok(map_merged_detail(&v))
    }

    async fn merged_detail_page(&self, first: u32) -> Result<serde_json::Value, ClientError> {
        self.graphql_partial_ok(&json!({
            "query": MERGED_DETAIL_QUERY,
            "variables": { "first": first },
        }))
        .await
    }
}

/// See `GitHubClient::graphql_partial_ok`. A free function so the
/// concurrent history chunks, which own a cloned `Octocrab` inside a
/// spawned task, get the same partial-success handling.
async fn graphql_partial_ok(
    octocrab: &Octocrab,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    // Mapped rather than propagated raw: octocrab reports a non-JSON
    // body as a serde failure ("expected value at line 1 column 1"),
    // which describes a parser's internal state and hides the fact that
    // GitHub answered 502. The status is the actionable part.
    // DIAGNOSTIC LOGGING (Settings > diagnostic log). The POST is where
    // octocrab's retry middleware lives: `max_retries: 3` with a
    // 60-second minimum wait on a rate-limit response, so ONE call here
    // can legitimately take minutes while every layer above it simply
    // waits. That is the leading candidate for 5s by hand against a
    // minute in the app, and nothing recorded it. Timed on BOTH paths,
    // since a slow failure is as interesting as a slow success.
    let http_started = std::time::Instant::now();
    let posted: Result<serde_json::Value, _> = octocrab.post("/graphql", Some(body)).await;
    crate::diag!(
        "[diag] graphql POST {} after {}ms",
        if posted.is_ok() { "ok" } else { "failed" },
        http_started.elapsed().as_millis()
    );
    let raw: serde_json::Value = posted.map_err(|e| match &e {
        octocrab::Error::Serde { .. } | octocrab::Error::Json { .. } => {
            ClientError::NotJson("non-JSON response".into())
        }
        _ => ClientError::Api(e),
    })?;

    let errors = raw.get("errors").and_then(|e| e.as_array());
    let data = raw.get("data").filter(|d| !d.is_null());

    match (data, errors) {
        (Some(d), Some(errs)) if !errs.is_empty() => {
            // Keeping `data` is right -- one repository's failed resolver
            // must not blank the whole list. Throwing the errors away was
            // not: this is exactly the shape of a FORBIDDEN or SAML-SSO
            // problem (HTTP 200, partial data, an org silently missing),
            // and the result was a short list under a green "Up to date"
            // with nothing in the log either.
            //
            // Logged by TYPE and count, never by repository name: this is
            // a public repo and the privacy rule applies to logs too.
            let types: Vec<&str> = errs
                .iter()
                .filter_map(|e| e.get("type").and_then(|t| t.as_str()))
                .collect();
            // The types repeat -- 124 errors is usually one cause, not
            // 124 -- so report the distinct set and a count rather than
            // printing the same string a hundred times.
            let mut distinct: Vec<&str> = types.clone();
            distinct.sort_unstable();
            distinct.dedup();
            // One EXAMPLE message, not just the types. Diagnosing this
            // stalled for days because the log recorded
            // "RESOURCE_LIMITS_EXCEEDED" 124 times and never the text,
            // which is where GitHub says WHICH limit and often which
            // field. One is enough -- they repeat -- and it is capped so
            // a long message cannot flood the log.
            //
            // GitHub's own words, and it does not name repositories in
            // them; the privacy rule still holds for everything the app
            // writes itself.
            let example: String = errs
                .first()
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            log::warn!(
                "GraphQL returned {} error(s) alongside usable data; \
                 some results may be missing. Types: {:?}. Example: {}",
                errs.len(),
                distinct,
                example
            );

            // RESOURCE_LIMITS_EXCEEDED on an SSO-protected org is not a
            // rate limit and not a timeout: the token resolves the node
            // and is then refused the fields. It arrives as HTTP 200
            // with partial data, so nothing else in the app treats it as
            // a failure -- the user sees a short or empty list under a
            // green status bar and no explanation.
            //
            // Surfaced rather than only logged, because it is the one
            // error here the user can actually fix, and the fix is not
            // guessable: `gh auth login` again and authorise the token
            // for the organisation.
            // NOT an error. v3.2.5 escalated this to one, which broke
            // the rule stated three comments above -- "one repository's
            // failed resolver must not blank the whole list" -- and did
            // exactly that: a user who had been seeing a partial review
            // queue started seeing nothing at all.
            //
            // GitHub returned usable data alongside the complaint, and a
            // short list beats an empty one. The count is carried out to
            // the UI separately so the shortfall is VISIBLE rather than
            // silent, which was the real problem the escalation was
            // trying to solve.
            if types.contains(&"RESOURCE_LIMITS_EXCEEDED") {
                REFUSED_FIELDS.store(errs.len(), std::sync::atomic::Ordering::Relaxed);
                // Also on the response, so a caller can read the count
                // for the request it actually made.
                let mut d = d.clone();
                if let Some(obj) = d.as_object_mut() {
                    obj.insert("__refused".into(), errs.len().into());
                }
                return Ok(d);
            }

            Ok(d.clone())
        }
        (Some(d), _) => Ok(d.clone()),
        (None, Some(errs)) if !errs.is_empty() => {
            let msg = errs
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            // Name the condition rather than leaving a generic failure the
            // user cannot tell from a network problem or a bad token.
            if msg.to_lowercase().contains("rate limit") {
                return Err(ClientError::RateLimited(msg));
            }
            Err(ClientError::Graphql(if msg.is_empty() {
                "GraphQL request failed".to_string()
            } else {
                msg
            }))
        }
        (None, _) => Err(ClientError::Graphql(
            "GraphQL response contained no data".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {

    /// Serialises the tests that assert an exact `REFUSED_FIELDS` value.
    ///
    /// It is ONE process-global counter and five tests each reset it and
    /// then assert a specific number, so under `--test-threads=8`
    /// whichever pair interleaves loses. CI runs the suite in a loop as
    /// a race check, which is where it surfaced.
    ///
    /// `tokio::sync::Mutex`, not `std::sync::Mutex`: these are
    /// `#[tokio::test]`s and the window that needs protecting contains
    /// the `.await` on the mock server. Holding a std guard across an
    /// await is a deadlock on a multi-threaded runtime, and clippy
    /// rejects it -- which is how the first attempt at this failed.
    ///
    /// The global itself is the real defect; this makes the existing
    /// assertions honest without weakening them. Making the counter
    /// injectable is the better fix and a larger change.
    async fn refused_fields_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        LOCK.lock().await
    }

    use super::super::mutate::ReviewVerdict;
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
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

    /// The verification must be wired into the CALLER, not merely exist.
    ///
    /// `verify_resolved` can be perfectly correct and perfectly unused:
    /// the original bug was exactly that shape, since the document always
    /// selected `thread { isResolved }` and the caller discarded it. A
    /// unit test on the helper cannot see that, so this drives the real
    /// method through a server that answers "accepted, still unresolved".
    #[tokio::test]
    async fn resolve_reports_failure_when_the_thread_did_not_resolve() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "resolveReviewThread": { "thread": { "isResolved": false } } }
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .resolve_thread("RT_1")
            .await
            .expect_err("a resolve that did not take must not report success");
        assert!(
            err.to_string().contains("still"),
            "the message must say what GitHub actually did: {err}"
        );
    }

    #[tokio::test]
    async fn resolve_succeeds_when_the_thread_really_resolved() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "resolveReviewThread": { "thread": { "isResolved": true } } }
            })))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .resolve_thread("RT_1")
            .await
            .unwrap();
    }

    /// Auto-merge claims a FUTURE unattended write. GitHub accepts the
    /// call and arms nothing when the repository forbids the method --
    /// which looked identical to success, and nothing in the app reads
    /// `autoMergeRequest` afterwards to contradict the toast.
    #[tokio::test]
    async fn auto_merge_reports_failure_when_nothing_was_armed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "enablePullRequestAutoMerge": {
                    "pullRequest": { "autoMergeRequest": null }
                } }
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .enable_auto_merge("PR_1", "deadbeef")
            .await
            .expect_err("auto-merge that armed nothing must not report success");
        assert!(err.to_string().contains("did not enable"), "{err}");
    }

    #[tokio::test]
    async fn auto_merge_succeeds_when_it_really_armed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "enablePullRequestAutoMerge": {
                    "pullRequest": { "autoMergeRequest": { "enabledAt": "2026-09-01T10:00:00Z" } }
                } }
            })))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .enable_auto_merge("PR_1", "deadbeef")
            .await
            .unwrap();
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

    /// The reported bug, at its root: "I clicked approve, saw no error,
    /// and it had not worked."
    ///
    /// GitHub can accept `addPullRequestReview` and file the review as
    /// PENDING -- HTTP 200, no `errors` array, nothing for the old code
    /// to object to. It reported success, the button reset to "Approve",
    /// and the approval was never submitted.
    /// The silent truncation the v3.5.3 log caught on a real machine:
    /// the fallback answered with 50 pull requests when the count was
    /// 62, and twelve vanished with no error and no banner.
    #[tokio::test]
    async fn a_short_review_list_reports_how_many_are_missing() {
        let server = MockServer::start().await;
        let nodes: Vec<serde_json::Value> = (0..3)
            .map(|i| {
                serde_json::json!({
                    "number": i + 1, "title": "t", "url": "u",
                    "createdAt": "2026-08-20T10:00:00Z",
                    "updatedAt": "2026-08-20T10:00:00Z",
                    "repository": {"nameWithOwner": "octocat/hello-world"}
                })
            })
            .collect();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "authored": { "issueCount": 10, "nodes": nodes } }
            })))
            .mount(&server)
            .await;

        let (prs, short) = client_for(&server)
            .await
            .fetch_reviewing_with_shortfall()
            .await
            .unwrap();
        assert_eq!(prs.len(), 3, "the pull requests that arrived are kept");
        assert_eq!(short, 7, "and the seven that did not are reported");
    }

    /// A complete list must report NO shortfall, or the banner would
    /// cry wolf on every normal fetch.
    #[tokio::test]
    async fn a_complete_review_list_reports_no_shortfall() {
        let server = MockServer::start().await;
        let nodes: Vec<serde_json::Value> = (0..3)
            .map(|i| {
                serde_json::json!({
                    "number": i + 1, "title": "t", "url": "u",
                    "createdAt": "2026-08-20T10:00:00Z",
                    "updatedAt": "2026-08-20T10:00:00Z",
                    "repository": {"nameWithOwner": "octocat/hello-world"}
                })
            })
            .collect();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "authored": { "issueCount": 3, "nodes": nodes } }
            })))
            .mount(&server)
            .await;

        let (_, short) = client_for(&server)
            .await
            .fetch_reviewing_with_shortfall()
            .await
            .unwrap();
        assert_eq!(short, 0);
    }

    #[tokio::test]
    async fn a_review_left_pending_is_reported_as_a_failure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "addPullRequestReview": {
                    "pullRequestReview": { "state": "PENDING" }
                }}
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .add_review("PR_1", ReviewVerdict::Approve, "")
            .await
            .expect_err("a pending review has not been submitted");
        assert!(
            err.to_string().contains("pending"),
            "the message must say what actually happened: {err}"
        );
    }

    #[tokio::test]
    async fn a_submitted_review_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "addPullRequestReview": {
                    "pullRequestReview": { "state": "APPROVED" }
                }}
            })))
            .mount(&server)
            .await;
        assert!(client_for(&server)
            .await
            .add_review("PR_1", ReviewVerdict::Approve, "")
            .await
            .is_ok());
    }

    /// An unfamiliar state must NOT be treated as failure. Guessing that
    /// an unrecognised value means the review did not land would break
    /// approving outright the next time GitHub adds a state.
    #[tokio::test]
    async fn an_unrecognised_review_state_is_not_treated_as_failure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "addPullRequestReview": {
                    "pullRequestReview": { "state": "SOMETHING_NEW" }
                }}
            })))
            .mount(&server)
            .await;
        assert!(client_for(&server)
            .await
            .add_review("PR_1", ReviewVerdict::Approve, "")
            .await
            .is_ok());
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

    /// Reported from a fresh install: two banners within 30 seconds,
    /// "client error (SendRequest)" and "expected value at line 1
    /// column 1". Both are the SAME network fault. The first was already
    /// suppressed as weather; the second was treated as actionable and
    /// surfaced immediately.
    ///
    /// Served through a real mock rather than constructed by hand:
    /// octocrab's `Serde` variant has no public constructor, and going
    /// through an actual truncated response proves the classification
    /// applies to what the client genuinely produces rather than to an
    /// error I built to match it.
    #[tokio::test]
    async fn a_truncated_response_is_treated_as_weather() {
        let server = MockServer::start().await;
        // An empty 200 body: what a captive portal, a proxy, or a
        // half-open connection produces. serde's "expected value at
        // line 1 column 1" is exactly its message for this.
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("", "application/json"))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(
            err.is_transient(),
            "a truncated response must wait for a second opinion, not alarm the user: {err}"
        );
        // `should_surface` is private to the poll module and asserts the
        // consequence there; what this owns is the classification.
    }

    /// A server that accepts the connection and then never answers must
    /// not hang the caller forever.
    ///
    /// Reported: a fresh install sat on "Loading pull requests" for
    /// minutes. `refresh_now` -- the cold-start path, taken whenever the
    /// cache is empty -- had no overall timeout, and the client's
    /// transport timeouts do not cover it: the client's own comment says
    /// a server that trickles bytes keeps a read alive indefinitely, and
    /// with `retry` enabled each attempt restarts them.
    ///
    /// Uses a 1-second bound rather than the real 90 so the test is
    /// fast; what it asserts is that the timeout FIRES, which is the
    /// property `refresh_now` now depends on.
    #[tokio::test]
    async fn a_stalled_response_is_bounded_by_a_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": {}}))
                    .set_delay(std::time::Duration::from_secs(30)),
            )
            .mount(&server)
            .await;

        let client = client_for(&server).await;
        let r = tokio::time::timeout(std::time::Duration::from_secs(1), client.fetch_prs()).await;
        assert!(
            r.is_err(),
            "a stalled request must be cut off, not awaited forever"
        );
    }

    /// A reported log showed EVERY poll failing for over an hour with
    /// 502 Bad Gateway, and 124 `RESOURCE_LIMITS_EXCEEDED` errors on the
    /// one response that got through -- GitHub timing out while
    /// resolving nested fields on a 100-item page. The list never
    /// populated at all.
    ///
    /// Half a list beats none, and the truncation is already surfaced,
    /// so the UI says "showing 50 of N" rather than claiming that is
    /// everything.
    /// The 502 this used to work around is now PREVENTED rather than
    /// retried.
    ///
    /// The old ladder asked for 100 items, took a ~10s timeout, then
    /// asked for 50 and took another. MEASURED against the live API: on
    /// a dense account both rungs fail, so it was ~21s of waste before a
    /// truncated list -- which matches the 20.8s and 21.3s in the
    /// original report exactly.
    ///
    /// The cause was never page size in general. It was
    /// `mergeStateStatus`, which GitHub computes per pull request
    /// synchronously: measured at ~154ms each against a ~0.7s baseline
    /// for the whole search. At 25 the query lands inside the timeout.
    #[tokio::test]
    async fn the_first_page_is_small_enough_to_answer() {
        let server = MockServer::start().await;
        // A 100-item request would go unmatched and fail the test; only
        // PAGE_SIZE is mocked.
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"first\":25"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"issueCount": 1, "nodes": []}, "reviewing": {"nodes": []}}
            })))
            .mount(&server)
            .await;

        let (_prs, total) = client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .expect("a 25-item page must not need a fallback");
        assert_eq!(total, 1);
    }

    /// A result larger than one page is fetched as SEVERAL pages, and
    /// they are merged.
    ///
    /// Cursors are constructed rather than chained -- GitHub's search
    /// cursor is base64 of `cursor:<offset>`, verified against the live
    /// API -- so the pages issue concurrently instead of waiting on each
    /// other.
    #[tokio::test]
    async fn a_large_result_is_fetched_as_several_pages() {
        let server = MockServer::start().await;
        let node = |n: u64| {
            serde_json::json!({
                "number": n, "title": "t", "url": "u",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "repository": {"nameWithOwner": "octocat/hello-world"}
            })
        };

        // Page one reports a total of 30, so a second page is needed.
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"after\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"issueCount": 30, "nodes": [node(1)]}, "reviewing": {"nodes": []}}
            })))
            .mount(&server)
            .await;
        // The second page, addressed by a constructed offset cursor.
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("Y3Vyc29yOjI1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"issueCount": 30, "nodes": [node(2)]}, "reviewing": {"nodes": []}}
            })))
            .mount(&server)
            .await;

        let (prs, total) = client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .unwrap();
        assert_eq!(total, 30, "the true total comes from issueCount");
        assert_eq!(prs.len(), 2, "both pages are merged: {prs:?}");
    }

    /// A page that FAILS is a short list, not a failed fetch.
    ///
    /// Discarding the pages that did arrive would turn a partial answer
    /// into no answer -- the mistake v3.2.5 made, and the reason the UI
    /// compares what arrived against `issueCount` rather than trusting
    /// the length.
    #[tokio::test]
    async fn a_failed_page_shortens_the_list_rather_than_emptying_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"after\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {
                    "authored": {"issueCount": 30, "nodes": [{
                        "number": 1, "title": "t", "url": "u",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                        "repository": {"nameWithOwner": "octocat/hello-world"}
                    }]},
                    "reviewing": {"nodes": []}
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("Y3Vyc29yOjI1"))
            .respond_with(ResponseTemplate::new(502).set_body_raw("", "text/html"))
            .mount(&server)
            .await;

        let (prs, total) = client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .expect("a failed page must not fail the whole fetch");
        assert_eq!(prs.len(), 1, "what arrived is kept");
        assert_eq!(total, 30, "and the shortfall stays visible");
    }

    /// Only when the SERVER gave up. A 401 means asking again changes
    /// nothing, and retrying would spend the budget twice for the same
    /// answer -- and on a bad token, double the failed requests.
    /// The message the user actually reads. "Serde Error: expected
    /// value at line 1 column 1" describes a parser's internal state and
    /// hides that GitHub answered 502 -- which is what sent three fixes
    /// after the wrong cause.
    #[tokio::test]
    async fn a_non_json_response_says_so_in_plain_words() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(502).set_body_raw("<html>", "text/html"))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("line 1 column 1"),
            "no parser internals: {msg}"
        );
        assert!(msg.contains("could not answer"), "{msg}");
        // And it is still weather, so one blip stays quiet.
        assert!(err.is_transient(), "{msg}");
    }

    /// `$first` is non-null, so every call site must pass it.
    ///
    /// It became a variable when the page size did, and
    /// `fetch_prs_and_reviewing` was missed -- GitHub then rejected that
    /// query outright ("Variable $first of type Int! was provided
    /// invalid value") and the review queue returned nothing at all.
    /// This asserts the review path specifically, since that is the one
    /// that broke.
    #[tokio::test]
    async fn every_call_site_supplies_the_page_size() {
        // Process-global counter: a previous test's refusals would
        // otherwise make this empty fixture look like a refused page.
        let _guard = refused_fields_lock().await;
        REFUSED_FIELDS.store(0, std::sync::atomic::Ordering::Relaxed);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"first\":"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"nodes": []}, "reviewing": {"nodes": []}}
            })))
            .mount(&server)
            .await;

        // Unmatched requests 404 in wiremock, so a call that omits
        // `first` fails here rather than passing silently.
        assert!(client_for(&server).await.fetch_reviewing().await.is_ok());
    }

    /// To review fetches ONLY the review queue.
    ///
    /// It used to call `fetch_prs_and_reviewing`, so opening that view
    /// also fetched the authored list -- on a reported account, 111
    /// fully populated pull requests when 71 were wanted. That is why My
    /// pull requests recovered there once the page shrank and To review
    /// did not.
    #[tokio::test]
    async fn the_review_queue_does_not_fetch_the_authored_list() {
        // Process-global counter: a previous test's refusals would
        // otherwise make this empty fixture look like a refused page.
        let _guard = refused_fields_lock().await;
        REFUSED_FIELDS.store(0, std::sync::atomic::Ordering::Relaxed);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("review-requested"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"nodes": []}}
            })))
            .expect(1)
            .mount(&server)
            .await;

        // Any request NOT matching `review-requested` is unmatched and
        // 404s, so fetching the authored list too fails this.
        assert!(client_for(&server).await.fetch_reviewing().await.is_ok());
    }

    /// The most expensive query the app makes, and the one a reported
    /// log showed returning 124 RESOURCE_LIMITS_EXCEEDED errors. It
    /// needs the same fallback the pull request query got.
    #[tokio::test]
    async fn the_merged_sample_shrinks_when_github_gives_up() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"first\":100"))
            .respond_with(ResponseTemplate::new(502).set_body_raw("", "text/html"))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"first\":50"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"merged": {"nodes": []}}
            })))
            .mount(&server)
            .await;

        // Reaching the reduced page at all is the assertion: the full
        // one 502s, and without the fallback this is an error.
        assert!(client_for(&server)
            .await
            .fetch_merged_detail()
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn an_auth_failure_is_not_retried_smaller() {
        let server = MockServer::start().await;
        let mock = Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "Bad credentials"
            })))
            .expect(1)
            .named("exactly one attempt");
        server.register(mock).await;

        assert!(client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .is_err());
        // `expect(1)` is verified on drop: a second attempt fails the test.
    }

    #[tokio::test]
    async fn fetch_stats_maps_the_aliased_counts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {
                    "merged_week": { "issueCount": 4 },
                    "merged_month": { "issueCount": 11 }
                }
            })))
            .mount(&server)
            .await;

        let stats = client_for(&server)
            .await
            .fetch_stats(Utc::now())
            .await
            .unwrap();
        assert_eq!(stats.merged_week, 4);
        assert_eq!(stats.merged_month, 11);
        assert_eq!(stats.in_merge_queue, 0);
    }

    #[tokio::test]
    async fn fetch_stats_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_stats(Utc::now())
            .await
            .is_err());
    }

    /// Rate-limit exhaustion is named, not left as a generic failure the
    /// user cannot tell from a network fault or a bad token.
    #[tokio::test]
    async fn rate_limit_errors_say_so() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{ "message": "API rate limit exceeded for user ID 1." }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(matches!(err, ClientError::RateLimited(_)), "got {err:?}");
        assert!(err.to_string().contains("resume automatically"));
    }

    /// A mutation that GitHub refuses must NOT report success.
    ///
    /// Deliberately unlike the read path, which keeps partial data: for
    /// a write, "partly merged" is not a state, and claiming success
    /// while GitHub complained is the worst outcome for an action the
    /// user cannot undo.
    #[tokio::test]
    async fn a_refused_mutation_is_an_error_with_github_s_own_words() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "mergePullRequest": null },
                "errors": [{ "message": "Base branch was modified. Review and try the merge again." }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Merge)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("Base branch was modified"),
            "GitHub's own message must survive: {err}"
        );
    }

    #[tokio::test]
    async fn a_clean_mutation_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "closePullRequest": { "clientMutationId": null } }
            })))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Close)
            .await
            .expect("a clean response is success");
    }

    /// A response with neither data nor errors means our request shape is
    /// wrong; reporting success would hide that.
    #[tokio::test]
    async fn an_empty_mutation_response_is_not_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .mutate_pr("PR_abc", crate::github::mutate::PrAction::Merge)
            .await
            .is_err());
    }

    /// `issueCount` is what makes truncation visible; it was requested by
    /// the query and read by nothing, so >100 open PRs silently became 100.
    #[tokio::test]
    async fn reports_the_true_total_when_the_page_truncates() {
        let server = MockServer::start().await;
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        // The fixture has 3 nodes; claim GitHub matched 137.
        let mut truncated = body.clone();
        truncated["authored"]["issueCount"] = json!(137);
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": truncated })))
            .mount(&server)
            .await;

        let (prs, total) = client_for(&server)
            .await
            .fetch_prs_with_total()
            .await
            .unwrap();
        // The mock answers EVERY page with the same 3 nodes, so the
        // merged list is a multiple of 3 rather than 3 -- that is an
        // artefact of the fixture, not of the code. What this test is
        // for is the TOTAL: `issueCount` must be reported as GitHub
        // stated it, however many nodes actually arrived, because that
        // difference is what the UI turns into "showing N of M".
        assert!(!prs.is_empty(), "the page that arrived is kept");
        assert_eq!(total, 137, "the UI needs the real total to say so");
        assert!(
            u64::from(prs.len() as u32) < total,
            "and a short list must stay visibly short"
        );
    }

    /// The bug this replaced: octocrab's `GraphqlResponse` is untagged
    /// with `Err` first, so a 200 carrying BOTH `data` and `errors`
    /// deserialized as an error and threw away every good node. GitHub
    /// sends exactly that when one repo's resolver fails.
    #[tokio::test]
    async fn a_partial_success_keeps_the_good_nodes() {
        let server = MockServer::start().await;
        // The same three-PR fixture the clean-success test uses; the only
        // difference is the `errors` array riding alongside it.
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/search.json")).unwrap();
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": body,
                "errors": [{
                    "type": "SERVICE_UNAVAILABLE",
                    "message": "Something went wrong while executing your query."
                }]
            })))
            .mount(&server)
            .await;

        let prs = client_for(&server).await.fetch_prs().await.unwrap();
        assert_eq!(prs.len(), 3, "a partial success must not blank the list");
        assert_eq!(prs[0].number, 42);
    }

    /// A page GitHub refused so heavily that NOTHING maps must not be
    /// cached as "you have no pull requests".
    ///
    /// Reported: the first load of To review showed a short list, and
    /// every return to it afterwards showed "No open pull requests"
    /// indefinitely. GitHub nulls the nodes whose fields it refused, the
    /// mapper drops what it cannot render, and an empty success is fresh
    /// for a minute -- so the view never refetched.
    ///
    /// An error is honest and, unlike an empty success, retries.
    #[tokio::test]
    async fn a_wholly_refused_page_is_an_error_not_an_empty_list() {
        let _guard = refused_fields_lock().await;
        REFUSED_FIELDS.store(0, std::sync::atomic::Ordering::Relaxed);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            // Nodes present but unrenderable, which is what a refusal
            // produces: the mapper drops every one.
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"nodes": [{"number": 1}, {"number": 2}]}},
                "errors": [{"type": "RESOURCE_LIMITS_EXCEEDED", "message": "refused"}]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server)
            .await
            .fetch_reviewing()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("refused"), "{err}");
    }

    /// A genuinely empty queue is still success. Turning "you have
    /// nothing to review" into an error would be its own wrong answer.
    #[tokio::test]
    async fn an_honestly_empty_queue_is_not_an_error() {
        let _guard = refused_fields_lock().await;
        REFUSED_FIELDS.store(0, std::sync::atomic::Ordering::Relaxed);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"nodes": []}}
            })))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_reviewing()
            .await
            .unwrap()
            .is_empty());
    }

    /// Partial data is KEPT, not escalated to an error.
    ///
    /// v3.2.5 turned RESOURCE_LIMITS_EXCEEDED into a hard failure so the
    /// user would stop seeing a silently-short list. It made things
    /// worse: a user who had been seeing a partial review queue started
    /// seeing nothing at all, with "could not return 86 of the fields
    /// requested" where the list used to be.
    ///
    /// It also broke the rule this function's own comment states -- one
    /// repository's failed resolver must not blank the whole list.
    ///
    /// The shortfall is still surfaced, via `REFUSED_FIELDS`, so it is
    /// visible without being fatal.
    #[tokio::test]
    async fn an_over_budget_response_keeps_the_data_it_got() {
        let _guard = refused_fields_lock().await;
        REFUSED_FIELDS.store(0, std::sync::atomic::Ordering::Relaxed);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"authored": {"nodes": [{
                    "number": 1, "title": "t", "url": "u",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "repository": {"nameWithOwner": "octocat/hello-world"}
                }]}},
                "errors": [
                    {"type": "RESOURCE_LIMITS_EXCEEDED", "message": "refused"},
                    {"type": "RESOURCE_LIMITS_EXCEEDED", "message": "refused"}
                ]
            })))
            .mount(&server)
            .await;

        let prs = client_for(&server)
            .await
            .fetch_prs()
            .await
            .expect("must not fail");
        assert_eq!(
            prs.len(),
            1,
            "the pull request GitHub DID return must survive"
        );
        assert_eq!(
            REFUSED_FIELDS.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "the shortfall must still be reported"
        );
    }

    /// A partial success keeps its data AND surfaces the errors.
    ///
    /// This is the FORBIDDEN / SAML-SSO shape: HTTP 200, `data` present,
    /// some nodes null, and an `errors` array. Keeping the data is
    /// correct; discarding the errors meant an org's pull requests went
    /// missing under a green "Up to date", with nothing in the log
    /// either -- the one failure that was completely invisible.
    #[tokio::test]
    async fn partial_success_keeps_data_and_does_not_hide_the_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "authored": { "nodes": [] } },
                "errors": [{
                    "type": "FORBIDDEN",
                    "message": "Resource not accessible by personal access token"
                }]
            })))
            .mount(&server)
            .await;

        let octo = octocrab::Octocrab::builder()
            .base_uri(server.uri())
            .unwrap()
            .build()
            .unwrap();

        let out = graphql_partial_ok(&octo, &serde_json::json!({"query": "{ x }"}))
            .await
            .expect("partial data must still be returned");
        assert!(out.get("authored").is_some(), "the usable data survives");
    }

    /// Errors are still fatal when nothing usable came back, and the
    /// message reaches the banner rather than being swallowed.
    #[tokio::test]
    async fn errors_without_data_are_still_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{ "message": "Could not resolve to a Repository" }]
            })))
            .mount(&server)
            .await;

        let err = client_for(&server).await.fetch_prs().await.unwrap_err();
        assert!(
            err.to_string()
                .contains("Could not resolve to a Repository"),
            "message must reach the user: {err}"
        );
    }

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
            .unwrap()
            .with_timezone(&Utc);
        let h = c.fetch_history(now, 2).await.unwrap();
        assert_eq!(h.points.len(), 2);
        assert_eq!(h.points[1].merged, 5);
        assert_eq!(h.week_current, 183);
        assert_eq!(h.week_previous, 110);
        assert_eq!(h.month_current, 571);
    }

    #[tokio::test]
    async fn fetch_history_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_history(Utc::now(), 7)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn fetch_merged_detail_maps_the_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "merged": {"nodes": [
                        {"createdAt":"2026-08-19T10:00:00Z","mergedAt":"2026-08-19T12:00:00Z",
                         "additions":100,"deletions":20,"changedFiles":3,
                         "reviews":{"totalCount":1},"comments":{"totalCount":2},
                         "repository":{"nameWithOwner":"acme/alpha"}}
                    ]}
                }
            })))
            .mount(&server)
            .await;

        let d = client_for(&server)
            .await
            .fetch_merged_detail()
            .await
            .unwrap();
        assert_eq!(d.sample_size, 1);
        assert_eq!(d.additions, 100);
        assert_eq!(d.cycle_time_hours, vec![2.0]);
    }

    #[tokio::test]
    async fn fetch_merged_detail_api_error_is_returned_not_panicked_on() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        assert!(client_for(&server)
            .await
            .fetch_merged_detail()
            .await
            .is_err());
    }

    // Exercises the real fetch path against the LIVE API, exactly as the
    // Tauri commands do. #[ignore]d so CI never depends on network or a
    // token; run manually with `cargo test --lib live_ -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_fetch_history_and_detail() {
        let out = std::process::Command::new("gh")
            .args(["auth", "token"])
            .output()
            .expect("gh auth token");
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let c = GitHubClient::new(crate::auth::build_client(&token).unwrap());

        let tp = std::time::Instant::now();
        let p = c.fetch_periods(Utc::now()).await.unwrap();
        println!(
            "TIMING fetch_periods = {:?} (week {}/{})",
            tp.elapsed(),
            p.week_current,
            p.week_previous
        );

        let t0 = std::time::Instant::now();
        // The detail view's payload, through the real client.
        if let Ok(d) = c.fetch_pr_detail("pktstorm/headstate", 165).await {
            println!(
                "DETAIL #{} \"{}\" checks={} comments={} body={}b status={:?}",
                d.number,
                &d.title[..d.title.len().min(30)],
                d.checks.len(),
                d.comments.len(),
                d.body.len(),
                d.merge_status
            );
            assert!(!d.title.is_empty(), "title must be populated");
            assert!(!d.checks.is_empty(), "checks must be populated");
        }

        let (authored, reviewing) = c.fetch_prs_and_reviewing().await.unwrap();
        println!("AUTHORED={} REVIEWING={}", authored.len(), reviewing.len());
        {
            use std::collections::BTreeMap;
            let mut by: BTreeMap<String, usize> = BTreeMap::new();
            for p in &authored {
                *by.entry(format!("{:?}", p.merge_status)).or_default() += 1;
            }
            println!("MERGE_STATUS {by:?}");
            assert!(
                authored
                    .iter()
                    .any(|p| p.merge_status != crate::github::model::MergeStateStatus::Unknown),
                "mergeStateStatus must be populated, not all Unknown"
            );
        }
        let stacked: Vec<_> = authored
            .iter()
            .filter(|p| p.base_ref != "main" && p.base_ref != "master")
            .collect();
        let no_ci = authored
            .iter()
            .filter(|p| p.ci == crate::github::model::CiState::None)
            .count();
        println!("STACKED={} NO_CI={}", stacked.len(), no_ci);
        if let Some(p) = stacked.first() {
            println!("  e.g. {} -> {}", p.head_ref, p.base_ref);
        }
        assert!(
            authored.iter().all(|p| !p.base_ref.is_empty()),
            "base_ref must be populated"
        );
        assert!(!authored.is_empty());

        let t = c.fetch_cycle_trend(Utc::now()).await.unwrap();
        println!(
            "CYCLE cur={:.2}h ({} merged) prev={:.2}h ({} merged) sampled={}",
            t.current_hours, t.current_count, t.previous_hours, t.previous_count, t.sampled
        );

        let h = c.fetch_history(Utc::now(), 30).await.unwrap();
        println!("TIMING fetch_history(30) = {:?}", t0.elapsed());
        println!(
            "POINTS={} WEEK={}/{} MONTH={}/{}",
            h.points.len(),
            h.week_current,
            h.week_previous,
            h.month_current,
            h.month_previous
        );
        assert_eq!(h.points.len(), 30);
        // Ascending by date: the chart plots time left to right.
        assert!(h.points.windows(2).all(|w| w[0].date <= w[1].date));

        let d = c.fetch_merged_detail().await.unwrap();
        println!(
            "SLOWEST={} LARGEST={} top_slow={:.1}h top_big={} lines",
            d.slowest.len(),
            d.largest.len(),
            d.slowest.first().map(|p| p.cycle_time_hours).unwrap_or(0.0),
            d.largest.first().map(|p| p.size).unwrap_or(0)
        );
        assert!(!d.slowest.is_empty(), "outliers must be populated");
        assert!(
            d.slowest.iter().all(|p| !p.url.is_empty()),
            "each needs a link"
        );
        println!(
            "SAMPLE={} LINES={} SIZES={} REPOS={} CYCLES={}",
            d.sample_size,
            d.additions + d.deletions,
            d.pr_sizes.len(),
            d.repo_counts.len(),
            d.cycle_time_hours.len()
        );
        assert!(d.sample_size > 0);
        // Both vectors must be sorted or percentile() silently lies.
        assert!(
            d.pr_sizes.windows(2).all(|w| w[0] <= w[1]),
            "pr_sizes unsorted"
        );
        assert!(
            d.cycle_time_hours.windows(2).all(|w| w[0] <= w[1]),
            "cycle times unsorted"
        );
        // Repo counts descend, so the table's first row is the busiest.
        assert!(d.repo_counts.windows(2).all(|w| w[0].merged >= w[1].merged));
    }
}
