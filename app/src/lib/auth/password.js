// Password checking with bcryptjs (pure JavaScript). It reads standard bcrypt hashes
// ($2a$, $2b$, $2y$), including the ones Python's `bcrypt` package writes, which is
// how the seed users' hashes are made (see TRACE-X_TEAM_CONTEXT.md, section 10).
//
// This module only compares. It never creates or stores passwords.

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_FORMAT = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Used when there is nobody to compare against (unknown username, or a stored value
// that is not a bcrypt hash). Doing a real comparison anyway keeps the response time
// about the same, so timing does not reveal which usernames exist.
// Cost 12 matches the default of Python's bcrypt, which makes the seed hashes.
const DUMMY_COST = 12;
let dummyHash;
function getDummyHash() {
  dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), DUMMY_COST);
  return dummyHash;
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || password.length === 0) return false;
  if (typeof storedHash !== "string" || !BCRYPT_FORMAT.test(storedHash)) {
    await bcrypt.compare(password, await getDummyHash());
    return false;
  }
  try {
    return await bcrypt.compare(password, storedHash);
  } catch {
    return false;
  }
}

// Burns the same time as a real check, always returns false.
export async function verifyAgainstNobody(password) {
  await bcrypt.compare(typeof password === "string" ? password : "", await getDummyHash());
  return false;
}
