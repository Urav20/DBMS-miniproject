// First line of defence: runs before every page under /dashboard, every /api route
// and /login. It turns away requests without a valid session cookie. Pages and API
// routes still check the session themselves (see src/lib/auth/server.js and access.js).

import { NextResponse } from "next/server";
import { getSessionSecret } from "@/lib/auth/config";
import { decideAccess } from "@/lib/auth/proxyPolicy";

export function proxy(request) {
  const { pathname, search } = request.nextUrl;
  const decision = decideAccess(
    { pathname, search, cookieHeader: request.headers.get("cookie") },
    { secret: getSessionSecret(), now: Date.now() },
  );

  if (decision.action === "redirect") {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }
  if (decision.action === "unauthorized") {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.next();
}

// Static files and the public home page are not matched.
export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*", "/login"],
};
