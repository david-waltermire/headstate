import type { PullRequest, ReviewState } from "@/types/pr";
import type { Filters } from "@/lib/derive";
import { useFilters } from "@/store/filters";
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
  const { filters, setFilter, reset } = useFilters();
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
              Reviews{filters.review ? `: ${filters.review}` : ""}
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

      <Button
        variant={filters.draftsOnly ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setFilter("draftsOnly", !filters.draftsOnly)}
      >
        Drafts only
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

      <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
        Clear filters
      </Button>
    </div>
  );
}
