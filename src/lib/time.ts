const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/// GitHub-style relative time, as shown in the PR metadata line.
/// The same phrasing as `relativeTime`, from an elapsed count rather
/// than a timestamp.
///
/// Artifact ages arrive as seconds-since-written, because the backend
/// computes them while walking the tree and a `SystemTime` does not
/// survive the IPC boundary as an instant. Sharing the wording matters:
/// "9 months ago" must mean the same thing on every page.
export function relativeSeconds(secs: number, now: Date = new Date()): string {
  return relativeTime(new Date(now.getTime() - secs * 1000).toISOString(), now);
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / DAY);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}
