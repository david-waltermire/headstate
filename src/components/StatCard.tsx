import { Card } from "@/components/ui/card";

/// One dashboard entry point. Every card is a button, not just a card with
/// a click handler on it -- that's what gives us free keyboard access and
/// an implicit `role="button"` for the test suite (and Task 18) to find.
///
/// Two cards ("Merged this week/month", #33) have no in-app list to filter
/// to -- the app only ever holds open PRs -- so they open the equivalent
/// GitHub search in a browser instead of applying a filter preset. `href`
/// is how a card opts into that: when set, the card renders as a plain
/// `<a target="_blank" rel="noreferrer">` (the same pattern `PrRow` already
/// uses to open a PR) styled identically to the button cards, rather than
/// faking a click handler that calls `window.open` or contorting `onClick`
/// to sometimes mean "navigate" instead of "filter." `onClick` stays
/// required for the other five -- `href` is the opt-in exception, not a
/// replacement for it.
export function StatCard({
  label,
  value,
  tone = "default",
  onClick,
  href,
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "success" | "warn";
  onClick?: () => void;
  href?: string;
}) {
  const toneClass = {
    default: "text-[#e6edf3]",
    danger: "text-[#f85149]",
    success: "text-[#3fb950]",
    warn: "text-[#d29922]",
  }[tone];

  const body = (
    <Card className="border-[#30363d] bg-[#161b22] p-4 transition hover:border-[#4493f8]">
      <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-sm text-[#8b949e]">{label}</div>
    </Card>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-left">
        {body}
      </a>
    );
  }

  return (
    <button onClick={onClick} className="text-left">
      {body}
    </button>
  );
}
