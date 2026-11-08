// Session helpers for Server Components (pages and layouts).
// Server-side only: it reads the request's cookies.
//
//   const session = await requireSession();            // any signed-in user
//   const session = await requireRole(["admin"]);      // admin pages
//   await query(toDbSession(session), "SELECT ...");   // run SQL as that user

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { LOGIN_PATH, SESSION_COOKIE_NAME, getSessionSecret } from "./config.js";
import { hasRole } from "./access.js";
import { verifySessionToken } from "./session.js";

// The signed-in user or null.
export async function getCurrentSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token, { secret: getSessionSecret() });
}

// Sends visitors without a valid session to the login page.
export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) redirect(LOGIN_PATH);
  return session;
}

// Like requireSession, and also checks the role. A signed-in user with the wrong role
// gets the "not found" page, so the existence of admin-only pages is not revealed.
export async function requireRole(roles) {
  const session = await requireSession();
  if (!hasRole(session, roles)) notFound();
  return session;
}
