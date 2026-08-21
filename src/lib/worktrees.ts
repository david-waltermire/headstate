import type { Safety, Upstream } from "@/types/pr";

/// Only `safe` may be deleted.
///
/// Everything else is genuinely disabled rather than warned past: a
/// cleanup tool that occasionally eats a day of work is worse than no
/// cleanup tool.
export function isSafe(s: Safety): boolean {
  return s.kind === "safe";
}

/// Display-ready prose for a row.
///
/// Mirrors `Safety::reason` on the Rust side. Deliberately duplicated
/// rather than sent over the wire: the wire type is data, and prose in a
/// payload is harder to change than prose in a component.
export function safetyReason(s: Safety): string {
  switch (s.kind) {
    case "safe":
      return "merged, pushed — safe to delete";
    case "main_checkout":
      return "the repository's main checkout";
    case "dirty":
      return `${s.detail} uncommitted file${s.detail === 1 ? "" : "s"}`;
    case "unpushed":
      return `${s.detail} unpushed commit${s.detail === 1 ? "" : "s"}`;
    case "never_pushed":
      return "never pushed — commits exist only here";
    case "unmerged":
      return "branch not merged";
    case "pending":
      return "checking…";
    default:
      return `could not determine: ${s.detail}`;
  }
}

/// The final component of a path, whichever separator it uses.
///
/// `split("/")` returns the whole string unchanged on a Windows path, so
/// every row would show `C:\Users\me\code\proj-feature` instead of
/// `proj-feature`. Splitting on both separators is enough here: a
/// directory name cannot itself contain either one.
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/// Whether a row is still waiting on its safety check.
///
/// The fast listing lands in ~2.6s and classification takes up to ~57s,
/// so this is most of the first minute on a large tree -- long enough
/// that the row must say "still working" rather than show a value that
/// reads as final.
export function isPending(s: Safety): boolean {
  return s.kind === "pending";
}

/// Display-ready prose for a checkout's upstream state.
///
/// Mirrors `Upstream::reason` on the Rust side, for the same reason
/// `safetyReason` does.
///
/// Says "as of last fetch" on the states where staleness changes the
/// meaning: "behind 40" invites a pull, and the user should know the
/// number could itself be stale. "Up to date" carries the same caveat
/// and is the one most likely to mislead.
export function upstreamReason(u: Upstream): string {
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  switch (u.kind) {
    case "current":
      return "up to date with upstream (as of last fetch)";
    case "ahead":
      return `${commits(u.n)} ahead of upstream`;
    case "behind":
      return `${commits(u.n)} behind upstream (as of last fetch)`;
    case "diverged":
      return `diverged — ${commits(u.n[0])} ahead, ${commits(u.n[1])} behind`;
    case "untracked":
      return "no upstream — local only";
    case "detached":
      return "detached HEAD";
    default:
      return `upstream unknown: ${u.n}`;
  }
}

/// Tailwind colour for an upstream state.
///
/// Green only for genuinely current. Amber where action might be wanted,
/// grey where the question simply does not apply -- a local-only repo is
/// not a problem, it is a choice.
export function upstreamTone(u: Upstream): string {
  switch (u.kind) {
    case "current":
      return "text-[#3fb950]";
    case "behind":
    case "diverged":
      return "text-[#d29922]";
    default:
      return "text-[#8b949e]";
  }
}

/// Tailwind colour for a safety state.
///
/// Green ONLY for safe. Amber for states that hold work you might still
/// want; grey for the main checkout, which is not a problem at all.
export function safetyTone(s: Safety): string {
  switch (s.kind) {
    case "safe":
      return "text-[#3fb950]";
    case "main_checkout":
      return "text-[#8b949e]";
    case "pending":
      return "text-[#8b949e]";
    case "never_pushed":
      return "text-[#f85149]";
    case "dirty":
    case "unpushed":
      return "text-[#d29922]";
    default:
      return "text-[#8b949e]";
  }
}

/// Bytes as a short human string. `null` renders as an em dash rather
/// than "0 B", which would claim a measurement that has not happened.
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
