// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web push subscription hook ("Enable phone alerts"). The service worker
 * (`static/push-sw.js`, imported by the generated worker) shows the
 * notifications. The VAPID key and the subscription are exchanged through
 * actions, so this works as soon as an alerts module registers them.
 */
import type { ApiClient } from './api/client.ts';
import type { CatalogAction } from './api/types.ts';

/** Action ids provided by the alerts module. */
export const PUSH_KEY_ACTION = 'alerts.push-key';
export const PUSH_SUBSCRIBE_ACTION = 'alerts.subscribe-push';

export type PushResult = 'enabled' | 'denied' | 'unsupported' | 'unavailable';

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(api: ApiClient, catalog: CatalogAction[]): Promise<PushResult> {
  if (!pushSupported()) return 'unsupported';
  const keyAction = catalog.find((a) => a.id === PUSH_KEY_ACTION);
  const subAction = catalog.find((a) => a.id === PUSH_SUBSCRIBE_ACTION);
  if (!keyAction || !subAction) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const { output } = await api.run<{ publicKey: string }>(keyAction.id, {}, keyAction.scope);
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(output.publicKey),
    }));
  const json = sub.toJSON();
  await api.run(subAction.id, { endpoint: json.endpoint, keys: json.keys }, subAction.scope);
  return 'enabled';
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
