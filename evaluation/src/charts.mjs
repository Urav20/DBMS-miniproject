// Dependency-free SVG bar charts.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const COLORS = { keyword: "#2f6f9f", vector: "#d98a1f", hybrid: "#3f9a5a" };

// groups: [{ label, bars: [{ label, value, color }] }]
export function groupedBarSvg({ title, groups, yMax = 1, yLabel = "", decimals = 2 }) {
  const W = Math.max(640, 120 + groups.length * 130);
  const H = 360, L = 60, R = 20, T = 50, B = 70;
  const plotW = W - L - R, plotH = H - T - B;
  const gw = plotW / groups.length;
  const nb = Math.max(...groups.map((g) => g.bars.length));
  const bw = Math.min(34, (gw * 0.8) / nb);
  const y = (v) => T + plotH - (Math.max(0, v) / yMax) * plotH;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`, `<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="600">${esc(title)}</text>`];
  for (let i = 0; i <= 5; i += 1) {
    const v = (yMax * i) / 5;
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e3e3"/>`, `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" fill="#555">${v.toFixed(yMax < 5 ? 1 : 0)}</text>`);
  }
  if (yLabel) out.push(`<text transform="translate(14 ${T + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#555">${esc(yLabel)}</text>`);
  groups.forEach((g, gi) => {
    const x0 = L + gi * gw + (gw - bw * g.bars.length) / 2;
    g.bars.forEach((b, bi) => {
      const x = x0 + bi * bw, h = plotH - (y(b.value ?? 0) - T);
      out.push(`<rect x="${x}" y="${y(b.value ?? 0)}" width="${bw - 3}" height="${h}" fill="${b.color}"/>`,
        `<text x="${x + (bw - 3) / 2}" y="${y(b.value ?? 0) - 4}" text-anchor="middle" font-size="10" fill="#333">${b.value === null || b.value === undefined ? "n/a" : b.value.toFixed(decimals)}</text>`);
    });
    out.push(`<text x="${L + gi * gw + gw / 2}" y="${H - B + 18}" text-anchor="middle" fill="#333">${esc(g.label)}</text>`);
  });
  const names = [...new Map(groups.flatMap((g) => g.bars).map((b) => [b.label, b.color])).entries()];
  names.forEach(([label, color], i) => {
    const x = L + i * 120;
    out.push(`<rect x="${x}" y="${H - 22}" width="12" height="12" fill="${color}"/><text x="${x + 17}" y="${H - 12}" fill="#333">${esc(label)}</text>`);
  });
  out.push("</svg>");
  return out.join("\n");
}
