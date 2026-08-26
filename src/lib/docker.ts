import type { DockerImage } from "@/types/pr";

/// Bytes as Docker itself would print them.
///
/// SI units (powers of 1000), NOT the binary units `formatSize` uses for
/// worktree disk sizes. Docker reports `4.654GB` for 4,654,000,000 bytes;
/// rendering that as "4.3 GB" would look like a bug to anyone comparing
/// the page against `docker system df`.
///
/// `null` renders as an em dash rather than "0 B", which would claim a
/// measurement that has not happened.
export function formatDockerSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(2) : Math.round(n)} ${units[i]}`;
}

/// Whether an image is safe to remove without asking anything else.
///
/// Superseded AND merged AND unused -- deliberately narrower than
/// "superseded". An image on a live branch may still be wanted, and only
/// the provably-dead set should enter a bulk path. Unknown provenance is
/// not stale either: we cannot prove the branch landed.
///
/// Mirrors `Image::is_stale` on the Rust side, duplicated rather than
/// sent over the wire for the same reason `safetyReason` is: the wire
/// carries data, the UI decides what to say about it.
export function isStale(img: DockerImage): boolean {
  // Only a KNOWN-unused image. `null` -- we could not ask -- stays out
  // of the bulk set, the same rule the Rust side applies.
  return img.superseded && img.in_use === false && img.origin?.merged === true;
}

/// Every superseded image we can prove is unused.
///
/// WIDER than `isStale`, and deliberately a separate predicate rather
/// than a loosening of it. `isStale` additionally requires that we
/// attributed the image to a branch AND that the branch merged, which
/// on a real machine excludes most of what accumulates: images nothing
/// could attribute, and images whose branch is still open.
///
/// The two answer different questions. `isStale` is "provably dead,
/// safe by default". This is "superseded, and you should look at the
/// list before confirming" -- which is why its confirmation dialog has
/// to say plainly that some of these belong to open branches.
///
/// `in_use === null` is excluded from both. That means "we could not
/// ask", and treating an unknown as unused is how a bulk delete takes
/// out something a container is running.
export function isSuperseded(img: DockerImage): boolean {
  return img.superseded && img.in_use === false;
}

/// What the row says about an image's standing.
export function imageState(img: DockerImage): string {
  if (img.in_use === true) return "in use by a running container";
  if (img.in_use === null) return "cannot tell if it is in use";
  if (!img.superseded) return "current";
  if (img.origin?.merged) return "superseded — branch merged";
  if (img.origin) return "superseded — branch still open";
  return "superseded";
}

/// Tailwind colour for that standing.
///
/// Green for current, grey for in-use (not a problem, just not
/// removable), amber for superseded-but-live, red for provably dead --
/// the thing the user came to delete.
export function imageTone(img: DockerImage): string {
  if (img.in_use !== false) return "text-[#8b949e]";
  if (!img.superseded) return "text-[#3fb950]";
  if (img.origin?.merged) return "text-[#f85149]";
  return "text-[#d29922]";
}
