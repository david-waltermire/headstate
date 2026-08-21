import type { Safety } from "@/types/pr";

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
    default:
      return `could not determine: ${s.detail}`;
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
