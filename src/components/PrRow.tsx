import { ExternalLink } from "./ExternalLink";
import {
  Check,
  CircleDot,
  CircleSlash,
  GitPullRequest,
  MessageCircleWarning,
  MessageSquare,
  X,
} from "lucide-react";
import type { PullRequest } from "@/types/pr";
import { labelForeground } from "@/lib/labels";
import { PrKebab } from "@/components/PrKebab";
import { prKey } from "@/components/BulkBar";
import { useFilters } from "@/store/filters";
import { needsAttention } from "@/lib/derive";
import { relativeTime } from "@/lib/time";

/// A check for green, an X for red, and an amber dot while CI is running.
///
/// `none` stays blank, matching GitHub -- there is no glyph for "this repo
/// has no CI". `pending` is NOT blank, though: GitHub does show a running
/// indicator, and collapsing it to nothing made "tests are running right
/// now" byte-identical to "no CI configured". The app already knew the
/// difference and the nudge text already said so, which made the copied
/// Slack message strictly more informative than the UI that produced it.
function CiGlyph({ pr }: { pr: PullRequest }) {
  if (pr.ci === "success") {
    return <Check className="h-4 w-4 shrink-0 text-[#3fb950]" aria-label="CI passing" />;
  }
  if (pr.ci === "failure") {
    return <X className="h-4 w-4 shrink-0 text-[#f85149]" aria-label="CI failing" />;
  }
  if (pr.ci === "pending") {
    return (
      <CircleDot className="h-4 w-4 shrink-0 text-[#d29922]" aria-label="CI running" />
    );
  }
  // `none` means the rollup came back null: no checks ran for this PR at
  // all. That is NORMAL for a PR stacked on another branch -- most repos
  // only run CI against the default branch -- so it is drawn muted, not
  // as a warning. Rendering nothing made "no CI configured" identical to
  // "checks have not reported yet", which is the same ambiguity #93 fixed
  // for `pending`.
  return (
    <CircleSlash className="h-4 w-4 shrink-0 text-[#6e7681]" aria-label="No CI ran" />
  );
}

/// `head → base` for every PR.
///
/// Always the full pair, so the row reads the same way whatever it
/// targets. A PR whose base is NOT the default branch is stacked on
/// another PR -- it cannot merge until its base does -- so the target is
/// tinted to make that visible without changing the layout.
///
/// GitHub itself puts this in the PR header rather than the list row, so
/// it stays on the muted metadata line rather than becoming a chip.
function BranchPair({ pr }: { pr: PullRequest }) {
  if (!pr.head_ref || !pr.base_ref) return null;
  const stacked = pr.base_ref !== "main" && pr.base_ref !== "master";
  return (
    <span className="ml-2" title={`Merges ${pr.head_ref} into ${pr.base_ref}`}>
      • <span className="font-mono">{pr.head_ref}</span>
      <span className="mx-1">→</span>
      <span className={`font-mono ${stacked ? "text-[#a371f7]" : ""}`}>{pr.base_ref}</span>
    </span>
  );
}

/// Review outcome, when GitHub has one.
///
/// `review_required` deliberately renders nothing: GitHub shows no neutral
/// glyph for "awaiting review" either, and a row where every PR carries a
/// marker teaches the reader to ignore all of them. Only a decision --
/// approved, or changes requested -- earns a chip.
function ReviewGlyph({ pr }: { pr: PullRequest }) {
  if (pr.review === "approved") {
    return (
      <span
        className="rounded-full border border-[#3fb950]/40 px-1.5 py-0.5 text-xs text-[#3fb950]"
        title="Approved"
      >
        Approved
      </span>
    );
  }
  if (pr.review === "changes_requested") {
    return (
      <span
        className="rounded-full border border-[#d29922]/40 px-1.5 py-0.5 text-xs text-[#d29922]"
        title="Changes requested"
      >
        Changes requested
      </span>
    );
  }
  return null;
}

/// The PR glyph's colour and label.
///
/// It was unconditionally green, so a draft, a queued PR and a blocked one
/// all looked identical -- the icon carried no information at all.
///
/// Precedence is most-blocking first, and the order is the real decision:
/// a draft WITH merge conflicts should read as blocked, not as a benign
/// draft. "Blocked" deliberately means what `needsAttention` already means
/// (conflicts or failing CI), so the icon agrees with the priorities strip
/// and the tray badge rather than inventing a fourth definition of broken.
///
/// The label is rendered as a VISIBLE chip as well as an `aria-label`.
/// It used to be aria-only, which is not visible text and is not a
/// tooltip -- so for a sighted user colour was the sole carrier, and
/// "Blocked on review" and "Behind base branch" are the same hue
/// (#d29922) and were therefore indistinguishable.
///
/// `chip` is false for the ordinary Open state: a marker on every row
/// would be noise and would defeat its own purpose, the same reasoning
/// `ReviewGlyph` already applies to itself.
function prState(pr: PullRequest): { className: string; label: string; chip: boolean } {
  if (needsAttention(pr)) {
    return { className: "text-[#f85149]", label: "Blocked", chip: true };
  }
  if (pr.in_merge_queue) {
    return { className: "text-[#db6d28]", label: "In merge queue", chip: true };
  }
  if (pr.is_draft) {
    return { className: "text-[#8b949e]", label: "Draft", chip: true };
  }
  // GitHub's own verdict, which `needsAttention` cannot express: a PR
  // waiting on a required review is neither broken nor ready, and a PR
  // whose base has moved needs an update rather than a fix. Both look
  // identical to the conflicts-or-red-CI rule above.
  if (pr.merge_status === "blocked") {
    return { className: "text-[#d29922]", label: "Blocked on review", chip: true };
  }
  if (pr.merge_status === "behind") {
    return { className: "text-[#d29922]", label: "Behind base branch", chip: true };
  }
  return { className: "text-[#3fb950]", label: "Open", chip: false };
}

/// How many labels a dense row shows before collapsing to "+N".
///
/// Labels render unbounded otherwise, so a PR with six of them wraps the
/// flex line and pushes CI and review state off the row -- spending the
/// exact density this mode reclaims.
const DENSE_LABELS = 2;

export function PrRow({
  pr,
  onOpen,
  canWrite = true,
  onRange,
  cursored = false,
  selectable = false,
}: {
  pr: PullRequest;
  onOpen?: () => void;
  /// False on the review view: merging or closing someone else's pull
  /// request is usually not yours to do.
  canWrite?: boolean;
  /// Select every row between two keys. Supplied by the list, which is
  /// the only thing that knows the ORDER rows are rendered in -- a row
  /// cannot compute a range it is only one element of.
  onRange?: (from: string, to: string) => void;
  /// Whether the keyboard cursor is on this row.
  cursored?: boolean;
  /// Show the bulk-selection checkbox. Off on the review view for the
  /// same reason `canWrite` is: every bulk action is a write.
  selectable?: boolean;
}) {
  const state = prState(pr);
  const { checked, toggleChecked, anchor, setAnchor, density } = useFilters();
  const dense = density === "dense";
  const key = prKey(pr);
  return (
    // The row opens the detail view; the title anchor still opens GitHub,
    // and stops propagation so a deliberate click on it is not hijacked.
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex gap-3 border-b border-[#30363d] px-4 ${
        dense ? "py-1.5" : "py-3"
      } last:border-b-0 hover:bg-[#161b22] ${
        // A ring rather than a background: the row already uses
        // background for hover, and a cursor that looked like a hover
        // would be indistinguishable from the mouse being somewhere.
        cursored ? "ring-2 ring-inset ring-[#1f6feb]" : ""
      } ${
        onOpen ? "cursor-pointer" : ""
      }`}
    >
      {selectable ? (
        // Its own click target, stopping propagation so checking a row
        // does not also open it.
        <label
          className="flex items-start pt-0.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span className="sr-only">Select #{pr.number}</span>
          <input
            type="checkbox"
            checked={checked.includes(key)}
            // One handler, not an onClick/onChange pair. A pair fires
            // BOTH for a mouse click, so a shift-click computed the
            // range and then the change handler re-added just the
            // endpoint on top of it.
            //
            // `shiftKey` is read off the NATIVE event: React's
            // ChangeEvent does not carry modifier keys, which is why the
            // original `onChange={() => toggle(key)}` could not support
            // ranges at all.
            onChange={(e) => {
              const shift = (e.nativeEvent as MouseEvent).shiftKey === true;
              if (shift && anchor && onRange) {
                onRange(anchor, key);
              } else {
                toggleChecked(key);
                setAnchor(key);
              }
            }}
            className="h-4 w-4 cursor-pointer accent-[#1f6feb]"
          />
        </label>
      ) : null}
      <GitPullRequest
        className={`mt-0.5 h-4 w-4 shrink-0 ${state.className}`}
        aria-label={state.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* The title opens the DETAIL VIEW, not github.com.
              
              It used to be an `<ExternalLink >` that stopped
              propagation, so clicking the most obvious target in the row
              launched a browser tab and never reached `onOpen`. That
              read as a To review bug because `canWrite` is false there,
              leaving the title as the only thing that looks interactive
              -- but it behaved the same way on every view.
              
              "View on GitHub" already exists in the kebab menu and in
              the detail view itself, so nothing is lost. When there is
              no detail view to open, the title stays a link rather than
              becoming inert. */}
          {onOpen ? (
            <span className="font-semibold text-[#e6edf3]">{pr.title}</span>
          ) : (
            <ExternalLink
              href={pr.url}
              className="font-semibold text-[#e6edf3] hover:text-[#4493f8]"
            >
              {pr.title}
            </ExternalLink>
          )}
          {/* The number moves up in dense mode: it lives on the prose
              line otherwise, and that line is gone here. Without it a
              dense row cannot be referred to -- "#42" is how a pull
              request is named everywhere else in the app. */}
          {dense ? <span className="shrink-0 text-xs text-[#8b949e]">#{pr.number}</span> : null}
          {/* Visible text, not only an aria-label. The icon's colour
              alone made "Blocked on review" and "Behind base branch"
              identical, since both are #d29922. */}
          {state.chip ? (
            <span
              className={`shrink-0 rounded-full border border-current px-2 py-0.5 text-xs font-medium ${state.className}`}
            >
              {state.label}
            </span>
          ) : null}
          <CiGlyph pr={pr} />
          <ReviewGlyph pr={pr} />
          {(dense ? pr.labels.slice(0, DENSE_LABELS) : pr.labels).map((label) => (
            <span
              key={label.name}
              className="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: `#${label.color}`,
                color: labelForeground(label.color),
              }}
            >
              {label.name}
            </span>
          ))}
          {dense && pr.labels.length > DENSE_LABELS ? (
            // The count is not decoration: without it a capped list
            // looks like the whole list, and a label the user filters on
            // would appear simply absent.
            <span className="text-xs text-[#8b949e]">+{pr.labels.length - DENSE_LABELS}</span>
          ) : null}
        </div>
        {/* Dense drops the PROSE line only. Every decisive signal --
            CI, review verdict, state colour, title, number -- lives on
            the line above and is untouched; this line largely repeats
            them in words. */}
        {dense ? null : (
        <div className="mt-1 text-xs text-[#8b949e]">
          {/* `updated_at` is what the app SORTS and reasons about (stale
              detection, "least recently updated"), so a row showing only
              the creation date could not explain its own position in the
              list: two PRs both "opened 2 months ago", one touched an hour
              ago and one dead six weeks. */}
          #{pr.number} opened {relativeTime(pr.created_at)} by {pr.author} · updated{" "}
          {relativeTime(pr.updated_at)}
          {/* Kept, and NOT redundant with the state chip. `prState`
              returns exactly one state, so a draft whose CI is also red
              reports as "Blocked" -- dropping these lost the fact that
              it is a draft at all. The chip says what most needs acting
              on; these say what else is true. Only shown when the chip
              is not already saying the same word. */}
          {pr.is_draft && state.label !== "Draft" && (
            <span className="ml-2 rounded border border-[#30363d] px-1.5">Draft</span>
          )}
          {pr.in_merge_queue && state.label !== "In merge queue" && (
            <span className="ml-2 text-[#a371f7]">• In merge queue</span>
          )}
          {pr.merge === "conflicted" && (
            <span className="ml-2 text-[#f85149]">• Conflicts</span>
          )}
          {pr.merge === "checking" && <span className="ml-2">• Checking mergeability</span>}
          <BranchPair pr={pr} />
          {/* Open review conversations on the current code. Deliberately
              worded as a count, not "blocked": whether a repo requires
              resolution before merging needs admin access on that repo,
              so the row reports what it knows and lets the reader draw
              the conclusion. Amber, not red -- unanswered questions are
              not a failure. */}
          {pr.unresolved_threads > 0 && (
            <span
              className="ml-2 inline-flex items-center gap-1 text-[#d29922]"
              title={`${pr.unresolved_threads} review conversation${
                pr.unresolved_threads === 1 ? "" : "s"
              } not yet resolved`}
            >
              <MessageCircleWarning className="h-3 w-3" aria-hidden="true" />
              {pr.unresolved_threads} unresolved
            </span>
          )}
          {pr.comment_count > 0 && (
            <span className="ml-2 inline-flex items-center gap-1">
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {pr.comment_count}
            </span>
          )}
        </div>
        )}
      </div>
      <div className="shrink-0 text-xs text-[#8b949e]">{pr.repo}</div>
      <PrKebab pr={pr} canWrite={canWrite} />
    </div>
  );
}
