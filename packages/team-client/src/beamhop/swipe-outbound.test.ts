// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for GAPS C6: swipe row reducers / undo queue / row action rules, and the per-group
// outbound relay selection (run by the repo-root `bun test`).

import {beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {get} from "svelte/store"
import {SwipeRecognizer} from "./gestures/recognizer"
import {initialRowState, rowDirections, rowOffset, rowReducer} from "./gestures/row-actions"
import {createUndoQueue, initialPendingState, pendingReducer} from "./gestures/undo-queue"
import {inboxRowActions, messageRowActions} from "./features/swipe-actions"
import {capHidden, isInboxRowHidden, isMessageHidden} from "./features/hidden"

mock.module("$app/paths", () => ({base: "/app", assets: "/app"}))

let outbound: typeof import("./features/outbound")

beforeAll(async () => {
  outbound = await import("./features/outbound")
})

const noop = () => {}

describe("swipe row reducer", () => {
  const both = {left: 1, right: 2}

  test("swipe left opens the right-edge actions, any swipe on an open row closes it", () => {
    let s = rowReducer(initialRowState(), {type: "move", dx: -30}, both)
    expect(s).toEqual({open: null, dx: -30, dragging: true})
    s = rowReducer(s, {type: "swipe", direction: "left"}, both)
    expect(s).toEqual({open: "left", dx: 0, dragging: false})
    s = rowReducer(s, {type: "swipe", direction: "left"}, both)
    expect(s.open).toBeNull()
  })

  test("a side without actions does not open", () => {
    const s = rowReducer(
      initialRowState(),
      {type: "swipe", direction: "right"},
      {left: 0, right: 1},
    )
    expect(s.open).toBeNull()
    expect(rowDirections({left: 0, right: 1})).toEqual(["left"])
    expect(rowDirections({left: 2, right: 0})).toEqual(["right"])
  })

  test("cancel snaps back; vertical swipes are ignored", () => {
    let s = rowReducer(initialRowState(), {type: "move", dx: 20}, both)
    s = rowReducer(s, {type: "cancel"}, both)
    expect(s).toEqual(initialRowState())
    expect(rowReducer(initialRowState(), {type: "swipe", direction: "up"}, both).open).toBeNull()
  })

  test("keyboard: arrows open, the opposite arrow or Escape closes", () => {
    let s = rowReducer(initialRowState(), {type: "key", key: "ArrowLeft"}, both)
    expect(s.open).toBe("left")
    expect(rowReducer(s, {type: "key", key: "ArrowLeft"}, both)).toBe(s)
    expect(rowReducer(s, {type: "key", key: "ArrowRight"}, both).open).toBeNull()
    s = rowReducer(initialRowState(), {type: "key", key: "ArrowRight"}, both)
    expect(s.open).toBe("right")
    expect(rowReducer(s, {type: "key", key: "Escape"}, both).open).toBeNull()
    expect(rowReducer(s, {type: "key", key: "Enter"}, both)).toBe(s)
  })

  test("offset rests at the open side and clamps the drag", () => {
    expect(rowOffset({open: "left", dx: 0, dragging: false}, both, 76)).toBe(-152)
    expect(rowOffset({open: "right", dx: 0, dragging: false}, both, 76)).toBe(76)
    expect(rowOffset({open: null, dx: -500, dragging: true}, both, 76)).toBe(-152)
    expect(rowOffset({open: null, dx: 500, dragging: true}, {left: 0, right: 1}, 76)).toBe(0)
  })

  test("recognizer commits a horizontal swipe and gives up on vertical scroll", () => {
    const r = new SwipeRecognizer({axis: "x", threshold: 48})
    r.start(100, 100, 0)
    r.move(90, 101, 10)
    expect(r.end(40, 102, 200).direction).toBe("left")
    r.start(100, 100, 0)
    expect(r.move(101, 130, 10).ignored).toBe(true)
    expect(r.end(101, 200, 50).direction).toBeNull()
  })
})

describe("undo queue (delayed commit)", () => {
  const fakeTimers = () => {
    const timers = new Map<number, () => void>()
    let n = 0
    return {
      setTimer: (fn: () => void) => {
        timers.set(++n, fn)
        return n
      },
      clearTimer: (t: unknown) => void timers.delete(t as number),
      fire: () => {
        const fns = [...timers.values()]
        timers.clear()
        for (const fn of fns) fn()
      },
      size: () => timers.size,
    }
  }

  test("reducer: schedule is idempotent per key; undo/commit remove", () => {
    const item = {id: "a", key: "remove:1", commitAt: 10}
    let s = pendingReducer(initialPendingState(), {type: "schedule", item})
    expect(pendingReducer(s, {type: "schedule", item: {...item, id: "b"}})).toBe(s)
    s = pendingReducer(s, {type: "undo", id: "a"})
    expect(s.items).toEqual([])
    s = pendingReducer(s, {type: "schedule", item})
    expect(pendingReducer(s, {type: "commit", id: "a"}).items).toEqual([])
  })

  test("nothing is sent before the window ends; then commit runs once", () => {
    const t = fakeTimers()
    const commit = mock(noop)
    const q = createUndoQueue({delayMs: 6000, now: () => 1000, ...t})
    const id = q.schedule({key: "remove:1", commit})
    expect(q.schedule({key: "remove:1", commit})).toBe(id)
    expect(q.state.items).toEqual([{id, key: "remove:1", commitAt: 7000}])
    expect(commit).not.toHaveBeenCalled()
    t.fire()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(q.isPending("remove:1")).toBe(false)
    expect(q.undo(id)).toBe(false)
  })

  test("undo inside the window cancels and restores", () => {
    const t = fakeTimers()
    const commit = mock(noop)
    const onUndo = mock(noop)
    const changes: number[] = []
    const q = createUndoQueue({delayMs: 6000, ...t, onChange: s => changes.push(s.items.length)})
    const id = q.schedule({key: "k", commit, onUndo})
    expect(q.undo(id)).toBe(true)
    expect(t.size()).toBe(0)
    t.fire()
    expect(commit).not.toHaveBeenCalled()
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(changes).toEqual([1, 0])
  })

  test("flush commits everything pending now", async () => {
    const t = fakeTimers()
    const a = mock(noop)
    const b = mock(noop)
    const q = createUndoQueue({delayMs: 6000, ...t})
    q.schedule({key: "a", commit: a})
    q.schedule({key: "b", commit: b})
    await q.flush()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(q.state.items).toEqual([])
    t.fire()
    expect(a).toHaveBeenCalledTimes(1)
  })
})

describe("row action rules", () => {
  const h = {reply: noop, hide: noop, remove: noop, removeMember: noop}
  const ids = (r: ReturnType<typeof messageRowActions>) => [
    r.left.map(a => a.id),
    r.right.map(a => a.id),
  ]

  test("everyone: reply + hide; no moderation", () => {
    expect(
      ids(
        messageRowActions(
          {isOwn: false, canReply: true, adminDelete: undefined, canRemoveMember: false},
          h,
        ),
      ),
    ).toEqual([["reply"], ["hide"]])
  })

  test("admins: remove message and remove person on others' messages, with technical lens", () => {
    const r = messageRowActions(
      {isOwn: false, canReply: false, adminDelete: "room", canRemoveMember: true},
      h,
    )
    expect(ids(r)).toEqual([[], ["hide", "remove", "remove-member"]])
    expect(r.right[1]!.technical).toContain("9005")
    expect(r.right[2]!.technical).toContain("9001")
    expect(r.right.map(a => a.label).join(" ")).not.toMatch(/NIP|kind/)
    const space = messageRowActions(
      {isOwn: false, canReply: false, adminDelete: "space", canRemoveMember: false},
      h,
    )
    expect(space.right[1]!.technical).toContain("NIP-86")
  })

  test("admins get no moderation swipe on their own messages", () => {
    expect(
      ids(
        messageRowActions(
          {isOwn: true, canReply: true, adminDelete: "room", canRemoveMember: true},
          h,
        ),
      ),
    ).toEqual([["reply"], ["hide"]])
  })

  test("inbox: mark read only when unread; hide always", () => {
    const hh = {markRead: noop, hide: noop}
    expect(inboxRowActions({unread: true}, hh).left.map(a => a.id)).toEqual(["mark-read"])
    expect(inboxRowActions({unread: false}, hh).left).toEqual([])
    expect(inboxRowActions({unread: false}, hh).right.map(a => a.id)).toEqual(["hide"])
  })

  test("hidden rows", () => {
    expect(isMessageHidden({"msg:a": "1"}, new Set(), "a")).toBe(true)
    expect(isMessageHidden({}, new Set(["b"]), "b")).toBe(true)
    expect(isMessageHidden({}, new Set(), "c")).toBe(false)
    expect(isInboxRowHidden({"inbox:/x": "e1"}, "/x", "e1")).toBe(true)
    // a newer message brings the row back
    expect(isInboxRowHidden({"inbox:/x": "e1"}, "/x", "e2")).toBe(false)
    const many = Object.fromEntries(Array.from({length: 10}, (_, i) => [`msg:${i}`, "1"]))
    expect(Object.keys(capHidden(many, 3))).toEqual(["msg:7", "msg:8", "msg:9"])
  })
})

describe("per-group outbound relays", () => {
  const HOME = "wss://chat.example.com/"
  const PARTNER = "wss://partner.example.com/"
  const PUBLIC = "wss://relay.public.example/"
  let policy: ReturnType<typeof outbound.parseOutboundPolicy>

  beforeAll(() => {
    policy = outbound.parseOutboundPolicy({
      groups: {
        sales: {outbound: [PARTNER, "not a url", 7]},
        internal: {outbound: []},
      },
      default: {outbound: null},
    })
  })

  test("parse: keeps valid relay URLs, normalizes, drops junk; empty = no policy", () => {
    expect(policy).toEqual({
      groups: {sales: {outbound: [PARTNER]}, internal: {outbound: []}},
      default: {outbound: null},
    })
    expect(outbound.parseOutboundPolicy(null)).toBeNull()
    expect(outbound.parseOutboundPolicy("x")).toBeNull()
    expect(outbound.parseOutboundPolicy({groups: {}, default: {outbound: null}})).toBeNull()
    expect(outbound.parseOutboundPolicy({groups: {a: {outbound: "wss://x"}}})).toBeNull()
    expect(
      outbound.parseOutboundPolicy({default: {outbound: ["wss://partner.example.com"]}}),
    ).toEqual({
      groups: {},
      default: {outbound: [PARTNER]},
    })
  })

  test("group id comes from the NIP-29 h tag", () => {
    expect(
      outbound.groupIdOf([
        ["p", "x"],
        ["h", "sales"],
      ]),
    ).toBe("sales")
    expect(outbound.groupIdOf([["h", ""]])).toBeUndefined()
    expect(outbound.groupIdOf([])).toBeUndefined()
  })

  test("allowed relays: home relay always, plus the group's (or the default) list", () => {
    expect(outbound.allowedRelaysForGroup(policy, "sales", HOME)).toEqual([HOME, PARTNER])
    expect(outbound.allowedRelaysForGroup(policy, "internal", HOME)).toEqual([HOME])
    expect(outbound.allowedRelaysForGroup(policy, "other", HOME)).toBeNull()
    expect(outbound.allowedRelaysForGroup(null, "sales", HOME)).toBeNull()
    const strict = outbound.parseOutboundPolicy({default: {outbound: []}})
    expect(outbound.allowedRelaysForGroup(strict, "other", HOME)).toEqual([HOME])
  })

  test("select: group content only goes to the group's allowed relays", () => {
    const relays = [HOME, PARTNER, PUBLIC]
    const sel = (tags: string[][], p = policy, loaded = true) =>
      outbound.selectPublishRelays({tags, relays, policy: p, homeRelay: HOME, loaded})

    expect(sel([["h", "sales"]])).toEqual([HOME, PARTNER])
    expect(sel([["h", "internal"]])).toEqual([HOME])
    // not listed and no default: unchanged
    expect(sel([["h", "other"]])).toEqual(relays)
    // not group content (DMs, profiles): unchanged
    expect(sel([["p", "abc"]])).toEqual(relays)
    // no policy published: behave as today
    expect(sel([["h", "sales"]], null)).toEqual(relays)
    // before the policy is known: home relay only (fail closed)
    expect(sel([["h", "sales"]], null, false)).toEqual([HOME])
    expect(sel([["p", "abc"]], null, false)).toEqual(relays)
  })

  test("select: compares normalized URLs", () => {
    expect(
      outbound.selectPublishRelays({
        tags: [["h", "sales"]],
        relays: ["wss://partner.example.com", "wss://relay.public.example"],
        policy,
        homeRelay: HOME,
      }),
    ).toEqual(["wss://partner.example.com"])
  })

  describe("loader and publisher wrapper", () => {
    beforeEach(() => outbound.resetOutboundPolicy())

    const json = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), {status})) as unknown as typeof fetch

    test("loads the policy from /.well-known/beamhop/network", async () => {
      let url = ""
      const fetchImpl = (async (input: string) => {
        url = input
        return new Response(JSON.stringify({groups: {sales: {outbound: [PARTNER]}}}))
      }) as unknown as typeof fetch
      await outbound.loadOutboundPolicy(fetchImpl)
      expect(url).toBe("/.well-known/beamhop/network")
      expect(get(outbound.outboundPolicy)?.groups.sales?.outbound).toEqual([PARTNER])
      expect(get(outbound.outboundPolicyLoaded)).toBe(true)
    })

    test("404, bad JSON or a network error mean no policy", async () => {
      await outbound.loadOutboundPolicy(json({}, 404))
      expect(get(outbound.outboundPolicy)).toBeNull()
      expect(get(outbound.outboundPolicyLoaded)).toBe(true)

      outbound.resetOutboundPolicy()
      await outbound.loadOutboundPolicy(
        (async () => new Response("<html>")) as unknown as typeof fetch,
      )
      expect(get(outbound.outboundPolicy)).toBeNull()

      outbound.resetOutboundPolicy()
      await outbound.loadOutboundPolicy((async () => {
        throw new TypeError("offline")
      }) as unknown as typeof fetch)
      expect(get(outbound.outboundPolicy)).toBeNull()
      expect(get(outbound.outboundPolicyLoaded)).toBe(true)
    })

    test("the app policy filters the relays of every publish and can be uninstalled", () => {
      const seen: string[][] = []
      const publisher = {
        publish: (request: {event: {tags: string[][]}; relays: string[]}) => {
          seen.push(request.relays)
          return request
        },
      }
      const original = publisher.publish
      const fakeApp = {use: () => publisher}

      outbound.outboundPolicy.set(policy)
      outbound.outboundPolicyLoaded.set(true)

      const uninstall = outbound.outboundPublishPolicy(fakeApp as never) as () => void
      const relays = [PARTNER, PUBLIC]

      publisher.publish({event: {tags: [["h", "sales"]]}, relays})
      publisher.publish({event: {tags: [["h", "internal"]]}, relays})
      publisher.publish({event: {tags: []}, relays})
      uninstall()
      expect(publisher.publish).toBe(original)
      expect(seen).toEqual([[PARTNER], [], relays])
    })
  })
})
