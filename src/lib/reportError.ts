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
  const version = await getVersion().catch(() => "unknown");
  const [platform, arch] = await buildTarget().catch(() => ["unknown", "unknown"]);
  return issueUrl(buildReport({ version, platform, arch, error }));
}
