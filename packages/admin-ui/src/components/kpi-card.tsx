import type * as React from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 2) - 1}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-7 w-full text-primary", className)} aria-hidden>
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} className="fill-current opacity-10" />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function KpiCard({
  label, value, sub, icon: Icon, spark, loading, tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  spark?: number[];
  loading?: boolean;
  tone?: "default" | "warn" | "bad";
}) {
  return (
    <Card className="gap-1 overflow-hidden px-4 py-3.5">
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {Icon && <Icon className="size-4 shrink-0" />}
      </div>
      {loading ? (
        <Skeleton className="my-1 h-7 w-20" />
      ) : (
        <div className={cn("text-2xl font-semibold tracking-tight tabular-nums", tone === "warn" && "text-warning", tone === "bad" && "text-destructive")}>{value}</div>
      )}
      {sub && <div className="line-clamp-2 text-xs text-muted-foreground">{sub}</div>}
      {spark && <Sparkline values={spark} className="mt-1" />}
    </Card>
  );
}
