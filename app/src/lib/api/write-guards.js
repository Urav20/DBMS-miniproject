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
  // Preserve the wall-clock value sent by datetime-local; MySQL DATETIME has no timezone.
  // Validate calendar fields directly so the server's timezone/DST settings cannot alter it.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 ||
      hour > 23 || minute > 59 || second > 59) return null;
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysPerMonth[month - 1]) return null;
  return `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondText}`;
}

export function parsePositiveId(value) {
  const validType = typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value));
  if (!validType) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 4294967295 ? id : null;
}
