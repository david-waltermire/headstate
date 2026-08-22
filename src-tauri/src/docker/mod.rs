//! Docker: images, builds, and reclaiming the disk they fill.

mod builds;
mod classify;
mod cli;
mod model;
mod origin;
mod parse;
mod reclaim;

pub use builds::{enrich, parse_history, Build};
pub use classify::{classify, remove_image, remove_images, RemovalOutcome};
pub use cli::{docker, find_docker, state};
pub use model::{DiskUsage, DockerState, Image, Origin, OriginSource};
pub use origin::{images_in_use, looks_like_sha, parse_build_inspect, resolve_in_repo};
pub use parse::{disk_usage, images};
pub use reclaim::{
    dangling_volumes, parse_reclaimed, prune_build_cache, remove_volume, restart_engine,
    running_containers, start_engine, DanglingVolume,
};
