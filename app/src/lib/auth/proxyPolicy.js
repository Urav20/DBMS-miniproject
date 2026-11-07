// The routing rules used by src/proxy.js, kept free of Next.js so they can be tested.
// This is a quick first check (signature and expiry only). It is NOT the final
// authorization: pages call requireSession() and API routes call authorizeRequest().

import { DEFAULT_AFTER_LOGIN_PATH, LOGIN_PATH } from "./config.js";
import { readSessionToken } from "./cookies.js";
import { verifySessionToken } from "./session.js";
import { safeRedirectPath } from "./validation.js";

// API routes that must work without a session.
const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

// request = { pathname, search, cookieHeader }
// -> { action: "next" }
//  | { action: "redirect", to }
//  | { action: "unauthorized" }        (API: answer 401 JSON)
export function decideAccess({ pathname, search = "", cookieHeader }, { secret, now }) {
  const session = verifySessionToken(readSessionToken(cookieHeader), { secret, now });

  if (pathname === LOGIN_PATH) {
    if (!session) return { action: "next" };
    const next = new URLSearchParams(search).get("next");
    return { action: "redirect", to: safeRedirectPath(next, DEFAULT_AFTER_LOGIN_PATH) };
  }

  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API_PATHS.has(pathname)) return { action: "next" };
    return session ? { action: "next" } : { action: "unauthorized" };
  }

  // Every other page the proxy is attached to (the dashboard and what follows it).
  if (session) return { action: "next" };
  const target = safeRedirectPath(pathname + search, "");
  const to = target ? `${LOGIN_PATH}?next=${encodeURIComponent(target)}` : LOGIN_PATH;
  return { action: "redirect", to };
}
