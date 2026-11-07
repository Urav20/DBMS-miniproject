// The sign-in decision. It is kept free of Next.js and of the database driver:
// the user lookup is passed in, so the same code runs in unit tests (fake lookup)
// and in the app (real MySQL lookup from users.js).

import { validateSession } from "../db/client.js";
import { mapRoleName } from "./config.js";
import { AuthError, invalidCredentials } from "./errors.js";
import { verifyAgainstNobody, verifyPassword } from "./password.js";

// input = { username, password } (already validated by validateLoginInput)
// findUser(username) -> row | null, with the app_user / role columns:
//   user_id, username, full_name, password_hash, is_active, role_name
// Returns { userId, role, username, fullName }. The password hash is never returned.
export async function authenticate({ username, password }, { findUser }) {
  const row = await findUser(username);

  if (!row) {
    await verifyAgainstNobody(password);
    throw invalidCredentials("unknown user");
  }

  // The password is always checked, even for a deactivated account, so the answer
  // and the response time do not depend on the account's state.
  const passwordOk = await verifyPassword(password, row.password_hash);
  if (!passwordOk) throw invalidCredentials("wrong password");
  if (Number(row.is_active) !== 1) throw invalidCredentials("account deactivated");

  const role = mapRoleName(row.role_name);
  if (!role) {
    throw new AuthError(
      "AUTH_ROLE_UNSUPPORTED",
      "This account's role cannot sign in to the application.",
      { status: 403, reason: "role_name has no database pool mapping" },
    );
  }

  const userId = Number(row.user_id);
  try {
    validateSession({ role, userId });
  } catch {
    throw new AuthError("AUTH_BAD_USER_RECORD", "Sign-in is not available right now.", {
      status: 500,
      reason: "user_id is not a valid positive integer",
    });
  }

  return {
    userId,
    role,
    username: String(row.username),
    fullName: String(row.full_name ?? ""),
  };
}
