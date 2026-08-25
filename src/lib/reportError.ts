import { getVersion } from "@tauri-apps/api/app";
import { buildTarget } from "../api/tauri";
import { buildReport, issueUrl } from "./report";

/// The prefilled issue URL for an error the user just saw.
///
/// Gathers what a maintainer needs and the user cannot easily find:
/// both recent diagnoses in this area turned on the platform and the
/// build kind, neither of which appears in the error text.
///
/// Every lookup is best-effort. A missing version is worth far less than
/// a report that never opens, so an unknown field says so rather than
/// aborting.
///
/// Returns a URL rather than opening one: the caller renders it as an
/// `ExternalLink`, which is how every external link in the app reaches
/// the browser.
export async function reportUrl(error: string): Promise<string> {
  const [version, target] = await Promise.all([
    settled(getVersion(), "unknown"),
    settled(buildTarget(), ["unknown", "unknown"] as [string, string]),
  ]);
  const [platform, arch] = target;
  return issueUrl(buildReport({ version, platform, arch, error }));
}

/// A report with just the error, for the instant the banner appears.
///
/// The environment lookups are asynchronous; this is what the link
/// carries until they answer, so it is never absent.
export function errorOnlyReport(error: string): string {
  return buildReport({
    version: "unknown",
    platform: "unknown",
    arch: "unknown",
    error,
  });
}

/// A promise's value, a fallback if it rejects, and a fallback if it
/// never settles at all.
///
/// `.catch` covers rejection but NOT a hang, and an IPC call that never
/// answers left `reportUrl` pending forever -- so the link, which only
/// renders once the URL resolves, never appeared. That is what "Report
/// this does nothing" looked like: not a dead click, an absent element.
///
/// Two seconds: these are local lookups, not network calls. If they have
/// not answered by then they are not going to, and a report naming an
/// unknown platform is worth far more than no report.
function settled<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 2000)),
  ]);
}
