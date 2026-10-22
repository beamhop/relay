import * as React from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** Lightweight syntax-highlighted JSON. */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const text = React.useMemo(() => JSON.stringify(value, null, 2), [value]);
  const html = React.useMemo(() => highlight(text), [text]);
  return (
    <div className={cn("relative rounded-lg border bg-muted/40", className)}>
      <CopyButton value={text} label="JSON" className="absolute top-1.5 right-1.5" />
      <pre className="max-h-[60dvh] overflow-auto p-3 pr-10 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function highlight(json: string) {
  const esc = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = "text-amber-600 dark:text-amber-400";
    if (m.startsWith('"')) cls = m.endsWith(":") ? "text-violet-600 dark:text-violet-400" : "text-emerald-700 dark:text-emerald-400";
    else if (/true|false|null/.test(m)) cls = "text-sky-600 dark:text-sky-400";
    return `<span class="${cls}">${m}</span>`;
  });
}
