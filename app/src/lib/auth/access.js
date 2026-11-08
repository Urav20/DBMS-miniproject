// Server-side authorization helpers for Route Handlers (API endpoints).
// They use only standard Request/Response objects.
//
//   import { authorizeRequest, toDbSession } from "@/lib/auth/access";
//   import { query } from "@/lib/db";
//
//   export async function GET(request) {
//     const auth = authorizeRequest(request, { roles: ["admin"] });   // or omit roles: any signed-in user
//     if (!auth.ok) return auth.response;                             // 401 or 403
//     const rows = await query(toDbSession(auth.session), "SELECT ... FROM v_my_cases");
//     return Response.json({ rows });
//   }
//
// The proxy (src/proxy.js) only does a quick first check. Every API endpoint must
// still call authorizeRequest itself: this is the check that counts.

import { getSessionSecret } from "./config.js";
import { readSessionToken } from "./cookies.js";
import { verifySessionToken } from "./session.js";

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonResponse(status, body, headers = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function hasRole(session, roles) {
  if (!session) return false;
  if (roles === undefined) return true; // any signed-in user
  return Array.isArray(roles) && roles.includes(session.role);
}

// The { role, userId } shape that src/lib/db expects. The role picks the MySQL pool,
// so an investigator's request can never run on the admin connection.
export function toDbSession(session) {
  return { role: session.role, userId: session.userId };
}

export function getSessionFromRequest(request, { secret = getSessionSecret(), now } = {}) {
  const token = readSessionToken(request.headers.get("cookie"));
  return verifySessionToken(token, { secret, now });
}

// -> { ok: true, session } | { ok: false, response }
export function authorizeRequest(request, { roles, secret, now } = {}) {
  const session = getSessionFromRequest(request, { secret, now });
  if (!session) {
    return {
      ok: false,
      response: jsonResponse(401, {
        error: { code: "AUTH_REQUIRED", message: "Sign in to continue." },
      }),
    };
  }
  if (!hasRole(session, roles)) {
    return {
      ok: false,
      response: jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Your role is not allowed to do this.",
        },
      }),
    };
  }
  return { ok: true, session };
}
