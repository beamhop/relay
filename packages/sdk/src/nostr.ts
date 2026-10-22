export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey"> & { pubkey?: string };

/** NIP-01 filter. Tag filters are `#<single-letter>` keys. `search` is NIP-50. */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [tag: `#${string}`]: string[] | undefined;
}

export const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
export const isEphemeral = (k: number) => k >= 20000 && k < 30000;
export const isAddressable = (k: number) => k >= 30000 && k < 40000;
export const isRegular = (k: number) => !isReplaceable(k) && !isEphemeral(k) && !isAddressable(k);

export const getTag = (e: Pick<NostrEvent, "tags">, name: string) => e.tags.find((t) => t[0] === name)?.[1];
export const getDTag = (e: Pick<NostrEvent, "tags">) => getTag(e, "d") ?? "";
