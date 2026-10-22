import * as React from "react";
import { useDrag } from "@use-gesture/react";
import { cn } from "@/lib/utils";

export interface SwipeAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** tailwind bg/text classes for the revealed background */
  className?: string;
  /** return false (or resolve false) to cancel and snap back */
  onTrigger: () => unknown | Promise<unknown>;
}

const SPRING = "transform 420ms cubic-bezier(0.18, 0.89, 0.32, 1.28)";
const OUT = "transform 220ms cubic-bezier(0.4, 0, 1, 1)";

/**
 * Swipeable list row (mobile). Swipe right → `right` action (revealed on the left side),
 * swipe left → `left` action (revealed on the right side).
 */
export function SwipeRow({
  children, left, right, disabled, className,
}: { children: React.ReactNode; left?: SwipeAction; right?: SwipeAction; disabled?: boolean; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [x, setX] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [transition, setTransition] = React.useState(SPRING);
  const busy = React.useRef(false);

  const width = () => ref.current?.offsetWidth ?? 320;
  const threshold = () => Math.min(120, width() * 0.33);

  const bind = useDrag(
    ({ down, movement: [mx], velocity: [vx], direction: [dx], last, event }) => {
      if (disabled || busy.current) return;
      const action = mx > 0 ? right : mx < 0 ? left : undefined;
      // rubber-band when there's no action for this direction
      const resist = (v: number) => (action ? v : v * 0.15);
      if (down) {
        setDragging(true);
        setX(resist(mx));
        return;
      }
      if (!last) return;
      setDragging(false);
      const passed = Math.abs(mx) > threshold() || (vx > 0.6 && Math.abs(mx) > 48 && Math.sign(dx) === Math.sign(mx));
      if (action && passed) {
        event?.preventDefault?.();
        busy.current = true;
        setTransition(OUT);
        setX(Math.sign(mx) * width());
        Promise.resolve()
          .then(() => new Promise((r) => setTimeout(r, 180)))
          .then(() => action.onTrigger())
          .catch(() => undefined)
          .finally(() => {
            busy.current = false;
            setTransition(SPRING);
            setX(0);
          });
      } else {
        setTransition(SPRING);
        setX(0);
      }
    },
    { axis: "x", filterTaps: true, pointer: { touch: true }, threshold: 10, enabled: !disabled },
  );

  const active = x > 0 ? right : x < 0 ? left : undefined;
  const armed = Math.abs(x) > threshold();
  const Icon = active?.icon;

  return (
    <div ref={ref} className={cn("relative overflow-hidden rounded-xl", className)}>
      {active && (
        <div
          className={cn(
            "absolute inset-0 flex items-center px-6 text-sm font-semibold text-white",
            x > 0 ? "justify-start" : "justify-end",
            active.className ?? (x > 0 ? "bg-success" : "bg-destructive"),
          )}
          aria-hidden
        >
          <span className={cn("flex items-center gap-2 transition-transform duration-200", armed ? "scale-110" : "scale-90 opacity-80")}>
            {Icon && <Icon className="size-5" />}
            {active.label}
          </span>
        </div>
      )}
      <div
        {...bind()}
        className="relative touch-pan-y bg-card"
        style={{ transform: `translate3d(${x}px,0,0)`, transition: dragging ? "none" : transition }}
      >
        {children}
      </div>
    </div>
  );
}
