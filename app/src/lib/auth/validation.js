// Input checks for the login request and for the "where to go after sign-in" value.

import { DEFAULT_AFTER_LOGIN_PATH } from "./config.js";

const MAX_USERNAME_LENGTH = 50; // app_user.username is VARCHAR(50)
const MAX_PASSWORD_BYTES = 72; // bcrypt only uses the first 72 bytes

// body = parsed JSON. Returns { ok: true, value: { username, password, next } }
// or { ok: false, message }.
export function validateLoginInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Enter a username and a password." };
  }
  const { username, password, next } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, message: "Enter a username and a password." };
  }
  const name = username.trim();
  if (name.length === 0) return { ok: false, message: "Enter your username." };
  if (password.length === 0) return { ok: false, message: "Enter your password." };
  if (name.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: "The username is not valid." };
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return { ok: false, message: "The password is too long." };
  }
  return {
    ok: true,
    value: { username: name, password, next: typeof next === "string" ? next : undefined },
  };
}

// Only a path on this site is allowed (blocks open redirects such as
// "https://evil.test", "//evil.test" and "/\evil.test").
export function safeRedirectPath(value, fallback = DEFAULT_AFTER_LOGIN_PATH) {
  if (typeof value !== "string" || value.length > 500) return fallback;
  if (!/^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/.test(value)) return fallback;
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/api/")) {
    return fallback;
  }
  return value;
}
