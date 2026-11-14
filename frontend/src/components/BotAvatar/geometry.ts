// Geometry primitives for BotAvatar. Original implementation (no third-party code).
// Every generator returns a dense, closed polyline (array of [x, y] points,
// y axis pointing down). The pipeline is: generator -> normalize -> path string.

export type Pt = readonly [number, number];

const TAU = Math.PI * 2;

/** Sample a parametric closed curve fn(t), t in [0, 2π). */
export function sampleClosed(fn: (t: number) => Pt, count = 160): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) out.push(fn((i / count) * TAU));
  return out;
}

/** Ellipse / circle outline. */
export function ellipse(rx: number, ry: number, cx = 0, cy = 0, count = 160): Pt[] {
  return sampleClosed((t) => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)], count);
}

/** Superellipse |x/a|^n + |y/b|^n = 1. n = 2 is an ellipse, larger is squarer, smaller is pointier. */
export function superellipse(a: number, b: number, n: number, count = 192): Pt[] {
  const e = 2 / n;
  return sampleClosed((t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [Math.sign(c) * Math.abs(c) ** e * a, Math.sign(s) * Math.abs(s) ** e * b];
  }, count);
}

/**
 * Polygon with rounded corners. Each corner is replaced by a quadratic Bézier
 * whose control point is the original vertex; the tangent distance is clamped
 * to half of the shorter neighbouring edge so corners never overlap.
 */
export function roundedPolygon(verts: readonly Pt[], radius: number | readonly number[], steps = 10): Pt[] {
  const n = verts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const cur = verts[i];
    const next = verts[(i + 1) % n];
    const r0 = typeof radius === 'number' ? radius : radius[i % radius.length];
    const lp = Math.hypot(prev[0] - cur[0], prev[1] - cur[1]) || 1;
    const ln = Math.hypot(next[0] - cur[0], next[1] - cur[1]) || 1;
    const r = Math.min(r0, lp / 2, ln / 2);
    const a: Pt = [cur[0] + ((prev[0] - cur[0]) / lp) * r, cur[1] + ((prev[1] - cur[1]) / lp) * r];
    const b: Pt = [cur[0] + ((next[0] - cur[0]) / ln) * r, cur[1] + ((next[1] - cur[1]) / ln) * r];
    if (r < 1e-6) {
      out.push(cur);
      continue;
    }
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * cur[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * cur[1] + t * t * b[1],
      ]);
    }
  }
  return out;
}

/** Regular polygon vertices (circumradius r, first vertex at angle phase). */
export function regularPolygon(count: number, r: number, phase = 0): Pt[] {
  return Array.from({ length: count }, (_, i) => {
    const a = phase + (i / count) * TAU;
    return [Math.cos(a) * r, Math.sin(a) * r] as Pt;
  });
}

/**
 * Outline of a union of circles, found by casting rays from the origin and
 * keeping the farthest hit. Works for star-shaped unions (all ours are).
 * The result is lightly smoothed so the concave seams read as soft fillets.
 */
export function circleUnion(circles: readonly (readonly [number, number, number])[], count = 240, smooth = 2): Pt[] {
  const pts = sampleClosed((t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    let best = 0;
    for (const [cx, cy, r] of circles) {
      const d = c * cx + s * cy;
      const disc = d * d - (cx * cx + cy * cy) + r * r;
      if (disc <= 0) continue;
      const hit = d + Math.sqrt(disc);
      if (hit > best) best = hit;
    }
    return [c * best, s * best];
  }, count);
  return smoothRadial(pts, smooth);
}

/** Moving-average smoothing of the radius of a star-shaped outline. */
export function smoothRadial(pts: readonly Pt[], passes: number): Pt[] {
  let r = pts.map((p) => Math.hypot(p[0], p[1]));
  const ang = pts.map((p) => Math.atan2(p[1], p[0]));
  const n = r.length;
  for (let k = 0; k < passes; k++) {
    r = r.map((_, i) => (r[(i - 1 + n) % n] + 2 * r[i] + r[(i + 1) % n]) / 4);
  }
  return r.map((rad, i) => [Math.cos(ang[i]) * rad, Math.sin(ang[i]) * rad] as Pt);
}

/** Stadium / capsule outline centred on (cx, cy) with half extents (hw, hh). */
export function capsule(hw: number, hh: number, cx = 0, cy = 0, perArc = 12): Pt[] {
  const r = Math.max(0, Math.min(hw, hh));
  const sx = hw - r;
  const sy = hh - r;
  const out: Pt[] = [];
  const centres: Pt[] = [
    [cx + sx, cy + sy],
    [cx - sx, cy + sy],
    [cx - sx, cy - sy],
    [cx + sx, cy - sy],
  ];
  for (let q = 0; q < 4; q++) {
    const c = centres[q];
    for (let k = 0; k <= perArc; k++) {
      const a = (q + k / perArc) * (Math.PI / 2);
      out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
  }
  return out;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bbox(pts: readonly Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Centre the bounding box on the origin and scale its larger half-extent to `extent`. */
export function normalize(pts: readonly Pt[], extent: number): { pts: Pt[]; scale: number } {
  const b = bbox(pts);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const half = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 || 1;
  const s = extent / half;
  return { pts: pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as Pt), scale: s };
}

const fmt = (n: number) => {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? '0' : String(v);
};

/** Closed polyline path. */
export function toPath(pts: readonly Pt[]): string {
  if (pts.length === 0) return '';
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${fmt(pts[i][0])} ${fmt(pts[i][1])}`;
  return d + 'Z';
}
