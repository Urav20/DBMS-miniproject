// Signed session tokens (no database table needed, no extra package).
//
// A token is   base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature).
// The payload holds who the user is and when the session ends. It is signed, so the
// browser cannot change it, but it is not encrypted, so it holds no password hash and
// nothing secret.
//
// Limitation (also stated in the notes): because nothing is stored on the server, a
// session cannot be cancelled before it expires. Logout removes the cookie from the
// browser; the expiry time is the only server-side limit.

import { createHmac, timingSafeEqual } from "node:crypto";
import { validateSession } from "../db/client.js";
import { AUTH_ROLES, SESSION_MAX_AGE_SECONDS } from "./config.js";

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 2048;
const CLOCK_SKEW_SECONDS = 60;

const sign = (body, secret) =>
  createHmac("sha256", secret).update(body).digest("base64url");

// user = { userId, role, username, fullName }
export function createSessionToken(
  user,
  { secret, now = Date.now(), maxAgeSeconds = SESSION_MAX_AGE_SECONDS } = {},
) {
  if (!secret) throw new Error("createSessionToken requires a secret.");
  // Same rules the database helper applies: positive whole user ID, known role.
  validateSession({ role: user.role, userId: user.userId });
  if (!AUTH_ROLES.includes(user.role)) throw new Error("This role cannot have a session.");

  const iat = Math.floor(now / 1000);
  const payload = {
    v: TOKEN_VERSION,
    uid: user.userId,
    role: user.role,
    usr: String(user.username),
    name: String(user.fullName ?? ""),
    iat,
    exp: iat + maxAgeSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

// Returns { userId, role, username, fullName, expiresAt } or null.
// null means "not signed in" for every reason: missing, malformed, tampered, signed
// with another secret, expired, or carrying an unknown role. The caller never needs
// to know which.
export function verifySessionToken(token, { secret, now = Date.now() } = {}) {
  if (!secret) throw new Error("verifySessionToken requires a secret.");
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let p;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || p.v !== TOKEN_VERSION) return null;
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null;
  if (typeof p.usr !== "string" || typeof p.name !== "string") return null;
  if (!AUTH_ROLES.includes(p.role)) return null;

  const nowSeconds = Math.floor(now / 1000);
  if (p.exp <= nowSeconds) return null; // expired
  if (p.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null; // issued in the future
  if (p.exp - p.iat > SESSION_MAX_AGE_SECONDS) return null; // longer than we ever issue

  try {
    validateSession({ role: p.role, userId: p.uid });
  } catch {
    return null;
  }
  return {
    userId: p.uid,
    role: p.role,
    username: p.usr,
    fullName: p.name,
    expiresAt: p.exp * 1000,
  };
}
