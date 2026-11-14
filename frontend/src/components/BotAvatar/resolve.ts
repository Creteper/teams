import { AVATAR_SHAPES, DEFAULT_SHAPE, SHAPE_ALIASES, type AvatarShape } from './shapes';
import { AVATAR_COLORS, AVATAR_COLOR_HEX, COLOR_ALIASES, DEFAULT_COLOR, type AvatarColor } from './colors';

const SHAPE_SET: ReadonlySet<string> = new Set(AVATAR_SHAPES);
const COLOR_SET: ReadonlySet<string> = new Set(AVATAR_COLORS);

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Canonical shape for any input; unknown / empty / non-string values fall back to `blob`. */
export function resolveShape(shape: unknown): AvatarShape {
  const k = norm(shape);
  if (SHAPE_SET.has(k)) return k as AvatarShape;
  return SHAPE_ALIASES[k.replace(/[\s_-]/g, '')] ?? DEFAULT_SHAPE;
}

/** Canonical colour id; unknown values fall back to `black`. */
export function resolveColor(color: unknown): AvatarColor {
  const k = norm(color);
  if (COLOR_SET.has(k)) return k as AvatarColor;
  return COLOR_ALIASES[k] ?? DEFAULT_COLOR;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Fill colour for the body. Accepts a palette id or a literal hex (`#rrggbb`).
 * In a dark colour scheme `black` is drawn with its inverted ink (white) so it
 * stays visible on dark backgrounds.
 */
export function resolveFill(color: unknown, scheme: 'light' | 'dark' = 'light'): string {
  if (typeof color === 'string' && HEX_RE.test(color.trim())) return color.trim();
  const id = resolveColor(color);
  if (scheme === 'dark' && id === 'black') return AVATAR_COLOR_HEX.black.dark;
  return AVATAR_COLOR_HEX[id].base;
}
