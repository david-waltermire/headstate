import type { PullRequest, ReviewState } from "@/types/pr";
import type { Filters } from "@/lib/derive";
import { useActiveFilters, useFilters } from "@/store/filters";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const REVIEW_OPTIONS: { value: ReviewState; label: string }[] = [
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "review_required", label: "Review required" },
  { value: "none", label: "No reviews" },
];

/// CI states, in the order a triaging user cares about: what is broken
/// first. `applyFilters` has always implemented this filter
/// (`derive.ts:144`); it just had no control outside NudgeWizard's local
/// state, which never wrote the store.
const CI_OPTIONS: { value: NonNullable<Filters["ci"]>; label: string }[] = [
  { value: "failure", label: "Failing" },
  { value: "pending", label: "Running" },
  { value: "success", label: "Passing" },
  { value: "none", label: "No checks" },
];

const SORT_OPTIONS: { value: NonNullable<Filters["sort"]>; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "recently-updated", label: "Recently updated" },
  { value: "least-recently-updated", label: "Least recently updated" },
];

/// Mirrors GitHub's `Label / Reviews` row from `<org>/<repo>/pulls`, plus
/// include *and* exclude label filters -- GitHub's own UI only lets you
/// include. Exclude earns its place: silencing a `dependencies` label to
/// hide dependabot noise is the dominant real-world case.
///
/// Every control here writes through the Task 13 filter store via
/// `setFilter`; this component holds no filter state of its own, so it
/// never drifts from what the PR list is actually showing.
export function FilterBar({ prs }: { prs: PullRequest[] }) {
  const filters = useActiveFilters();
  const { setFilter, reset, density, setDensity } = useFilters();
  const labels = [...new Set(prs.flatMap((pr) => pr.labels.map((l) => l.name)))].sort();

  const toggleLabel = (key: "includeLabels" | "excludeLabels", name: string) => {
    const current = filters[key] ?? [];
    setFilter(
      key,
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-4 py-2 text-sm">
      {/* No search existed at all, and a Tauri webview has no Cmd+F
          fallback. Filtering happens client-side over an already-fetched
          list, so this costs no API call and needs no debounce. */}
      <input
        type="search"
        value={filters.query ?? ""}
        onChange={(e) => setFilter("query", e.target.value || undefined)}
        placeholder="Search title, repo, or #number"
        aria-label="Search pull requests"
        className="w-64 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 text-sm text-[#e6edf3] placeholder:text-[#8b949e]"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm">
              Label{filters.includeLabels?.length ? ` (${filters.includeLabels.length})` : ""}
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Filter by label</DropdownMenuLabel>
            {labels.length === 0 && (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">No labels</div>
            )}
            {labels.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={filters.includeLabels?.includes(name) ?? false}
                onCheckedChange={() => toggleLabel("includeLabels", name)}
              >
                {name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm">
              Exclude label
              {filters.excludeLabels?.length ? ` (${filters.excludeLabels.length})` : ""}
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Hide labels</DropdownMenuLabel>
            {labels.length === 0 && (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">No labels</div>
            )}
            {labels.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={filters.excludeLabels?.includes(name) ?? false}
                onCheckedChange={() => toggleLabel("excludeLabels", name)}
              >
                {name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm">
              {/* Look the label up rather than rendering the enum: the
                  raw value is snake_case (`changes_requested`), and the
                  Sort trigger below already does exactly this. */}
              Reviews
              {filters.review
                ? `: ${REVIEW_OPTIONS.find((o) => o.value === filters.review)?.label ?? filters.review}`
                : ""}
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            value={filters.review ?? ""}
            onValueChange={(value) =>
              setFilter("review", (value || undefined) as ReviewState | undefined)
            }
          >
            <DropdownMenuRadioItem value="">Any</DropdownMenuRadioItem>
            {REVIEW_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm">
              CI
              {filters.ci
                ? `: ${CI_OPTIONS.find((o) => o.value === filters.ci)?.label ?? filters.ci}`
                : ""}
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            value={filters.ci ?? ""}
            onValueChange={(value) =>
              setFilter("ci", (value || undefined) as Filters["ci"])
            }
          >
            <DropdownMenuRadioItem value="">Any</DropdownMenuRadioItem>
            {CI_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant={filters.draftsOnly ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setFilter("draftsOnly", !filters.draftsOnly)}
      >
        Drafts only
      </Button>

      {/* `in_merge_queue` is rendered on rows, counted by deriveStats,
          and gates kebab actions -- filtering to it was the one thing
          you could not do. Undefined rather than false when off, so it
          matches how every other boolean filter clears. */}
      <Button
        variant={filters.inMergeQueueOnly ? "secondary" : "ghost"}
        size="sm"
        onClick={() =>
          setFilter("inMergeQueueOnly", filters.inMergeQueueOnly ? undefined : true)
        }
      >
        In merge queue
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm">
              Sort
              {filters.sort && filters.sort !== "newest"
                ? `: ${SORT_OPTIONS.find((opt) => opt.value === filters.sort)?.label}`
                : ""}
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            value={filters.sort ?? "newest"}
            onValueChange={(value) => setFilter("sort", value as Filters["sort"])}
          >
            {SORT_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Density is a VIEW preference, not a filter -- it changes how
          rows look, never which ones are shown -- so it sits past the
          `ml-auto` divider with Clear filters rather than among the
          chips, and `reset` deliberately does not touch it. */}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        aria-pressed={density === "dense"}
        title={density === "dense" ? "Switch to comfortable rows" : "Fit more rows on screen"}
        onClick={() => setDensity(density === "dense" ? "comfortable" : "dense")}
      >
        {density === "dense" ? "Comfortable" : "Dense"}
      </Button>

      <Button variant="ghost" size="sm" onClick={reset}>
        Clear filters
      </Button>
    </div>
  );
}
