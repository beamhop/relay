import type { PushTopic } from "@beamhop/sdk/admin-contract";
import { api } from "./api";

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const b64ToBytes = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  if (!reg) throw new Error("Service worker not registered — install the app or use a production build");
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const TOPICS_KEY = "beamhop:push-topics";
export const storedTopics = (): PushTopic[] => {
  try {
    return JSON.parse(localStorage.getItem(TOPICS_KEY) ?? "") as PushTopic[];
  } catch {
    return ["reports", "alerts"];
  }
};

export async function subscribePush(topics: PushTopic[]) {
  if (!pushSupported()) throw new Error("Push notifications are not supported in this browser");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was denied");
  const { publicKey } = await api.get<{ publicKey: string | null }>("/push/vapid");
  if (!publicKey) throw new Error("Push is not configured on the server");
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api.post("/push/subscribe", { subscription: sub.toJSON(), topics });
  localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
  return sub;
}

export async function unsubscribePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
