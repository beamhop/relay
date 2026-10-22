export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
export const runtimeName = isBun ? "bun" : "node";
export const nowSec = () => Math.floor(Date.now() / 1000);
