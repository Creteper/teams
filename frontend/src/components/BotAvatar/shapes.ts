// Shape table for BotAvatar. Original implementation: every outline below is
// built from generic primitives (superellipse, rounded polygon, circle union,
// polar curves) with hand-tuned parameters, front view only.

import {
  type Pt,
  capsule,
  circleUnion,
  ellipse,
  normalize,
  regularPolygon,
  roundedPolygon,
  sampleClosed,
  smoothRadial,
  superellipse,
  toPath,
} from './geometry';

/** Shape names accepted as `avatarShape` (Grok Bot profile field), in editor order. */
export const AVATAR_SHAPES = [
  'blob',
  'pebble',
  'bean',
  'egg',
  'squircle',
  'tablet',
  'capsule',
  'cylinder',
  'hex',
  'gem',
  'crystal',
  'wedge',
  'shield',
  'dome',
  'arch',
  'cloud',
  'teardrop',
  'leaf',
  'square',
  'sparkle',
  'clover',
  'flower',
  'heart',
  'house',
  'star',
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const DEFAULT_SHAPE: AvatarShape = 'blob';

/** Alternate spellings seen in the wild (engine-internal names, plurals of taste). */
export const SHAPE_ALIASES: Readonly<Record<string, AvatarShape>> = {
  sphere: 'blob',
  spherewide: 'blob',
  circle: 'blob',
  spark: 'sparkle',
  star6: 'star',
  heartchubby: 'heart',
  hexagon: 'hex',
  starflower: 'flower',
  horseshoe: 'arch',
};

/** Eye placement in viewBox units (viewBox is -100..100, body extent ≈ 86). */
export interface EyeLayout {
  /** half width of one eye */
  w: number;
  /** half height of one eye */
  h: number;
  /** centre-to-centre distance */
  gap: number;
  /** vertical offset of the eye pair (positive = lower) */
  y: number;
  /** horizontal offset of the eye pair */
  x: number;
  /** radius of the virtual sphere the eyes are projected on */
  sphere: number;
  /** max gaze rotation (radians) */
  gazeRange: number;
}

export interface ShapeDef {
  name: AvatarShape;
  /** body outline path, viewBox units */
  d: string;
  /** body outline points (normalized) */
  pts: Pt[];
  eye: EyeLayout;
  /** true when the body itself is a sphere (eyes wrap tightly around it) */
  spherical: boolean;
}

interface Spec {
  build: () => Pt[];
  extent?: number;
  eye?: Partial<EyeLayout>;
  spherical?: boolean;
}

const BASE_EYE: EyeLayout = { w: 9, h: 20, gap: 44, y: 4, x: 0, sphere: 150, gazeRange: 0.16 };

// -------- individual outlines (raw units, normalized afterwards) --------

const pebble = (): Pt[] =>
  sampleClosed((t) => {
    const wobble = 1 + 0.035 * Math.sin(3 * t + 0.6) + 0.02 * Math.cos(2 * t);
    return [Math.cos(t) * 110 * wobble, Math.sin(t) * 94 * wobble];
  }, 192);

const bean = (): Pt[] => {
  // a chain of balls along a gently bent vertical spine
  const balls: [number, number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8 - 0.5; // -0.5..0.5 top..bottom
    const x = -Math.cos(u * Math.PI) * 7 + 3;
    balls.push([x, u * 100, 66 - Math.abs(u) * 8]);
  }
  return circleUnion(balls, 240, 8);
};

const egg = (): Pt[] =>
  sampleClosed((t) => {
    const s = Math.sin(t); // -1 top, +1 bottom (y down)
    const top = (1 - s) / 2; // 1 at the top
    return [Math.cos(t) * 98 * (1 - 0.24 * top * top), s * 116];
  }, 192);

const cylinder = (): Pt[] => {
  const hw = 92;
  const hh = 104;
  const capRy = 18;
  const v: Pt[] = [];
  const seg = 10;
  // top cap (convex upward), left to right
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI + (i / seg) * Math.PI;
    v.push([Math.cos(a) * hw, -hh + capRy + Math.sin(a) * capRy]);
  }
  // bottom cap (convex downward), right to left
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI;
    v.push([Math.cos(a) * hw, hh - capRy * 1.6 + Math.sin(a) * capRy * 1.6]);
  }
  return roundedPolygon(v, v.map((_, i) => (i === 0 || i === seg || i === seg + 1 || i === 2 * seg + 1 ? 22 : 4)), 6);
};

const crystal = (): Pt[] =>
  roundedPolygon(
    [
      [0, -124],
      [64, -56],
      [60, 58],
      [0, 124],
      [-64, 56],
      [-60, -58],
    ],
    [16, 14, 14, 16, 14, 14],
  );

const wedge = (): Pt[] =>
  roundedPolygon(
    [
      [0, -92],
      [112, 84],
      [-112, 84],
    ],
    [46, 30, 30],
    14,
  );

const shield = (): Pt[] => {
  const hw = 98;
  const top = -96;
  const v: Pt[] = [];
  const seg = 16;
  v.push([-hw, top]);
  v.push([0, top - 6]);
  v.push([hw, top]);
  // right side down into a round bottom
  for (let i = 1; i <= seg; i++) {
    const u = i / seg;
    const y = top + u * 206;
    const k = Math.max(0, (y + 20) / 130);
    const x = hw * Math.sqrt(Math.max(0, 1 - k * k));
    v.push([x, y]);
  }
  for (let i = seg - 1; i >= 1; i--) {
    const u = i / seg;
    const y = top + u * 206;
    const k = Math.max(0, (y + 20) / 130);
    const x = -hw * Math.sqrt(Math.max(0, 1 - k * k));
    v.push([x, y]);
  }
  return roundedPolygon(v, v.map((_, i) => (i === 0 || i === 2 ? 26 : 8)), 8);
};

const dome = (): Pt[] => {
  const v: Pt[] = [];
  const seg = 24;
  const base = 20;
  const ext = 0.32; // the arc continues a little below its equator
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI - ext + (i / seg) * (Math.PI + 2 * ext);
    v.push([Math.cos(a) * 116, base + Math.sin(a) * 104]);
  }
  v.push([0, base + 104 * Math.sin(ext) + 8]);
  return roundedPolygon(v, v.map((_, i) => (i === 0 || i === seg ? 28 : 6)), 8);
};

const arch = (): Pt[] => {
  const r = 78;
  const v: Pt[] = [];
  const seg = 20;
  const cy = -114 + r;
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI + (i / seg) * Math.PI;
    v.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  v.push([r, 114]);
  v.push([-r, 114]);
  return roundedPolygon(v, v.map((_, i) => (i > seg ? 22 : 6)), 8);
};

const cloud = (): Pt[] =>
  circleUnion(
    [
      [-60, 22, 52],
      [60, 22, 50],
      [0, 30, 60],
      [-24, -26, 58],
      [36, -22, 52],
    ],
    300,
    2,
  );

const teardrop = (): Pt[] => {
  const r = 86;
  const cy = 26;
  const tipY = -118;
  const d = cy - tipY;
  const tangentA = Math.asin(r / d); // half-angle of the cone at the tip
  const v: Pt[] = [[0, tipY]];
  const seg = 28;
  // arc from right tangent point around the bottom to the left tangent point
  const start = -Math.PI / 2 + (Math.PI / 2 - tangentA); // angle on circle of right tangent point
  const sweep = Math.PI * 2 - 2 * (Math.PI / 2 - tangentA);
  for (let i = 0; i <= seg; i++) {
    const a = start + (i / seg) * sweep;
    v.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return roundedPolygon(v, v.map((_, i) => (i === 0 ? 34 : 2)), 12);
};

const leaf = (): Pt[] =>
  sampleClosed((t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [Math.sign(c) * Math.abs(c) ** 1.45 * 88, s * 114];
  }, 192);

const sparkle = (): Pt[] => {
  // union of a horizontal and a vertical ellipse plus a core disc, seams filleted
  const polarEllipse = (a: number, b: number, t: number) =>
    (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
  const pts = sampleClosed((t) => {
    const r = Math.max(polarEllipse(118, 50, t), polarEllipse(50, 118, t), 64);
    return [Math.cos(t) * r, Math.sin(t) * r];
  }, 240);
  return smoothRadial(pts, 40);
};

const clover = (): Pt[] =>
  circleUnion(
    [
      [-40, -40, 54],
      [40, -40, 54],
      [-40, 40, 54],
      [40, 40, 54],
      [0, 0, 50],
    ],
    300,
    3,
  );

const flower = (): Pt[] => {
  const petals: [number, number, number][] = [[0, 0, 70]];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    petals.push([Math.cos(a) * 70, Math.sin(a) * 70, 42]);
  }
  return circleUnion(petals, 300, 2);
};

const heart = (): Pt[] => {
  // two lobes (circle arcs) joined by tangent lines to a rounded tip
  const r = 58;
  const cx = 48;
  const cy = -24;
  const tip: Pt = [0, 104];
  const notchY = cy - Math.sqrt(r * r - cx * cx);
  // tangent point on the right lobe as seen from the tip
  const dx = cx - tip[0];
  const dy = cy - tip[1];
  const dist = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  const off = Math.acos(r / dist);
  const cand = [base + Math.PI + off, base + Math.PI - off];
  // outer tangent point = the candidate farther to the right
  const aT = cand.reduce((b, a) => (Math.cos(a) > Math.cos(b) ? a : b));
  const aN = Math.atan2(notchY - cy, -cx); // angle of the notch on the right lobe
  const seg = 18;
  const right: Pt[] = [];
  // from notch, clockwise over the top/right, down to the tangent point
  let a0 = aN;
  let a1 = aT;
  while (a1 < a0) a1 += Math.PI * 2;
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    right.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  const left = right.map(([x, y]) => [-x, y] as Pt).reverse();
  const v: Pt[] = [[0, notchY], ...right, tip, ...left];
  const tipIndex = right.length + 1;
  return roundedPolygon(v, v.map((_, i) => (i === 0 ? 16 : i === tipIndex ? 40 : 3)), 12);
};

const house = (): Pt[] =>
  roundedPolygon(
    [
      [-98, 108],
      [98, 108],
      [98, -34],
      [0, -110],
      [-98, -34],
    ],
    [18, 18, 26, 26, 26],
  );

const star = (): Pt[] => {
  const v: Pt[] = [];
  for (let i = 0; i < 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
    const r = i % 2 === 0 ? 116 : 80;
    v.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return roundedPolygon(v, v.map((_, i) => (i % 2 === 0 ? 30 : 22)), 10);
};

const SPECS: Record<AvatarShape, Spec> = {
  blob: {
    build: () => ellipse(100, 100, 0, 0, 192),
    extent: 84,
    spherical: true,
    eye: { w: 10, h: 23, gap: 50, y: -4, sphere: 84, gazeRange: 0.5 },
  },
  pebble: { build: pebble, eye: { w: 9.5, h: 21, gap: 46, y: 6 } },
  bean: { build: bean, eye: { w: 8.5, h: 19, gap: 40, y: 6, x: 4 } },
  egg: { build: egg, eye: { w: 9.5, h: 21, gap: 42, y: 8 } },
  squircle: { build: () => superellipse(100, 100, 3.6), extent: 84, eye: { w: 9.5, h: 21, gap: 46, y: 4 } },
  tablet: { build: () => capsule(116, 74, 0, 0, 20), eye: { w: 9, h: 20, gap: 50, y: 2 } },
  capsule: { build: () => capsule(68, 114, 0, 0, 20), eye: { w: 7.5, h: 17, gap: 34, y: 6 } },
  cylinder: { build: cylinder, eye: { w: 9.5, h: 21, gap: 44, y: 8 } },
  hex: { build: () => roundedPolygon(regularPolygon(6, 114, Math.PI / 6), 22), eye: { w: 9.5, h: 21, gap: 46, y: 4 } },
  gem: { build: () => superellipse(112, 113, 1.8), eye: { w: 9, h: 20, gap: 42, y: 4 } },
  crystal: { build: crystal, eye: { w: 7, h: 15, gap: 34, y: 6 } },
  wedge: { build: wedge, eye: { w: 9, h: 20, gap: 42, y: 24 } },
  shield: { build: shield, eye: { w: 9.5, h: 21, gap: 44, y: 0 } },
  dome: { build: dome, eye: { w: 9, h: 20, gap: 46, y: 8 } },
  arch: { build: arch, eye: { w: 8.5, h: 19, gap: 40, y: 2 } },
  cloud: { build: cloud, eye: { w: 9, h: 19, gap: 42, y: 10 } },
  teardrop: { build: teardrop, eye: { w: 8.5, h: 19, gap: 40, y: 20 } },
  leaf: { build: leaf, eye: { w: 8, h: 17, gap: 36, y: 2 } },
  square: { build: () => roundedPolygon(regularPolygon(4, 150, Math.PI / 4), 30), extent: 82, eye: { w: 10, h: 22, gap: 46, y: 10 } },
  sparkle: { build: sparkle, eye: { w: 8, h: 17, gap: 36, y: 0 } },
  clover: { build: clover, eye: { w: 9, h: 20, gap: 46, y: 0 } },
  flower: { build: flower, eye: { w: 8.5, h: 18, gap: 36, y: 8 } },
  heart: { build: heart, eye: { w: 8.5, h: 18, gap: 40, y: 0 } },
  house: { build: house, eye: { w: 9.5, h: 21, gap: 44, y: 22 } },
  star: { build: star, eye: { w: 8, h: 18, gap: 36, y: 8 } },
};

/** Global eye size multiplier (tuned against reference renders). */
const EYE_SCALE = 1.12;
const scaleEye = (e: EyeLayout, k: number): EyeLayout => ({ ...e, w: e.w * k, h: e.h * k, gap: e.gap * k });

const cache = new Map<AvatarShape, ShapeDef>();

/** Geometry for a canonical shape name (memoized; built on first use). */
export function getShapeDef(name: AvatarShape): ShapeDef {
  let def = cache.get(name);
  if (!def) {
    const spec = SPECS[name];
    const { pts } = normalize(spec.build(), spec.extent ?? 86);
    def = {
      name,
      pts,
      d: toPath(pts),
      eye: scaleEye({ ...BASE_EYE, ...spec.eye }, EYE_SCALE),
      spherical: spec.spherical ?? false,
    };
    cache.set(name, def);
  }
  return def;
}
