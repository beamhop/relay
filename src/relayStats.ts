export type RelayActivityLevel = "info" | "ok" | "warn" | "error";

export interface RelayActivity {
  at: string;
  level: RelayActivityLevel;
  message: string;
  details?: Record<string, unknown>;
}

export interface RelayStats {
  startedAt: string;
  startedAtMs: number;
  connections: {
    opened: number;
    closed: number;
  };
  messages: {
    total: number;
    event: number;
    req: number;
    close: number;
    count: number;
    auth: number;
    negOpen: number;
    negMsg: number;
    negClose: number;
    unsupported: number;
  };
  events: {
    received: number;
    accepted: number;
    rejected: number;
    stored: number;
    duplicate: number;
    ephemeral: number;
    broadcast: number;
    delivered: number;
  };
  recent: RelayActivity[];
}

export function createRelayStats(): RelayStats {
  const startedAtMs = Date.now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    connections: {
      opened: 0,
      closed: 0,
    },
    messages: {
      total: 0,
      event: 0,
      req: 0,
      close: 0,
      count: 0,
      auth: 0,
      negOpen: 0,
      negMsg: 0,
      negClose: 0,
      unsupported: 0,
    },
    events: {
      received: 0,
      accepted: 0,
      rejected: 0,
      stored: 0,
      duplicate: 0,
      ephemeral: 0,
      broadcast: 0,
      delivered: 0,
    },
    recent: [],
  };
}

export function recordRelayActivity(stats: RelayStats, level: RelayActivityLevel, message: string, details?: Record<string, unknown>): void {
  const entry: RelayActivity = details ? { at: new Date().toISOString(), level, message, details } : { at: new Date().toISOString(), level, message };
  stats.recent.unshift(entry);
  if (stats.recent.length > 100) stats.recent.length = 100;
}

export function incrementMessage(stats: RelayStats, type: string): void {
  stats.messages.total += 1;
  switch (type) {
    case "EVENT":
      stats.messages.event += 1;
      break;
    case "REQ":
      stats.messages.req += 1;
      break;
    case "CLOSE":
      stats.messages.close += 1;
      break;
    case "COUNT":
      stats.messages.count += 1;
      break;
    case "AUTH":
      stats.messages.auth += 1;
      break;
    case "NEG-OPEN":
      stats.messages.negOpen += 1;
      break;
    case "NEG-MSG":
      stats.messages.negMsg += 1;
      break;
    case "NEG-CLOSE":
      stats.messages.negClose += 1;
      break;
    default:
      stats.messages.unsupported += 1;
  }
}
