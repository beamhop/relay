// SPDX-License-Identifier: AGPL-3.0-or-later
// Svelte action wiring pointer events (touch, pen, mouse) into a SwipeRecognizer. Adapted from the
// admin app (packages/pwa/src/lib/gestures/swipe.ts).

import type {Action} from "svelte/action"
import {type Direction, type SwipeOptions, SwipeRecognizer, type SwipeState} from "./recognizer"

export type SwipeParams = SwipeOptions & {
  disabled?: boolean
  onmove?: (s: SwipeState) => void
  onswipe?: (d: Direction) => void
  /** Gesture ended without committing (snap back). */
  oncancel?: () => void
}

const key = (p: SwipeParams) => JSON.stringify([p.axis, p.threshold, p.directions, p.velocity])

export const swipe: Action<HTMLElement, SwipeParams> = (node, initial) => {
  let user = initial
  let rec = new SwipeRecognizer(user)
  let pointerId: number | null = null
  let moved = false

  const setTouchAction = () => {
    const axis = user.axis ?? "x"
    node.style.touchAction = axis === "x" ? "pan-y" : axis === "y" ? "pan-x" : "none"
  }

  setTouchAction()

  const down = (e: PointerEvent) => {
    if (user.disabled || pointerId !== null) return
    if (e.pointerType === "mouse") return // desktop uses the hover buttons / keyboard instead
    const target = e.target as HTMLElement | null
    if (target?.closest("input, textarea, select, [contenteditable], [data-no-swipe]")) return
    pointerId = e.pointerId
    moved = false
    rec.start(e.clientX, e.clientY, e.timeStamp)
  }

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const s = rec.move(e.clientX, e.clientY, e.timeStamp)
    if (s.ignored) {
      pointerId = null
      rec.cancel()
      user.oncancel?.()
      return
    }
    if (s.locked) {
      moved = true
      try {
        if (!node.hasPointerCapture(e.pointerId)) node.setPointerCapture(e.pointerId)
      } catch {
        // synthetic pointers cannot be captured
      }
    }
    user.onmove?.(s)
  }

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    pointerId = null
    const r = rec.end(e.clientX, e.clientY, e.timeStamp)
    if (r.direction) user.onswipe?.(r.direction)
    else user.oncancel?.()
  }

  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    pointerId = null
    rec.cancel()
    user.oncancel?.()
  }

  // Swallow the click that follows a real drag so links/buttons under the finger don't fire.
  const click = (e: MouseEvent) => {
    if (!moved) return
    moved = false
    e.stopPropagation()
    e.preventDefault()
  }

  node.addEventListener("pointerdown", down)
  node.addEventListener("pointermove", move)
  node.addEventListener("pointerup", up)
  node.addEventListener("pointercancel", cancel)
  node.addEventListener("click", click, true)

  return {
    update(next) {
      const changed = key(next) !== key(user)
      user = next
      if (changed) {
        rec = new SwipeRecognizer(next)
        setTouchAction()
      }
    },
    destroy() {
      node.removeEventListener("pointerdown", down)
      node.removeEventListener("pointermove", move)
      node.removeEventListener("pointerup", up)
      node.removeEventListener("pointercancel", cancel)
      node.removeEventListener("click", click, true)
    },
  }
}
