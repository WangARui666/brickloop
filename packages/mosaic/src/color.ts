/** sRGB (0..255), CIE Lab (D65), and CIEDE2000 with unit weighting. */
export type RGB = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export function rgbToLab(rgb: RGB): Lab {
  const linear = (v: number) => (v / 255 <= 0.04045 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const f = (v: number) => (v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE2000(a: Lab, b: Lab): number {
  const radians = Math.PI / 180;
  const sin = (d: number) => Math.sin(d * radians);
  const cos = (d: number) => Math.cos(d * radians);
  const c = (Math.hypot(a[1], a[2]) + Math.hypot(b[1], b[2])) / 2;
  const g = (1 - Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7))) / 2;
  const ap = a[1] * (1 + g),
    bp = b[1] * (1 + g);
  const c1 = Math.hypot(ap, a[2]),
    c2 = Math.hypot(bp, b[2]);
  const hue = (x: number, y: number) => (x === 0 && y === 0 ? 0 : (Math.atan2(y, x) / radians + 360) % 360);
  const h1 = hue(ap, a[2]),
    h2 = hue(bp, b[2]);
  const dl = b[0] - a[0],
    dc = c2 - c1;
  let dh = h2 - h1;
  if (c1 * c2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1 * c2) * sin(dh / 2);
  const l = (a[0] + b[0]) / 2,
    cp = (c1 + c2) / 2;
  const hp =
    c1 * c2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * cos(hp - 30) + 0.24 * cos(2 * hp) + 0.32 * cos(3 * hp + 6) - 0.2 * cos(4 * hp - 63);
  const sl = 1 + (0.015 * (l - 50) ** 2) / Math.sqrt(20 + (l - 50) ** 2);
  const sc = 1 + 0.045 * cp,
    sh = 1 + 0.015 * cp * t;
  const rt = -2 * Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7)) * sin(60 * Math.exp(-(((hp - 275) / 25) ** 2)));
  return Math.sqrt(Math.max(0, (dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh)));
}
