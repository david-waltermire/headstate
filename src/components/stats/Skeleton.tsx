import { Card } from "@/components/ui/card";

/// A placeholder holding the same footprint as the content it stands in
/// for, so sections do not jump as each query lands.
function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <Card className={`px-4 ${className}`}>
      <div className="animate-pulse">
        <div className="h-3 w-24 rounded bg-[#21262d]" />
        <div className="mt-2 h-7 w-16 rounded bg-[#21262d]" />
        <div className="mt-2 h-3 w-32 rounded bg-[#21262d]" />
      </div>
    </Card>
  );
}

export function SkeletonRow({ count, cols }: { count: number; cols: string }) {
  return (
    <div className={`grid grid-cols-1 gap-3 ${cols}`}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

/// Chart-shaped placeholder: the header is real so the section is
/// identifiable while its data is still in flight.
export function SkeletonChart({ title, hint }: { title: string; hint: string }) {
  return (
    <Card className="px-4">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-[#8b949e]">{hint}</div>
      <div className="mt-4 h-56 w-full animate-pulse rounded bg-[#21262d]" />
    </Card>
  );
}
