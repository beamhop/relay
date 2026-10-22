import * as React from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Chips input for string/number arrays. Enter, comma or space commits a value. */
export function ListInput<T extends string | number>({
  value, onChange, placeholder, numeric, format, validate, className, id,
}: {
  value: T[];
  onChange: (v: T[]) => void;
  placeholder?: string;
  numeric?: boolean;
  format?: (v: T) => React.ReactNode;
  validate?: (raw: string) => string | undefined;
  className?: string;
  id?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const [err, setErr] = React.useState<string>();
  const commit = (raw: string) => {
    const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) {
      const e = validate?.(p) ?? (numeric && !/^-?\d+$/.test(p) ? "Must be an integer" : undefined);
      if (e) {
        setErr(`${p}: ${e}`);
        return;
      }
      const v = (numeric ? Number(p) : p) as T;
      if (!next.includes(v)) next.push(v);
    }
    setErr(undefined);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30",
          className,
        )}
      >
        {value.map((v) => (
          <Badge key={String(v)} variant="secondary" className="gap-1 pr-1 font-normal">
            {format ? format(v) : String(v)}
            <button type="button" className="rounded-sm p-0.5 hover:bg-foreground/10" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          className="min-w-24 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground"
          value={draft}
          inputMode={numeric ? "numeric" : undefined}
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => commit(draft)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/[\s,]/.test(t)) {
              e.preventDefault();
              commit(t);
            }
          }}
        />
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
