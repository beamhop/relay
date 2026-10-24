import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Calls `onVisible` when scrolled into view; shows a load-more button as fallback. */
/** `paused` (e.g. the last page failed) stops auto-loading so a failing request isn't retried in a loop; the button stays. */
export function InfiniteSentinel({ hasMore, loading, paused, onVisible }: { hasMore: boolean; loading: boolean; paused?: boolean; onVisible: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const cb = React.useRef(onVisible);
  cb.current = onVisible;
  // re-created after every load so a sentinel that is still in view (short page, tall screen) fires again
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loading || paused) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && cb.current(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, paused]);
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-4">
      {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <Button variant="ghost" onClick={onVisible}>Load more</Button>}
    </div>
  );
}
