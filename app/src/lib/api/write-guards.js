export function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (request.headers.get("host") || new URL(request.url).host); }
  catch { return false; }
}

export async function readJson(request) {
  try { return { ok: true, value: await request.json() }; }
  catch { return { ok: false, value: null }; }
}

export async function readPositiveId(context, key = "id") {
  const params = await context.params;
  const raw = params?.[key];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 4294967295 ? id : null;
}

export function cleanText(value, max, { required = false } = {}) {
  if (value === null || value === undefined) return required ? null : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if ((required && trimmed.length === 0) || trimmed.length > max) return null;
  return trimmed;
}


export function mysqlDateTimeLocal(value) {
  if (typeof value !== "string") return null;
  // Preserve the wall-clock value sent by datetime-local; DATETIME has no timezone.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day) || date.getHours() !== Number(hour) ||
      date.getMinutes() !== Number(minute) || date.getSeconds() !== Number(second)) return null;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function parsePositiveId(value) {
  const validType = typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value));
  if (!validType) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 4294967295 ? id : null;
}
