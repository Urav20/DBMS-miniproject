// The login and logout request handlers. The files in src/app/api/auth/ only plug the
// real dependencies into these functions; the tests plug in fakes.

import { AuthError } from "./errors.js";
import { DatabaseError } from "../db/errors.js";
import { getSessionSecret } from "./config.js";
import { buildClearedSessionCookie, buildSessionCookie } from "./cookies.js";
import { jsonResponse } from "./access.js";
import { createSessionToken } from "./session.js";
import { safeRedirectPath, validateLoginInput } from "./validation.js";

// Browsers send an Origin header on POST. If it names another site, refuse.
// (SameSite=Lax on the cookie is the main protection; this is a second layer.)
function isCrossSite(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

const crossSite = () =>
  jsonResponse(403, {
    error: { code: "AUTH_CROSS_SITE", message: "This request was not sent from this site." },
  });

export function createLoginHandler({
  authenticateUser, // ({ username, password }) -> { userId, role, username, fullName }
  getSecret = getSessionSecret,
  now = () => Date.now(),
  secureCookie = process.env.NODE_ENV === "production",
  logger = console,
}) {
  return async function POST(request) {
    if (isCrossSite(request)) return crossSite();

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, {
        error: { code: "AUTH_BAD_REQUEST", message: "The request was not valid." },
      });
    }

    const checked = validateLoginInput(body);
    if (!checked.ok) {
      return jsonResponse(400, {
        error: { code: "AUTH_BAD_REQUEST", message: checked.message },
      });
    }

    try {
      const user = await authenticateUser({
        username: checked.value.username,
        password: checked.value.password,
      });
      const token = createSessionToken(user, { secret: getSecret(), now: now() });
      return jsonResponse(
        200,
        {
          user: { username: user.username, fullName: user.fullName, role: user.role },
          redirectTo: safeRedirectPath(checked.value.next),
        },
        { "Set-Cookie": buildSessionCookie(token, { secure: secureCookie }) },
      );
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.status >= 500) logger.error("[tracex:auth]", { code: err.code, reason: err.reason });
        return jsonResponse(err.status, err.toResponseBody());
      }
      // Database problems: say only that sign-in is unavailable. The database helper
      // has already logged the detail on the server.
      if (err instanceof DatabaseError) {
        return jsonResponse(503, {
          error: {
            code: "AUTH_UNAVAILABLE",
            message: "Sign-in is not available right now. Please try again later.",
          },
        });
      }
      logger.error("[tracex:auth] unexpected error", { name: err?.name });
      return jsonResponse(500, {
        error: { code: "AUTH_ERROR", message: "Sign-in failed. Please try again." },
      });
    }
  };
}

// Logout removes the cookie from the browser. It works even if the session is already
// invalid, so a stale tab can always sign out.
export function createLogoutHandler({
  secureCookie = process.env.NODE_ENV === "production",
} = {}) {
  return async function POST(request) {
    if (isCrossSite(request)) return crossSite();
    return jsonResponse(
      200,
      { ok: true },
      { "Set-Cookie": buildClearedSessionCookie({ secure: secureCookie }) },
    );
  };
}
