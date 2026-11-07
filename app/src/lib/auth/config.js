// Authentication settings. Nothing here is secret except the value read by
// getSessionSecret(), and that comes from the environment (SESSION_SECRET), never
// from code. It is read when first needed, not at import time, so `next build`
// works on a machine that has no .env file.

import { AuthError } from "./errors.js";

export const SESSION_COOKIE_NAME = "tracex_session";

// A session lasts 8 hours from sign-in. It is signed, not stored in MySQL (the
// schema has no session table), so this expiry is also the longest a stolen or
// stale cookie can work.
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const LOGIN_PATH = "/login";
export const DEFAULT_AFTER_LOGIN_PATH = "/dashboard";

// Roles that may sign in. They are the same names as the database pools in
// src/lib/db/config.js, so a session { role, userId } can be passed straight to the
// database helper. The "worker" pool is for the background worker and has no
// signed-in person, so it is deliberately not here.
export const AUTH_ROLES = Object.freeze(["admin", "investigator"]);

// Maps `role.role_name` in MySQL to the database pool role.
// DEPENDENCY (Person A): the exact role_name values are not documented in
// TRACE-X_TEAM_CONTEXT.md (it says "Administrator" and "Investigator"). Check them
// against the seed data and edit this table if they differ. Any name that is not
// listed here cannot sign in (it fails closed).
const ROLE_NAME_TO_AUTH_ROLE = Object.freeze({
  administrator: "admin",
  investigator: "investigator",
});

export function mapRoleName(roleName) {
  if (typeof roleName !== "string") return null;
  const key = roleName.trim().toLowerCase();
  return Object.hasOwn(ROLE_NAME_TO_AUTH_ROLE, key) ? ROLE_NAME_TO_AUTH_ROLE[key] : null;
}

const MIN_SECRET_LENGTH = 32;

export function getSessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new AuthError(
      "AUTH_CONFIG",
      "Sign-in is not configured on the server.",
      {
        status: 500,
        reason: `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`,
      },
    );
  }
  return secret;
}
