// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure state for swipe rows (PLAN §6.2 "swipe list actions, iOS Mail style", §13 "same gesture
// vocabulary as the admin app"). The Svelte row (components/SwipeRow.svelte) only renders this.
//
// Vocabulary, as in the admin app's SwipeRow: swiping a row left reveals the actions on its right
// edge, swiping right reveals the ones on its left edge; any swipe on an open row closes it. The
// keyboard does the same with ArrowLeft / ArrowRight, and Escape closes.

export type Tone = "critical" | "warn" | "accent" | "neutral"

export type RowAction = {
  id: string
  /** Plain-language button label. */
  label: string
  /** Technical lens (NIP / kind), shown as the button's tooltip. */
  technical?: string
  tone: Tone
  run: () => void
}

export type RowSide = "left" | "right"

/** `open: "left"` means the row was swiped left, so the right-edge actions are showing. */
export type RowState = {
  open: RowSide | null
  dx: number
  dragging: boolean
}

export type RowEvent =
  | {type: "move"; dx: number}
  | {type: "swipe"; direction: RowSide | "up" | "down"}
  | {type: "cancel"}
  | {type: "close"}
  | {type: "key"; key: string}

export type RowShape = {left: number; right: number}

export const initialRowState = (): RowState => ({open: null, dx: 0, dragging: false})

/** Swipe directions the row listens for (none when it has no actions on that side). */
export const rowDirections = ({left, right}: RowShape): RowSide[] => [
  ...(right > 0 ? (["left"] as const) : []),
  ...(left > 0 ? (["right"] as const) : []),
]

const openFor = (direction: RowSide, shape: RowShape): RowSide | null => {
  if (direction === "left") return shape.right > 0 ? "left" : null
  return shape.left > 0 ? "right" : null
}

export const rowReducer = (state: RowState, event: RowEvent, shape: RowShape): RowState => {
  switch (event.type) {
    case "move":
      return {...state, dragging: true, dx: event.dx}
    case "swipe":
      if (event.direction !== "left" && event.direction !== "right") {
        return {...state, dragging: false, dx: 0}
      }
      return {
        dragging: false,
        dx: 0,
        open: state.open ? null : openFor(event.direction, shape),
      }
    case "cancel":
      return {...state, dragging: false, dx: 0}
    case "close":
      return initialRowState()
    case "key":
      if (event.key === "Escape") return initialRowState()
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction: RowSide = event.key === "ArrowLeft" ? "left" : "right"
        // A key towards the open side's actions closes them, like swiping back.
        if (state.open && state.open !== direction) return initialRowState()
        if (state.open === direction) return state
        return {dragging: false, dx: 0, open: openFor(direction, shape)}
      }
      return state
  }
}

/**
 * Horizontal offset of the row content in px: where the open side rests plus the live drag,
 * clamped so the content never travels further than the actions it reveals.
 */
export const rowOffset = (state: RowState, shape: RowShape, width: number): number => {
  const base =
    state.open === "left" ? -width * shape.right : state.open === "right" ? width * shape.left : 0
  const min = -width * shape.right
  const max = width * shape.left
  return Math.min(max, Math.max(min, base + state.dx))
}
