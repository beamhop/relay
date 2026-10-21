<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * iOS Mail-style row (PLAN §6.2, §13), adapted from the admin app's SwipeRow: swipe left/right
   * to reveal actions. Keyboard: with the row focused, ArrowLeft / ArrowRight reveal the actions
   * and focus the first one; Escape closes. Mouse users get the same actions as hover buttons
   * (`hoverBar`) or in the row's menu. Respects prefers-reduced-motion.
   */
  import type {Snippet} from "svelte"
  import cx from "classnames"
  import {swipe} from "../gestures/swipe"
  import {
    initialRowState,
    rowDirections,
    rowOffset,
    rowReducer,
    type RowAction,
    type RowEvent,
  } from "../gestures/row-actions"

  type Props = {
    left?: RowAction[]
    right?: RowAction[]
    children: Snippet
    /** Show the actions as small buttons on hover/focus for mouse users. */
    hoverBar?: boolean
    class?: string
  }

  const {left = [], right = [], children, hoverBar = false, class: className = ""}: Props = $props()

  const W = 76
  const shape = $derived({left: left.length, right: right.length})
  const directions = $derived(rowDirections(shape))

  let row = $state(initialRowState())
  let root: HTMLElement | undefined = $state()

  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const tones = {
    critical: "bg-error text-error-content",
    warn: "bg-warning text-warning-content",
    accent: "bg-primary text-primary-content",
    neutral: "bg-surface-more text-content",
  }

  const vibrate = (ms: number) => {
    try {
      navigator.vibrate?.(ms)
    } catch {
      // not allowed without a user gesture on some browsers
    }
  }

  const send = (event: RowEvent) => {
    const before = row.open
    row = rowReducer(row, event, shape)
    if (row.open && row.open !== before) {
      vibrate(12)
      queueMicrotask(() =>
        root?.querySelector<HTMLButtonElement>(`[data-row-side="${row.open}"] button`)?.focus(),
      )
    }
  }

  const run = (a: RowAction) => {
    send({type: "close"})
    vibrate(8)
    a.run()
  }

  const onkeydown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest("input, textarea, select, [contenteditable]")) return
    if (!["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return
    if (!left.length && !right.length) return
    if (e.key === "Escape" && !row.open) return
    e.preventDefault()
    send({type: "key", key: e.key})
  }

  const offset = $derived(rowOffset(row, shape, W))
  const active = $derived(row.open !== null || row.dragging)
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={root}
  class={cx("group/swipe relative", className)}
  style:overflow-x="clip"
  {onkeydown}
  onfocusout={e => {
    if (row.open && !root?.contains(e.relatedTarget as Node | null)) send({type: "close"})
  }}>
  {#if left.length}
    <div
      class={cx("absolute inset-y-0 left-0 flex", {invisible: !active || offset <= 0})}
      data-row-side="right"
      aria-hidden={row.open !== "right"}>
      {#each left as a (a.id)}
        <button
          type="button"
          class={cx("h-full text-xs font-medium", tones[a.tone])}
          style:width={`${W}px`}
          title={a.technical}
          tabindex={row.open === "right" ? 0 : -1}
          data-row-action={a.id}
          onclick={() => run(a)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if right.length}
    <div
      class={cx("absolute inset-y-0 right-0 flex", {invisible: !active || offset >= 0})}
      data-row-side="left"
      aria-hidden={row.open !== "left"}>
      {#each right as a (a.id)}
        <button
          type="button"
          class={cx("h-full text-xs font-medium", tones[a.tone])}
          style:width={`${W}px`}
          title={a.technical}
          tabindex={row.open === "left" ? 0 : -1}
          data-row-action={a.id}
          onclick={() => run(a)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
  <div
    class={cx("relative", {"bg-surface": active})}
    style:transform={offset ? `translateX(${offset}px)` : undefined}
    style:transition={row.dragging || reducedMotion ? "none" : "transform 180ms ease-out"}
    use:swipe={{
      axis: "x",
      directions,
      threshold: 48,
      disabled: !left.length && !right.length,
      onmove: s => send({type: "move", dx: s.dx}),
      onswipe: d => send({type: "swipe", direction: d}),
      oncancel: () => send({type: "cancel"}),
    }}>
    {@render children()}
  </div>
  {#if hoverBar && (left.length || right.length) && !active}
    <div
      class="pointer-events-none absolute inset-y-0 right-2 hidden items-center gap-1 opacity-0 transition-opacity group-focus-within/swipe:pointer-events-auto group-focus-within/swipe:opacity-100 group-hover/swipe:pointer-events-auto group-hover/swipe:opacity-100 md:flex">
      {#each [...left, ...right] as a (a.id)}
        <button
          type="button"
          class="button button-xs button-neutral"
          title={a.technical}
          data-row-hover-action={a.id}
          onclick={() => run(a)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
