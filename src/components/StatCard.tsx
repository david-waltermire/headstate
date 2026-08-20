import { Card } from "@/components/ui/card";

/// One dashboard entry point. Every card is a button, not just a card with
/// a click handler on it -- that's what gives us free keyboard access and
/// an implicit `role="button"` for the test suite (and Task 18) to find.
export function StatCard({
  label,
  value,
  tone = "default",
  onClick,
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "success" | "warn";
  onClick: () => void;
}) {
  const toneClass = {
    default: "text-[#e6edf3]",
    danger: "text-[#f85149]",
    success: "text-[#3fb950]",
    warn: "text-[#d29922]",
  }[tone];

  return (
    <button onClick={onClick} className="text-left">
      <Card className="border-[#30363d] bg-[#161b22] p-4 transition hover:border-[#4493f8]">
        <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
        <div className="mt-1 text-sm text-[#8b949e]">{label}</div>
      </Card>
    </button>
  );
}
