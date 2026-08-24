import { useEffect, useState } from "react";
import { reportUrl } from "../lib/reportError";

/// "Report this" on an error banner.
///
/// An anchor, not a button that opens something: the app reaches the
/// browser through `target="_blank"` everywhere else, and the URL is a
/// prefilled FORM rather than a submission -- the user is the only one
/// who can confirm nothing sensitive survived scrubbing, and filing
/// publicly on someone's behalf without showing them is not something an
/// app should do.
///
/// The URL is built asynchronously (version and platform come from the
/// backend), so the link only appears once it is ready. A brief absence
/// beats a link that does nothing when clicked.
export function ReportLink({ error }: { error: string }) {
  const [url, setUrl] = useState<string | null>(null);

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

  if (url === null) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="ml-2 underline hover:no-underline"
    >
      Report this
    </a>
  );
}
