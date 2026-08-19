//! The PR model. Field names, enum variants, and serde casing here are
//! consumed by later tasks (the Tauri command layer, the store) and are
//! mirrored into TypeScript in a later milestone, so they are chosen to be
//! stable and are not to be changed casually.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiState {
    Success,
    Failure,
    Pending,
    None,
}

/// Three states, not two. `Checking` exists because GitHub computes
/// mergeability lazily and reports UNKNOWN until it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeState {
    Mergeable,
    Conflicted,
    Checking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub name: String,
    pub color: String,
}

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
