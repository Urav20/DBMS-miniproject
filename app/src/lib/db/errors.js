// Database error type and the translation of raw MySQL / network errors into
// errors that are safe to show to a user.
//
// Rules:
//  - `message` is always safe to show in the UI. It never contains credentials,
//    host names, SQL text or bound parameter values.
//  - `detail` is only filled for errors caused by a rule the database enforces
//    (SIGNAL from a procedure, CHECK, UNIQUE, FOREIGN KEY). Those messages are the
//    "readable rejection" the project demonstrates, so they are passed through.
//  - The original error is kept in `cause` for server-side logging only.

export class DatabaseError extends Error {
  constructor(
    code,
    message,
    { status = 500, detail, cause, mysqlErrno, sqlState } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "DatabaseError";
    this.code = code; // stable application code, e.g. "DB_UNAVAILABLE"
    this.status = status; // suggested HTTP status for route handlers
    this.detail = detail; // optional user-safe detail from a database rule
    this.mysqlErrno = mysqlErrno;
    this.sqlState = sqlState;
  }

  // Shape a route handler can return as JSON.
  toResponseBody() {
    const error = { code: this.code, message: this.message };
    if (this.detail) error.detail = this.detail;
    return { error };
  }
}

// Network-level error codes that mean "the database could not be reached".
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "POOL_CLOSED",
]);

const UNAVAILABLE_MESSAGE = "The database is not reachable right now.";

// Keyed by MySQL error number.
// `expose` = pass the database's own message through as `detail`.
const BY_ERRNO = {
  1644: {
    // SIGNAL SQLSTATE '45000' raised by one of our stored procedures or triggers
    code: "DB_RULE_VIOLATION",
    status: 422,
    message: "The database rejected this action.",
    expose: true,
  },
  3819: {
    code: "DB_CONSTRAINT",
    status: 422,
    message: "The data breaks a rule enforced by the database.",
    expose: true,
  },
  1062: {
    code: "DB_DUPLICATE",
    status: 409,
    message: "This record already exists.",
    expose: true,
  },
  1452: {
    code: "DB_FOREIGN_KEY",
    status: 422,
    message: "A related record does not exist.",
    expose: true,
  },
  1451: {
    code: "DB_FOREIGN_KEY",
    status: 409,
    message: "This record is still used by other records.",
    expose: true,
  },
  1048: {
    code: "DB_INVALID_DATA",
    status: 422,
    message: "A required value is missing.",
    expose: true,
  },
  1406: {
    code: "DB_INVALID_DATA",
    status: 422,
    message: "A value is too long.",
    expose: true,
  },
  1265: { code: "DB_INVALID_DATA", status: 422, message: "A value is not valid." },
  1366: { code: "DB_INVALID_DATA", status: 422, message: "A value is not valid." },
  1292: { code: "DB_INVALID_DATA", status: 422, message: "A value is not valid." },
  // Permission problems: the database role is not allowed to do this.
  1142: forbidden(), // table
  1143: forbidden(), // column
  1044: forbidden(), // database
  1370: forbidden(), // procedure / function EXECUTE
  1227: forbidden(), // missing privilege
  // The application account itself cannot sign in: configuration problem.
  1045: {
    code: "DB_AUTH_FAILED",
    status: 503,
    message: "The application could not sign in to the database.",
  },
  1049: { code: "DB_UNAVAILABLE", status: 503, message: UNAVAILABLE_MESSAGE },
  1040: { code: "DB_UNAVAILABLE", status: 503, message: UNAVAILABLE_MESSAGE },
  1053: { code: "DB_UNAVAILABLE", status: 503, message: UNAVAILABLE_MESSAGE },
  1205: {
    code: "DB_CONFLICT",
    status: 409,
    message: "The record is busy. Please try again.",
  },
  1213: {
    code: "DB_CONFLICT",
    status: 409,
    message: "The record is busy. Please try again.",
  },
};

function forbidden() {
  return {
    code: "DB_PERMISSION_DENIED",
    status: 403,
    message: "Your database role is not allowed to do this.",
  };
}

export function isMysqlError(err) {
  if (!err || typeof err !== "object") return false;
  if (typeof err.errno === "number" && typeof err.sqlState === "string") {
    return true;
  }
  if (typeof err.code !== "string") return false;
  return err.code.startsWith("ER_") || NETWORK_CODES.has(err.code);
}

// True when the connection itself can no longer be trusted or reused.
export function isConnectionBroken(err) {
  return Boolean(
    err &&
      (err.fatal === true ||
        (typeof err.code === "string" && NETWORK_CODES.has(err.code))),
  );
}

// Convert any thrown value into a DatabaseError when it came from MySQL or the
// network. Errors that did not come from the database (programming mistakes) are
// returned unchanged so they are not hidden.
export function toDatabaseError(err) {
  if (err instanceof DatabaseError) return err;
  if (!isMysqlError(err)) return err;

  const base = { cause: err, mysqlErrno: err.errno, sqlState: err.sqlState };
  const rule = BY_ERRNO[err.errno];

  if (rule) {
    return new DatabaseError(rule.code, rule.message, {
      ...base,
      status: rule.status,
      detail: rule.expose ? err.sqlMessage : undefined,
    });
  }
  if (typeof err.code === "string" && NETWORK_CODES.has(err.code)) {
    return new DatabaseError("DB_UNAVAILABLE", UNAVAILABLE_MESSAGE, {
      ...base,
      status: 503,
    });
  }
  return new DatabaseError(
    "DB_QUERY_ERROR",
    "The database could not complete the request.",
    { ...base, status: 500 },
  );
}

// Business-rule rejections are expected during normal use and are not logged as
// server faults.
export function isExpectedRejection(err) {
  return (
    err instanceof DatabaseError &&
    [
      "DB_RULE_VIOLATION",
      "DB_CONSTRAINT",
      "DB_DUPLICATE",
      "DB_FOREIGN_KEY",
      "DB_INVALID_DATA",
      "DB_PERMISSION_DENIED",
      "DB_CONFLICT",
    ].includes(err.code)
  );
}
