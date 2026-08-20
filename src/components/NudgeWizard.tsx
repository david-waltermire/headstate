import { useState } from "react";
import type { PullRequest } from "@/types/pr";
import { applyFilters, type Filters } from "@/lib/derive";
import { formatNudge, GROUP_THRESHOLD, type NudgeOptions } from "@/lib/nudge";
import { repoCounts } from "@/lib/repos";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STEP_COUNT = 3;

/// The wizard's own selection knobs, kept separate from `Filters["repo"]`
/// (which only ever holds one repo) because the repo step here is a
/// multi-select checklist -- "none checked" means "all repos", matching
/// `RepoSidebar`'s existing convention of no filter meaning no restriction.
interface RepoSelection {
  repos: string[];
}

/// Composes the exact text a user pastes into Slack or a team channel, so
/// this is the single highest-stakes divergence risk in the app (see M4's
/// dashboard-count-vs-list Critical, referenced throughout `derive.ts` and
/// `nudge.ts`). To avoid repeating that shape here, this component:
///   1. Never filters PRs with its own predicate -- it always calls
///      `applyFilters` (Task 13) for selection.
///   2. Never builds the output string itself -- it always calls
///      `formatNudge` (Task 19) for text.
/// Selection and preview are therefore two views of the *same* computed
/// `matched` array below, not two independently maintained ones.
///
/// v1 is read-only by design: this component makes no `invoke` call and no
/// network request. It only ever composes a string and hands it to
/// `navigator.clipboard`. "Nudge" means "compose text to paste," never
/// "post a comment" or "request a review via the API."
export function NudgeWizard({ prs }: { prs: PullRequest[] }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [selection, setSelection] = useState<RepoSelection>({ repos: [] });
  const [filters, setFilters] = useState<Filters>({ readyOnly: true });
  const [opts, setOpts] = useState<NudgeOptions>({ annotate: true });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const scoped = prs.filter(
    (pr) => selection.repos.length === 0 || selection.repos.includes(pr.repo),
  );
  const matched = applyFilters(scoped, filters);

  // Grouping helps once there are enough repos in the result for a flat
  // list to get noisy, and adds noise below that -- so it follows the
  // matched repo count unless the user has explicitly overridden it. This
  // mirrors `formatNudge`'s own auto-enable rule (`GROUP_THRESHOLD`), and
  // is only recomputed here so the "Group by repo" checkbox can show the
  // right state before the user has touched it.
  const distinctRepos = new Set(matched.map((pr) => pr.repo)).size;
  const grouped = opts.grouped ?? distinctRepos >= GROUP_THRESHOLD;
  const text = formatNudge(matched, opts);

  const reset = () => {
    setStep(0);
    setSelection({ repos: [] });
    setFilters({ readyOnly: true });
    setOpts({ annotate: true });
    setCopied(false);
    setCopyFailed(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const toggleRepo = (repo: string, checked: boolean) => {
    setSelection((prev) => ({
      repos: checked ? [...prev.repos, repo] : prev.repos.filter((r) => r !== repo),
    }));
  };

  /// Only claim success once the clipboard actually accepted the text.
  /// `writeText` rejects on a denied permission or an insecure context, and
  /// a discarded promise would leave the button saying "Copied!" over a
  /// clipboard that still holds whatever was there before -- the user pastes
  /// the wrong thing into a team channel and has no reason to suspect it.
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setCopyFailed(false);
      },
      () => {
        setCopyFailed(true);
        setCopied(false);
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm">Request reviews</Button>
        }
      />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request reviews</DialogTitle>
        </DialogHeader>

        {step === 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-[#e6edf3]">Which repositories?</p>
            <p className="text-xs text-[#8b949e]">Select none to include them all.</p>
            <div className="max-h-64 space-y-1 overflow-auto">
              {repoCounts(prs).map(({ repo, count }) => (
                <label key={repo} className="flex items-center gap-2 text-sm text-[#e6edf3]">
                  <Checkbox
                    checked={selection.repos.includes(repo)}
                    onCheckedChange={(checked) => toggleRepo(repo, checked)}
                  />
                  {repo} <span className="text-[#8b949e]">({count})</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3 text-sm text-[#e6edf3]">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={filters.readyOnly ?? false}
                onCheckedChange={(checked) => setFilters({ ...filters, readyOnly: checked })}
              />
              Ready for review only (exclude drafts)
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={filters.ci === "success"}
                onCheckedChange={(checked) =>
                  setFilters({ ...filters, ci: checked ? "success" : undefined })
                }
              />
              Only PRs with green CI
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={filters.needsAttentionOnly ?? false}
                onCheckedChange={(checked) =>
                  setFilters({ ...filters, needsAttentionOnly: checked })
                }
              />
              Only PRs that are broken or need a rebase
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={filters.staleOnly ?? false}
                onCheckedChange={(checked) => setFilters({ ...filters, staleOnly: checked })}
              />
              Only stale PRs (approved and untouched for 3+ days)
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-4 text-sm text-[#e6edf3]">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={opts.annotate ?? false}
                  onCheckedChange={(checked) => setOpts({ ...opts, annotate: checked })}
                />
                Annotate status
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={grouped}
                  onCheckedChange={(checked) => setOpts({ ...opts, grouped: checked })}
                />
                Group by repo
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={opts.slack ?? false}
                  onCheckedChange={(checked) => setOpts({ ...opts, slack: checked })}
                />
                Slack format
              </label>
            </div>
            {/* This textarea is the literal string `navigator.clipboard`
                receives on Copy -- not a description of it. Format toggles
                above recompute `text` from the same `matched`/`opts` on
                every render, so what's on screen here is always what Copy
                sends, never a stale snapshot. */}
            <textarea
              readOnly
              value={text || "No pull requests match these filters."}
              rows={12}
              aria-label="Nudge preview"
              className="w-full rounded border border-[#30363d] bg-[#0d1117] p-3 font-mono text-xs text-[#e6edf3]"
            />
            <p className="text-xs text-[#8b949e]">
              {matched.length} pull request{matched.length === 1 ? "" : "s"}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          {step < STEP_COUNT - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)}>Next</Button>
          ) : (
            // Disabled when there is nothing to copy: the preview shows a
            // placeholder sentence in that case, and copying would put an
            // empty string on the clipboard while the button claimed
            // success -- the screen and the clipboard disagreeing is the one
            // thing this feature cannot afford.
            <Button onClick={handleCopy} disabled={text.length === 0}>
              {copyFailed ? "Copy failed" : copied ? "Copied!" : "Copy"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
