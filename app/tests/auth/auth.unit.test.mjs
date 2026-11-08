// Unit tests for authentication and session management. They use fake user lookups,
// need no MySQL server, no network and no .env file.
//
// Run:  npm run test:auth
//
// Passwords below are generated at run time for the tests only; they are not real
// credentials and nothing here talks to a database.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, getSessionSecret, mapRoleName } from "../../src/lib/auth/config.js";
import { createSessionToken, verifySessionToken } from "../../src/lib/auth/session.js";
import { authenticate } from "../../src/lib/auth/service.js";
import { validateLoginInput, safeRedirectPath } from "../../src/lib/auth/validation.js";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from "../../src/lib/auth/cookies.js";
import { authorizeRequest, hasRole, toDbSession } from "../../src/lib/auth/access.js";
import { decideAccess } from "../../src/lib/auth/proxyPolicy.js";
import { createLoginHandler, createLogoutHandler } from "../../src/lib/auth/handlers.js";
import { AuthError } from "../../src/lib/auth/errors.js";
import { DatabaseError } from "../../src/lib/db/errors.js";

const SECRET = randomBytes(32).toString("hex");
const OTHER_SECRET = randomBytes(32).toString("hex");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const GOOD_PASSWORD = `pw-${randomBytes(8).toString("hex")}`;
// Low cost so the tests stay fast (the app accepts any bcrypt cost).
const GOOD_HASH = bcrypt.hashSync(GOOD_PASSWORD, 4);

const row = (over = {}) => ({
  user_id: 7,
  username: "analyst1",
  full_name: "Test Analyst",
  password_hash: GOOD_HASH,
  is_active: 1,
  role_name: "Investigator",
  ...over,
});
// Fake lookup: returns the row only for the exact username it was built with.
const lookup = (r) => async (username) => (r && username === r.username ? r : null);
const reasonOf = (e) => e.reason;

// ------------------------------------------------------------------ login

test("valid login returns the user and no password hash", async () => {
  const user = await authenticate(
    { username: "analyst1", password: GOOD_PASSWORD },
    { findUser: lookup(row()) },
  );
  assert.deepEqual(user, { userId: 7, role: "investigator", username: "analyst1", fullName: "Test Analyst" });
  assert.doesNotMatch(JSON.stringify(user), /\$2[aby]\$/);
});

test("a hash written by Python's bcrypt ($2b$) is accepted", async () => {
  // A $2b$ hash (what Python's bcrypt writes). Built here from the library with the 2b prefix.
  const hash = bcrypt.hashSync(GOOD_PASSWORD, 4).replace(/^\$2[aby]\$/, "$2b$");
  assert.match(hash, /^\$2b\$/);
  const user = await authenticate({ username: "analyst1", password: GOOD_PASSWORD }, { findUser: lookup(row({ password_hash: hash })) });
  assert.equal(user.userId, 7);
});

test("administrator role maps to the admin pool", async () => {
  const user = await authenticate(
    { username: "analyst1", password: GOOD_PASSWORD },
    { findUser: lookup(row({ role_name: "Administrator" })) },
  );
  assert.equal(user.role, "admin");
});

test("invalid password is rejected with the generic message", async () => {
  await assert.rejects(
    authenticate({ username: "analyst1", password: "not-the-password" }, { findUser: lookup(row()) }),
    (e) => e instanceof AuthError && e.code === "AUTH_INVALID_CREDENTIALS" && e.status === 401 && reasonOf(e) === "wrong password",
  );
});

test("unknown user gets exactly the same error as a wrong password", async () => {
  let wrong, unknown;
  await authenticate({ username: "analyst1", password: "nope" }, { findUser: lookup(row()) }).catch((e) => (wrong = e));
  await authenticate({ username: "ghost", password: "nope" }, { findUser: lookup(row()) }).catch((e) => (unknown = e));
  assert.equal(unknown.code, wrong.code);
  assert.equal(unknown.message, wrong.message);
  assert.equal(unknown.status, wrong.status);
  assert.equal(reasonOf(unknown), "unknown user"); // for server logs only
  assert.deepEqual(unknown.toResponseBody(), wrong.toResponseBody());
});

test("deactivated account cannot sign in, even with the right password, and looks like a wrong password", async () => {
  await assert.rejects(
    authenticate({ username: "analyst1", password: GOOD_PASSWORD }, { findUser: lookup(row({ is_active: 0 })) }),
    (e) => e.code === "AUTH_INVALID_CREDENTIALS" && e.message === "Incorrect username or password.",
  );
});

test("a role name with no database pool mapping cannot sign in", async () => {
  for (const role_name of ["Auditor", "worker", "", null, "admin; DROP TABLE x"]) {
    await assert.rejects(
      authenticate({ username: "analyst1", password: GOOD_PASSWORD }, { findUser: lookup(row({ role_name })) }),
      (e) => e.code === "AUTH_ROLE_UNSUPPORTED" && e.status === 403,
    );
  }
  assert.equal(mapRoleName("__proto__"), null);
  assert.equal(mapRoleName("constructor"), null);
});

test("a stored value that is not a bcrypt hash never matches", async () => {
  for (const password_hash of ["", "plaintext", GOOD_PASSWORD, null, "$2b$04$short"]) {
    await assert.rejects(
      authenticate({ username: "analyst1", password: GOOD_PASSWORD }, { findUser: lookup(row({ password_hash })) }),
      (e) => e.code === "AUTH_INVALID_CREDENTIALS",
    );
  }
});

test("a bad user_id in the database is refused instead of becoming a session", async () => {
  for (const user_id of [0, -1, "abc", null, 4294967296]) {
    await assert.rejects(
      authenticate({ username: "analyst1", password: GOOD_PASSWORD }, { findUser: lookup(row({ user_id })) }),
      (e) => e.code === "AUTH_BAD_USER_RECORD",
    );
  }
});

// ------------------------------------------------------ missing / malformed input

test("missing or malformed credentials are rejected before any lookup", () => {
  const bad = [
    undefined, null, "text", 5, [], {},
    { username: "a" }, { password: "x" },
    { username: "", password: "x" }, { username: "   ", password: "x" },
    { username: "a", password: "" },
    { username: 5, password: "x" }, { username: "a", password: {} },
    { username: ["a"], password: "x" },
    { username: "a".repeat(51), password: "x" },
    { username: "bad\nname", password: "x" },
    { username: "a", password: "p".repeat(73) },
    { username: "a", password: "é".repeat(37) }, // 74 bytes
  ];
  for (const body of bad) {
    const r = validateLoginInput(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(typeof r.message, "string");
  }
  const ok = validateLoginInput({ username: "  analyst1 ", password: " pass with spaces ", next: "/dashboard" });
  assert.deepEqual(ok, { ok: true, value: { username: "analyst1", password: " pass with spaces ", next: "/dashboard" } });
});

test("hostile usernames reach the lookup only as plain values", async () => {
  const seen = [];
  const evil = "x' OR '1'='1";
  await authenticate({ username: evil, password: "p" }, { findUser: async (u) => (seen.push(u), null) }).catch(() => {});
  assert.deepEqual(seen, [evil]);
});

test("safeRedirectPath allows only paths on this site", () => {
  assert.equal(safeRedirectPath("/dashboard"), "/dashboard");
  assert.equal(safeRedirectPath("/dashboard/x?y=1"), "/dashboard/x?y=1");
  for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "dashboard", "", undefined, null, 5, "/login", "/api/auth/logout", "/a\nb", "/" + "a".repeat(600)]) {
    assert.equal(safeRedirectPath(bad), "/dashboard", String(bad));
  }
});

// ---------------------------------------------------------------- session token

const user = { userId: 7, role: "investigator", username: "analyst1", fullName: "Test Analyst" };

test("session token round-trips and carries no secrets", () => {
  const token = createSessionToken(user, { secret: SECRET, now: NOW });
  const s = verifySessionToken(token, { secret: SECRET, now: NOW + 1000 });
  assert.deepEqual({ ...s }, { userId: 7, role: "investigator", username: "analyst1", fullName: "Test Analyst", expiresAt: NOW + SESSION_MAX_AGE_SECONDS * 1000 });
  const payload = Buffer.from(token.split(".")[0], "base64url").toString();
  assert.doesNotMatch(payload, /hash|password|secret/i);
  assert.ok(!token.includes(SECRET));
});

test("expired session is rejected (and a session still inside its time is accepted)", () => {
  const token = createSessionToken(user, { secret: SECRET, now: NOW });
  const end = NOW + SESSION_MAX_AGE_SECONDS * 1000;
  assert.ok(verifySessionToken(token, { secret: SECRET, now: end - 1000 }));
  assert.equal(verifySessionToken(token, { secret: SECRET, now: end }), null);
  assert.equal(verifySessionToken(token, { secret: SECRET, now: end + 86400000 }), null);
});

test("tampered, forged, foreign-secret and malformed tokens are all rejected", () => {
  const token = createSessionToken(user, { secret: SECRET, now: NOW });
  const [body, sig] = token.split(".");
  const at = { secret: SECRET, now: NOW + 1000 };

  // Edited payload (role changed to admin) with the old signature.
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), role: "admin" })).toString("base64url");
  assert.equal(verifySessionToken(`${forgedBody}.${sig}`, at), null);
  // Flipped signature, truncated signature, no signature.
  assert.equal(verifySessionToken(`${body}.${sig.slice(0, -2)}AA`, at), null);
  assert.equal(verifySessionToken(`${body}.${sig.slice(1)}`, at), null);
  assert.equal(verifySessionToken(body, at), null);
  // Signed with a different secret.
  assert.equal(verifySessionToken(createSessionToken(user, { secret: OTHER_SECRET, now: NOW }), at), null);
  // Garbage.
  for (const bad of [undefined, null, 0, {}, "", ".", "a.b.c", "abc", "x".repeat(5000), "..", `${body}.`]) {
    assert.equal(verifySessionToken(bad, at), null, String(bad));
  }
});

test("a correctly signed token with an invalid payload is rejected", () => {
  const sign = (obj) => {
    // Re-sign an arbitrary payload with the real secret, in the token format.
    const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
    const sig = createSessionTokenSignature(body);
    return `${body}.${sig}`;
  };
  const base = { v: 1, uid: 7, role: "investigator", usr: "a", name: "A", iat: NOW / 1000, exp: NOW / 1000 + 3600 };
  const at = { secret: SECRET, now: NOW + 1000 };
  assert.ok(verifySessionToken(sign(base), at), "control: the helper really produces a valid token");
  for (const patch of [
    { role: "root" }, { role: "worker" }, { uid: 0 }, { uid: "7" }, { uid: 1.5 }, { v: 2 },
    { exp: NOW / 1000 + SESSION_MAX_AGE_SECONDS * 5 }, { iat: NOW / 1000 + 99999 },
    { usr: 5 }, { name: null }, { exp: "soon" },
  ]) {
    assert.equal(verifySessionToken(sign({ ...base, ...patch }), at), null, JSON.stringify(patch));
  }
});

function createSessionTokenSignature(body) {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

test("sessions cannot be created for the worker role or an invalid user ID", () => {
  assert.throws(() => createSessionToken({ ...user, role: "worker" }, { secret: SECRET }));
  assert.throws(() => createSessionToken({ ...user, userId: 0 }, { secret: SECRET }));
  assert.throws(() => createSessionToken(user, {}), /secret/);
});

test("SESSION_SECRET must be present and long enough; the message never prints it", () => {
  for (const env of [{}, { SESSION_SECRET: "" }, { SESSION_SECRET: "short" }, { SESSION_SECRET: " ".repeat(40) }]) {
    assert.throws(() => getSessionSecret(env), (e) => e.code === "AUTH_CONFIG" && !/short/.test(e.message));
  }
  assert.equal(getSessionSecret({ SESSION_SECRET: SECRET }), SECRET);
});

// -------------------------------------------------------------------- cookies

test("session cookie is HttpOnly, SameSite=Lax, path /, with an expiry; Secure when asked", () => {
  const plain = buildSessionCookie("tok", { secure: false });
  assert.match(plain, new RegExp(`^${SESSION_COOKIE_NAME}=tok;`));
  for (const part of ["Path=/", `Max-Age=${SESSION_MAX_AGE_SECONDS}`, "HttpOnly", "SameSite=Lax"]) assert.ok(plain.includes(part), part);
  assert.ok(!plain.includes("Secure"));
  assert.ok(buildSessionCookie("tok", { secure: true }).includes("; Secure"));
});

test("cleared cookie expires immediately", () => {
  const c = buildClearedSessionCookie({ secure: true });
  assert.match(c, new RegExp(`^${SESSION_COOKIE_NAME}=;`));
  assert.ok(c.includes("Max-Age=0") && c.includes("HttpOnly") && c.includes("Secure"));
});

test("readSessionToken finds the cookie among others and ignores look-alikes", () => {
  assert.equal(readSessionToken(`a=1; ${SESSION_COOKIE_NAME}=abc.def; b=2`), "abc.def");
  assert.equal(readSessionToken(`x${SESSION_COOKIE_NAME}=zzz`), null);
  assert.equal(readSessionToken(`${SESSION_COOKIE_NAME}=`), null);
  for (const bad of [null, undefined, "", "junk", 5]) assert.equal(readSessionToken(bad), null);
});

// ------------------------------------------------- authorization (API helpers)

const requestWith = (token, extra = {}) =>
  new Request("http://localhost/api/x", {
    headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
    ...extra,
  });
const tokenFor = (u, now = NOW) => createSessionToken(u, { secret: SECRET, now });
const at = { secret: SECRET, now: NOW + 1000 };

test("API: no cookie, garbage cookie and expired cookie all give 401", async () => {
  for (const req of [
    requestWith(null),
    requestWith("garbage"),
    requestWith(tokenFor(user, NOW - (SESSION_MAX_AGE_SECONDS + 10) * 1000)),
  ]) {
    const r = authorizeRequest(req, at);
    assert.equal(r.ok, false);
    assert.equal(r.response.status, 401);
    assert.equal((await r.response.json()).error.code, "AUTH_REQUIRED");
    assert.equal(r.response.headers.get("cache-control"), "no-store");
  }
});

test("API: valid session passes and gives the database session shape", () => {
  const r = authorizeRequest(requestWith(tokenFor(user)), at);
  assert.equal(r.ok, true);
  assert.deepEqual(toDbSession(r.session), { role: "investigator", userId: 7 });
});

test("role restrictions: investigator is refused admin-only endpoints, admin is allowed", async () => {
  const inv = authorizeRequest(requestWith(tokenFor(user)), { ...at, roles: ["admin"] });
  assert.equal(inv.ok, false);
  assert.equal(inv.response.status, 403);
  assert.equal((await inv.response.json()).error.code, "AUTH_FORBIDDEN");

  const admin = authorizeRequest(requestWith(tokenFor({ ...user, userId: 1, role: "admin" })), { ...at, roles: ["admin"] });
  assert.equal(admin.ok, true);
  assert.equal(authorizeRequest(requestWith(tokenFor(user)), { ...at, roles: ["admin", "investigator"] }).ok, true);
  assert.equal(authorizeRequest(requestWith(tokenFor(user)), { ...at, roles: [] }).ok, false);
  assert.equal(hasRole({ role: "admin" }, undefined), true);
  assert.equal(hasRole(null, undefined), false);
  assert.equal(hasRole({ role: "admin" }, "admin"), false, "roles must be an array");
});

test("a role edited inside the cookie does not grant access", () => {
  const [body, sig] = tokenFor(user).split(".");
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), role: "admin" })).toString("base64url");
  assert.equal(authorizeRequest(requestWith(`${edited}.${sig}`), { ...at, roles: ["admin"] }).response.status, 401);
});

// ------------------------------------------------------- proxy routing rules

const cookieFor = (t) => `${SESSION_COOKIE_NAME}=${t}`;
const decide = (pathname, cookieHeader, search = "") => decideAccess({ pathname, search, cookieHeader }, at);

test("proxy: pages need a session; the visitor is sent to /login with a safe return path", () => {
  assert.deepEqual(decide("/dashboard", null), { action: "redirect", to: "/login?next=%2Fdashboard" });
  assert.deepEqual(decide("/dashboard/cases", "junk=1", "?page=2"), { action: "redirect", to: "/login?next=%2Fdashboard%2Fcases%3Fpage%3D2" });
  assert.deepEqual(decide("/dashboard", cookieFor("tampered.token")), { action: "redirect", to: "/login?next=%2Fdashboard" });
  assert.deepEqual(decide("/dashboard", cookieFor(tokenFor(user))), { action: "next" });
});

test("proxy: API needs a session except login and logout", () => {
  assert.deepEqual(decide("/api/cases", null), { action: "unauthorized" });
  assert.deepEqual(decide("/api/cases", cookieFor("bad")), { action: "unauthorized" });
  assert.deepEqual(decide("/api/cases", cookieFor(tokenFor(user))), { action: "next" });
  assert.deepEqual(decide("/api/auth/login", null), { action: "next" });
  assert.deepEqual(decide("/api/auth/logout", null), { action: "next" });
  assert.deepEqual(decide("/api/auth/other", null), { action: "unauthorized" });
});

test("proxy: signed-in visitors skip the login page; others see it", () => {
  assert.deepEqual(decide("/login", null), { action: "next" });
  assert.deepEqual(decide("/login", cookieFor(tokenFor(user))), { action: "redirect", to: "/dashboard" });
  assert.deepEqual(decide("/login", cookieFor(tokenFor(user)), "?next=https://evil.test"), { action: "redirect", to: "/dashboard" });
  assert.deepEqual(decide("/login", cookieFor(tokenFor(user)), "?next=%2Fdashboard%2Fx"), { action: "redirect", to: "/dashboard/x" });
});

// ------------------------------------------------------------ route handlers

const post = (url, body, headers = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const silent = { error() {} };
function loginHandler(findUser, extra = {}) {
  return createLoginHandler({
    authenticateUser: (input) => authenticate(input, { findUser }),
    getSecret: () => SECRET,
    now: () => NOW,
    secureCookie: false,
    logger: silent,
    ...extra,
  });
}

test("login handler: valid login sets a signed HttpOnly cookie that authorizes later requests", async () => {
  const res = await loginHandler(lookup(row()))(post("http://localhost:3000/api/auth/login", { username: "analyst1", password: GOOD_PASSWORD, next: "/dashboard/x" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { user: { username: "analyst1", fullName: "Test Analyst", role: "investigator" }, redirectTo: "/dashboard/x" });
  assert.doesNotMatch(JSON.stringify(body), /\$2|hash|password/i);

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"));
  assert.equal(res.headers.get("cache-control"), "no-store");

  const token = readSessionToken(setCookie.split(";")[0]);
  const auth = authorizeRequest(requestWith(token), { secret: SECRET, now: NOW + 1000 });
  assert.equal(auth.ok, true);
  assert.equal(auth.session.userId, 7);
});

test("login handler: Secure flag follows the secureCookie setting", async () => {
  const res = await loginHandler(lookup(row()), { secureCookie: true })(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD }));
  assert.ok(res.headers.get("set-cookie").includes("; Secure"));
});

test("login handler: wrong password and unknown user give identical 401 responses and no cookie", async () => {
  const h = loginHandler(lookup(row()));
  const a = await h(post("http://localhost:3000/x", { username: "analyst1", password: "wrong" }));
  const b = await h(post("http://localhost:3000/x", { username: "ghost", password: "wrong" }));
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(a.headers.get("set-cookie"), null);
  assert.equal(b.headers.get("set-cookie"), null);
});

test("login handler: malformed bodies give 400 and never reach the lookup", async () => {
  let calls = 0;
  const h = loginHandler(async () => (calls++, null));
  const url = "http://localhost:3000/x";
  for (const body of ["not json", "", "null", "[]", "{}", '{"username":"a"}', '{"username":1,"password":2}', JSON.stringify({ username: "a", password: "p".repeat(80) })]) {
    const res = await h(post(url, body));
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error.code, "AUTH_BAD_REQUEST");
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal(calls, 0);
});

test("login handler: open-redirect values are replaced by /dashboard", async () => {
  const res = await loginHandler(lookup(row()))(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD, next: "https://evil.test" }));
  assert.equal((await res.json()).redirectTo, "/dashboard");
});

test("login handler: a request from another site is refused", async () => {
  const res = await loginHandler(lookup(row()))(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD }, { origin: "https://evil.test" }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
  const same = await loginHandler(lookup(row()))(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD }, { origin: "http://localhost:3000" }));
  assert.equal(same.status, 200);
});

test("login handler: database trouble gives a generic 503 with no database details", async () => {
  const boom = async () => {
    throw new DatabaseError("DB_UNAVAILABLE", "The database is not reachable right now.", { status: 503 });
  };
  const res = await loginHandler(boom)(post("http://localhost:3000/x", { username: "analyst1", password: "x" }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "AUTH_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /database|mysql|tracex_/i);
});

test("login handler: missing SESSION_SECRET is a 500 that names no value", async () => {
  const h = loginHandler(lookup(row()), { getSecret: () => getSessionSecret({}) });
  const res = await h(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD }));
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login handler: unsupported role gives 403 and no cookie", async () => {
  const res = await loginHandler(lookup(row({ role_name: "Auditor" })))(post("http://localhost:3000/x", { username: "analyst1", password: GOOD_PASSWORD }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("logout: clears the cookie, works with or without a valid session, refuses other sites", async () => {
  const logout = createLogoutHandler({ secureCookie: false });
  for (const headers of [{}, { cookie: `${SESSION_COOKIE_NAME}=garbage` }, { cookie: cookieFor(tokenFor(user)) }]) {
    const res = await logout(post("http://localhost:3000/api/auth/logout", {}, headers));
    assert.equal(res.status, 200);
    const c = res.headers.get("set-cookie");
    assert.ok(c.startsWith(`${SESSION_COOKIE_NAME}=;`) && c.includes("Max-Age=0"));
  }
  const cross = await logout(post("http://localhost:3000/api/auth/logout", {}, { origin: "https://evil.test" }));
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get("set-cookie"), null);
});

test("after logout the browser holds no valid session", () => {
  // The browser drops a cookie with Max-Age=0, so the next request carries no token.
  assert.equal(authorizeRequest(requestWith(null), at).response.status, 401);
  assert.deepEqual(decide("/dashboard", null).action, "redirect");
});
