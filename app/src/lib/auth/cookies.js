// Builds and reads the session cookie by hand, so it can be unit-tested without
// Next.js. Settings:
//   HttpOnly   page scripts cannot read it
//   SameSite=Lax  not sent on cross-site POST requests (blocks CSRF on login/logout and
//                 on every write endpoint)
//   Secure     only over HTTPS, switched on when NODE_ENV is "production"
//   Path=/     sent to pages and API routes

import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "./config.js";

const isSecureByDefault = () => process.env.NODE_ENV === "production";

export function buildSessionCookie(token, { secure = isSecureByDefault() } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function buildClearedSessionCookie({ secure = isSecureByDefault() } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// Finds the session token in a request's Cookie header, or returns null.
export function readSessionToken(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(i + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
