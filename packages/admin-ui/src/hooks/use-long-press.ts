import * as React from "react";

/**
 * Long-press on touch screens. iOS Safari fires no `contextmenu` for a long-press on a link (it shows its link
 * preview instead), so selection modes can't rely on it. Spread the handlers on the element; the click that
 * follows a long-press is swallowed. Pair with `[-webkit-touch-callout:none]` to suppress the iOS preview.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const fired = React.useRef(false);
  const cb = React.useRef(onLongPress);
  cb.current = onLongPress;
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  React.useEffect(() => cancel, []);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        cb.current();
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.touches[0].clientX - s.x, e.touches[0].clientY - s.y) > 10) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      // Android long-press / desktop right-click; skip if the timer already fired for this press
      e.preventDefault();
      if (fired.current) return;
      cancel();
      cb.current();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
