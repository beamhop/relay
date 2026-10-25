import { useBlocker } from "@tanstack/react-router";
import { useConfirm } from "@/components/confirm";

/**
 * Asks before leaving a form with unsaved edits: in-app navigation (links, back/forward) gets a confirm dialog,
 * closing or reloading the tab the browser's own prompt. Navigations that only change the search params of the
 * same page (tabs, filters) are let through.
 */
export function useUnsavedGuard(dirty: boolean) {
  const confirm = useConfirm();
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      const ok = await confirm({
        title: "Discard unsaved changes?",
        description: "You have edits on this page that haven't been saved.",
        destructive: true,
        confirmText: "Discard",
      });
      return !ok;
    },
    enableBeforeUnload: dirty,
    disabled: !dirty,
  });
}
