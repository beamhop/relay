import { HEX_32_RE } from "./crypto";
import type { NostrEvent, RelayConfig, ValidationResult } from "./types";

interface ReasonRecord {
  value: string;
  reason: string;
}

interface RpcRequest {
  method?: string;
  params?: unknown[];
}

export class ManagementState {
  readonly bannedPubkeys = new Map<string, string>();
  readonly allowedPubkeys = new Map<string, string>();
  readonly bannedEvents = new Map<string, string>();
  readonly allowedKinds = new Set<number>();
  readonly blockedIps = new Map<string, string>();

  validateEvent(event: NostrEvent): ValidationResult {
    const bannedPubkey = this.bannedPubkeys.get(event.pubkey);
    if (bannedPubkey !== undefined) return { ok: false, prefix: "blocked", message: bannedPubkey || "pubkey is banned" };
    if (this.allowedPubkeys.size > 0 && !this.allowedPubkeys.has(event.pubkey)) {
      return { ok: false, prefix: "restricted", message: "pubkey is not allowlisted" };
    }
    const bannedEvent = this.bannedEvents.get(event.id);
    if (bannedEvent !== undefined) return { ok: false, prefix: "blocked", message: bannedEvent || "event is banned" };
    if (this.allowedKinds.size > 0 && !this.allowedKinds.has(event.kind)) {
      return { ok: false, prefix: "restricted", message: "event kind is not allowlisted" };
    }
    return { ok: true };
  }

  isIpBlocked(ip: string | undefined): boolean {
    return Boolean(ip && this.blockedIps.has(ip));
  }

  snapshot(): ManagementSnapshot {
    return {
      bannedPubkeys: listPubkeyMap(this.bannedPubkeys),
      allowedPubkeys: listPubkeyMap(this.allowedPubkeys),
      bannedEvents: [...this.bannedEvents.entries()].map(([id, reason]) => ({ id, reason })),
      allowedKinds: [...this.allowedKinds].sort((a, b) => a - b),
      blockedIps: [...this.blockedIps.entries()].map(([ip, reason]) => ({ ip, reason })),
    };
  }

  async handleRpc(request: RpcRequest, config: RelayConfig): Promise<Response> {
    const method = request.method;
    const params = Array.isArray(request.params) ? request.params : [];
    if (!method) return rpcError("missing method");

    try {
      switch (method) {
        case "supportedmethods":
          return rpcResult(SUPPORTED_METHODS.filter((name) => name !== "supportedmethods"));
        case "banpubkey":
          this.setPubkey(this.bannedPubkeys, params);
          return rpcResult(true);
        case "unbanpubkey":
          this.deletePubkey(this.bannedPubkeys, params);
          return rpcResult(true);
        case "listbannedpubkeys":
          return rpcResult(listPubkeyMap(this.bannedPubkeys));
        case "allowpubkey":
          this.setPubkey(this.allowedPubkeys, params);
          return rpcResult(true);
        case "unallowpubkey":
          this.deletePubkey(this.allowedPubkeys, params);
          return rpcResult(true);
        case "listallowedpubkeys":
          return rpcResult(listPubkeyMap(this.allowedPubkeys));
        case "listeventsneedingmoderation":
          return rpcResult([]);
        case "allowevent":
          this.requireEventId(params);
          this.bannedEvents.delete(params[0] as string);
          return rpcResult(true);
        case "banevent":
          this.setEvent(this.bannedEvents, params);
          return rpcResult(true);
        case "listbannedevents":
          return rpcResult([...this.bannedEvents.entries()].map(([id, reason]) => ({ id, reason })));
        case "changerelayname":
          config.relay.name = requireString(params[0], "name");
          return rpcResult(true);
        case "changerelaydescription":
          config.relay.description = requireString(params[0], "description");
          return rpcResult(true);
        case "changerelayicon":
          config.relay.icon = requireString(params[0], "icon");
          return rpcResult(true);
        case "allowkind":
          this.allowedKinds.add(requireKind(params[0]));
          return rpcResult(true);
        case "disallowkind":
          this.allowedKinds.delete(requireKind(params[0]));
          return rpcResult(true);
        case "listallowedkinds":
          return rpcResult([...this.allowedKinds].sort((a, b) => a - b));
        case "blockip":
          this.blockedIps.set(requireString(params[0], "ip"), optionalReason(params));
          return rpcResult(true);
        case "unblockip":
          this.blockedIps.delete(requireString(params[0], "ip"));
          return rpcResult(true);
        case "listblockedips":
          return rpcResult([...this.blockedIps.entries()].map(([ip, reason]) => ({ ip, reason })));
        default:
          return rpcError(`unsupported method: ${method}`);
      }
    } catch (error) {
      return rpcError(error instanceof Error ? error.message : String(error));
    }
  }

  private setPubkey(map: Map<string, string>, params: unknown[]): void {
    const pubkey = requireString(params[0], "pubkey");
    if (!HEX_32_RE.test(pubkey)) throw new Error("pubkey must be lowercase 32-byte hex");
    map.set(pubkey, optionalReason(params));
  }

  private deletePubkey(map: Map<string, string>, params: unknown[]): void {
    const pubkey = requireString(params[0], "pubkey");
    if (!HEX_32_RE.test(pubkey)) throw new Error("pubkey must be lowercase 32-byte hex");
    map.delete(pubkey);
  }

  private setEvent(map: Map<string, string>, params: unknown[]): void {
    const id = this.requireEventId(params);
    map.set(id, optionalReason(params));
  }

  private requireEventId(params: unknown[]): string {
    const id = requireString(params[0], "event id");
    if (!HEX_32_RE.test(id)) throw new Error("event id must be lowercase 32-byte hex");
    return id;
  }
}

export interface ManagementSnapshot {
  bannedPubkeys: Array<{ pubkey: string; reason: string }>;
  allowedPubkeys: Array<{ pubkey: string; reason: string }>;
  bannedEvents: Array<{ id: string; reason: string }>;
  allowedKinds: number[];
  blockedIps: Array<{ ip: string; reason: string }>;
}

const SUPPORTED_METHODS = [
  "supportedmethods",
  "banpubkey",
  "unbanpubkey",
  "listbannedpubkeys",
  "allowpubkey",
  "unallowpubkey",
  "listallowedpubkeys",
  "listeventsneedingmoderation",
  "allowevent",
  "banevent",
  "listbannedevents",
  "changerelayname",
  "changerelaydescription",
  "changerelayicon",
  "allowkind",
  "disallowkind",
  "listallowedkinds",
  "blockip",
  "unblockip",
  "listblockedips",
];

function rpcResult(result: unknown): Response {
  return jsonResponse({ result });
}

function rpcError(error: string, status = 400): Response {
  return jsonResponse({ result: null, error }, status);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

function listPubkeyMap(map: Map<string, string>): Array<{ pubkey: string; reason: string }> {
  return [...map.entries()].map(([pubkey, reason]) => ({ pubkey, reason }));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function optionalReason(params: unknown[]): string {
  return typeof params[1] === "string" ? params[1] : "";
}

function requireKind(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65535) throw new Error("kind must be an integer between 0 and 65535");
  return value as number;
}
