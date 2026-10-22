import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Calls `onVisible` when scrolled into view; shows a load-more button as fallback. */
export function InfiniteSentinel({ hasMore, loading, onVisible }: { hasMore: boolean; loading: boolean; onVisible: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const cb = React.useRef(onVisible);
  cb.current = onVisible;
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && cb.current(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-4">
      {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <Button variant="ghost" onClick={onVisible}>Load more</Button>}
    </div>
  );
}
