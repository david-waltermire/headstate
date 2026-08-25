import { ExternalLink } from "./ExternalLink";
import { useEffect, useState } from "react";
import { errorOnlyReport, reportUrl } from "../lib/reportError";
import { issueUrl } from "../lib/report";

/// "Report this" on an error banner.
///
/// An anchor, not a button that opens something: the app reaches the
/// browser through `ExternalLink` everywhere else, and the URL is a
/// prefilled FORM rather than a submission -- the user is the only one
/// who can confirm nothing sensitive survived scrubbing, and filing
/// publicly on someone's behalf without showing them is not something an
/// app should do.
///
/// The URL is built asynchronously (version and platform come from the
/// backend), but the link renders IMMEDIATELY with a URL that carries
/// only the error. It used to render nothing until the lookups
/// resolved, so an IPC call that never answered left the link
/// permanently absent -- which is what "Report this does nothing"
/// actually was: not a dead click, a missing element.
///
/// The richer URL replaces it once the environment is known. Worst case
/// the user files a report without the platform line, which is far
/// better than not being able to file one.
export function ReportLink({ error }: { error: string }) {
  // Seeded, not null: there is always something to file.
  const [url, setUrl] = useState<string>(() => issueUrl(errorOnlyReport(error)));

  useEffect(() => {
    let live = true;
    reportUrl(error).then(
      (u) => live && setUrl(u),
      // Non-fatal: the banner still says what went wrong.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [error]);

  return (
    <ExternalLink
      href={url}
      className="ml-2 underline hover:no-underline"
    >
      Report this
    </ExternalLink>
  );
}
