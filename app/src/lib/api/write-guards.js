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
  if (typeof raw !== "string" || !/^\\d+$/.test(raw)) return null;
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
