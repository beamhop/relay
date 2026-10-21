import {identity, uniq} from "@welshman/lib"
import {CLASSIFIED, EVENT_TIME, LONG_FORM, THREAD} from "@welshman/util" // beamhop: no-payments
import type {TrustedEvent} from "@welshman/util"
import {Article, Classified, Thread, displayPubkey} from "@welshman/domain"
import {makeRoomKey} from "@welshman/app"
import {decodePubkey} from "@lib/util"
import {getEventTitle} from "@app/features/calendar"
import {app} from "@app/core/app"
import {profiles, rooms} from "@app/core/plugins"
import {reader} from "@app/core/domain"
import {PLATFORM_NAME} from "@app/core/env"
import {decodeRelay} from "@app/core/relays"

const staticTitles = new Map<string, string>([
  ["/home", "Home"],
  ["/spaces", "Spaces"],
  ["/spaces/[relay]", "Space"],
  ["/spaces/[relay]/chat", "Space Chat"],
  ["/spaces/[relay]/threads", "Threads"],
  ["/spaces/[relay]/classifieds", "Classifieds"],
  ["/spaces/[relay]/articles", "Articles"],
  ["/spaces/[relay]/articles/create", "Write an Article"],
  ["/spaces/[relay]/calendar", "Calendar"],
  ["/spaces/[relay]/polls", "Polls"],
  ["/chat", "Messages"],
  ["/join", "Join Space"],
  ["/settings/about", "About"],
  ["/settings/profile", "Profile Settings"],
  ["/settings/content", "Content Settings"],
  ["/settings/privacy", "Privacy Settings"],
  ["/settings/alerts", "Alert Settings"],
  // beamhop: no-payments (wallet, hosting, goals and space-create routes removed)
  ["/[bech32]", "Opening Link"],
])

const contentFallbackTitles = new Map<string, string>([
  ["/spaces/[relay]/threads/[id]", "Thread"],
  ["/spaces/[relay]/calendar/[address]", "Event"],
  ["/spaces/[relay]/classifieds/[address]", "Listing"],
  ["/spaces/[relay]/articles/[address]", "Article"],
])

type RouteParams = Record<string, string | undefined>

type TitlePage = {
  route: {id: string | null}
  params: RouteParams
}

type PageTitleContext = {
  page: TitlePage
  pubkey: string | undefined
}

const getRoomTitle = (params: RouteParams) => {
  const relay = params.relay
  const h = params.h

  if (!relay || !h) {
    return "Room"
  }

  const room = rooms.get().get(makeRoomKey(decodeRelay(relay), h))

  return room?.meta?.name() || "Room"
}

const getContentTitle = (event: TrustedEvent) => {
  switch (event.kind) {
    case THREAD:
      return reader(Thread)(event).title()
    case EVENT_TIME:
      return getEventTitle(event)
    case CLASSIFIED:
      return reader(Classified)(event).title()
    case LONG_FORM:
      return reader(Article)(event).title()
  }
}

const getChatTitle = (chatId: string | undefined, pubkey: string | undefined) => {
  if (!chatId) {
    return "Chat"
  }

  // splitChatId resolves against the signed-in user and throws when there isn't one.
  const others = uniq(chatId.split(",")).filter(pk => pk !== pubkey)

  if (others.length === 1) {
    return `Chat with ${displayPubkey(others[0])}`
  }

  if (others.length > 1) {
    return `Group chat (${others.length})`
  }

  return "Chat"
}

export const makeTitle = (...parts: Array<string | undefined>) =>
  parts
    .map(part => part?.trim() || "")
    .filter(identity)
    .join(" · ") || PLATFORM_NAME

export const getPageTitle = ({page, pubkey}: PageTitleContext) => {
  const routeId = page.route.id || ""
  const staticTitle = staticTitles.get(routeId)

  if (staticTitle) {
    return makeTitle(staticTitle)
  }

  if (routeId === "/chat/[chat]") {
    return makeTitle(getChatTitle(page.params.chat, pubkey))
  }

  if (routeId === "/people/[npub]") {
    const profilePubkey = decodePubkey(page.params.npub!)

    if (profilePubkey) {
      return makeTitle(profiles.get().display(profilePubkey).get())
    }
  }

  if (routeId === "/spaces/[relay]/[h]") {
    return makeTitle(getRoomTitle(page.params))
  }

  const contentFallbackTitle = contentFallbackTitles.get(routeId)

  if (contentFallbackTitle) {
    const event = app.get().repository.getEvent(page.params.id || page.params.address || "")

    return makeTitle((event && getContentTitle(event)) || contentFallbackTitle)
  }

  return makeTitle()
}
