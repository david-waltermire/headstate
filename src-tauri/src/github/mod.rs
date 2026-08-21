//! GitHub data layer: the PR model, the GraphQL query documents, and the
//! mapping from raw GraphQL JSON to typed Rust.

pub mod client;
pub mod map;
pub mod model;
pub mod mutate;
pub mod query;
