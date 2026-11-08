// Error type for authentication problems. `message` is always safe to show in the
// UI. `reason` is for server-side logs and tests only and is never sent to the browser.

export class AuthError extends Error {
  constructor(code, message, { status = 401, reason } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code; // stable application code, e.g. "AUTH_INVALID_CREDENTIALS"
    this.status = status; // suggested HTTP status for route handlers
    this.reason = reason; // internal detail, never returned to the browser
  }

  toResponseBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

// One message for every "could not sign in" case: unknown user, wrong password and
// deactivated account must look identical so usernames cannot be discovered.
export function invalidCredentials(reason) {
  return new AuthError("AUTH_INVALID_CREDENTIALS", "Incorrect username or password.", {
    status: 401,
    reason,
  });
}
