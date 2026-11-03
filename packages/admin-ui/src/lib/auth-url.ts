import { safeUrl } from "./media-policy";

/**
 * NIP-46 `auth_url` handler. The URL comes from the remote signer (anyone reachable through the bunker relays), so
 * only http(s) URLs are shown or opened, and a fallback window gets no handle back to the panel.
 */
export function authUrlHandler(onAuthUrl?: (url: string) => void): (url: string) => void {
  return (u) => {
    const safe = safeUrl(u);
    if (!safe) return;
    if (onAuthUrl) onAuthUrl(safe);
    else window.open(safe, "_blank", "noopener,noreferrer");
  };
}
