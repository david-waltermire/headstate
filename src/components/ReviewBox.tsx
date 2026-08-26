import { useState } from "react";
import type { ReviewVerdictName } from "../api/tauri";

/// Approve, request changes, or comment on a pull request.
///
/// The to-review queue was read-only by construction, so the single most
/// common action a reviewer takes -- approving -- meant leaving the app.
/// This is the first write Headstate makes to a pull request the user
/// does NOT own.
///
/// Presentational: the caller owns the mutation, so this component can be
/// tested without a Tauri IPC mock and the detail view keeps one place
/// where writes happen.
export function ReviewBox({
  onSubmit,
  busy,
  viewer,
  author,
  latestReviews,
}: {
  onSubmit: (verdict: ReviewVerdictName, body: string) => void;
  /// Which verdict is in flight, or null. All three disable together:
  /// they are alternatives, not a queue.
  busy: ReviewVerdictName | null;
  /// The authenticated login, or undefined if it could not be fetched.
  viewer: string | undefined;
  author: string;
  /// Every reviewer's latest verdict, used to find the viewer's own.
  latestReviews?: { author: string; state: string }[];
}) {
  const [body, setBody] = useState("");

  // What the VIEWER already decided, which is why the button can say
  // "Approved" rather than resetting to "Approve" and leaving the user
  // unable to tell whether their click did anything.
  //
  // Note DISMISSED is deliberately not treated as an approval: GitHub
  // dismisses a review when the branch changes under it, and showing
  // "Approved" then would state something false about the current code.
  const mine =
    viewer === undefined
      ? undefined
      : latestReviews?.find((r) => r.author === viewer)?.state;
  const alreadyApproved = mine === "APPROVED";

  // GitHub refuses self-approval outright, so offering the button and
  // surfacing a GraphQL refusal after the click is strictly worse than
  // saying so up front.
  //
  // Note the direction of the unknown case: `viewer` undefined means the
  // login could not be fetched, and "we could not ask" is not "it is
  // yours". Hiding approve on an unknown viewer would silently remove the
  // main action of this component; leaving it lets GitHub have the final
  // word, which it does anyway.
  const isOwn = viewer !== undefined && viewer === author;

  // GitHub rejects REQUEST_CHANGES and COMMENT without body text. Checked
  // here so the user sees a disabled button rather than a refusal after a
  // round-trip.
  const hasBody = body.trim().length > 0;

  const verdicts: { name: ReviewVerdictName; label: string; enabled: boolean }[] = [
    // Approving twice is not an error on GitHub's side, but offering it
    // as though nothing had happened is the reported confusion. Once
    // the viewer's approval is on record the button states it.
    {
      name: "approve",
      label: alreadyApproved ? "Approved" : "Approve",
      enabled: !alreadyApproved,
    },
    { name: "request_changes", label: "Request changes", enabled: hasBody },
    { name: "comment", label: "Comment", enabled: hasBody },
  ];

  return (
    <div className="rounded-md border border-[#30363d] p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          isOwn
            ? "Comment on your pull request…"
            : "Leave a comment (required to request changes)…"
        }
        rows={3}
        className="w-full resize-y rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm text-[#e6edf3] placeholder:text-[#8b949e]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {verdicts
          .filter((v) => !(isOwn && v.name === "approve"))
          .map((v) => (
            <button
              key={v.name}
              type="button"
              disabled={!v.enabled || busy !== null}
              onClick={() => onSubmit(v.name, body)}
              className={`rounded px-3 py-1.5 text-sm ${
                v.name === "approve"
                  ? "bg-[#238636] font-medium text-white hover:bg-[#2ea043] disabled:opacity-50"
                  : "border border-[#30363d] text-[#e6edf3] hover:bg-[#161b22] disabled:opacity-50"
              }`}
            >
              {busy === v.name ? "Working…" : v.label}
            </button>
          ))}
        {isOwn ? (
          <span className="text-xs text-[#8b949e]">
            GitHub does not allow approving your own pull request.
          </span>
        ) : null}
        {/* The other half of "did my click work": a verdict that is not
            an approval still deserves saying out loud, since the button
            row alone cannot express it. */}
        {mine === "CHANGES_REQUESTED" ? (
          <span className="text-xs text-[#d29922]">You requested changes.</span>
        ) : mine === "DISMISSED" ? (
          <span className="text-xs text-[#8b949e]">
            Your review was dismissed — the branch changed since you left it.
          </span>
        ) : null}
      </div>
    </div>
  );
}
