//! Which dependencies are out of date, per repository.
//!
//! Reports only: nothing here writes to a manifest or a lockfile. The
//! output is a list and a markdown rendering of it, meant to be handed
//! to an agent that does the work.
//!
//! Nothing here talks to GitHub.

pub mod apply;
pub mod detect;
pub mod markdown;
pub mod model;
pub mod run;
pub mod tools;
pub mod version;

pub use model::{Bump, Ecosystem, EcosystemReport, Outdated, ProjectReport};
