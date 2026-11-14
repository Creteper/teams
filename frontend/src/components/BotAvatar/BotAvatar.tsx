import { memo, useMemo, useRef, type CSSProperties } from 'react';
import { eyesPath, REST_POSE } from './eyes';
import { resolveColor, resolveFill, resolveShape } from './resolve';
import { getShapeDef } from './shapes';
import { useAvatarMotion } from './useAvatarMotion';
import { useReducedMotion } from './useReducedMotion';

export interface BotAvatarProps {
  /** Grok Bot `avatarShape`, e.g. "blob". Unknown values fall back to "blob". */
  shape: string;
  /** Grok Bot `avatarColor`, e.g. "black", or a literal "#rrggbb". Unknown values fall back to "black". */
  color: string;
  /** Rendered width/height in CSS pixels. */
  size: number;
  /** Idle animation (breathing, gaze, blinks). Default true. Ignored under prefers-reduced-motion. */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Eyes follow the mouse pointer while it moves (animated only). Default false. */
  followPointer?: boolean;
  /** Per-avatar seed (e.g. the bot id) so neighbouring avatars don't move in lockstep. */
  seed?: string;
  /** "dark" draws `black` bodies in white so they stay visible on dark UIs. Default "light". */
  colorScheme?: 'light' | 'dark';
  /** Accessible label; when omitted the avatar is decorative (aria-hidden). */
  title?: string;
}

/**
 * Procedural Grok Bot–style avatar: flat-colour body with cut-out eyes,
 * pure SVG, zero runtime dependencies besides React.
 */
function BotAvatarImpl({
  shape,
  color,
  size,
  animated = true,
  className,
  style,
  followPointer = false,
  seed = '',
  colorScheme = 'light',
  title,
}: BotAvatarProps) {
  const shapeId = resolveShape(shape);
  const def = getShapeDef(shapeId);
  const fill = resolveFill(color, colorScheme);
  const staticD = useMemo(() => def.d + eyesPath(def.eye, REST_POSE), [def]);
  const reduced = useReducedMotion();
  const live = animated && !reduced;

  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  useAvatarMotion(svgRef, groupRef, pathRef, def, staticD, {
    enabled: live,
    seed: seed || `${shapeId}:${resolveColor(color)}`,
    followPointer,
  });

  const px = Number.isFinite(size) && size > 0 ? size : 32;
  return (
    <svg
      ref={svgRef}
      className={className}
      style={style}
      width={px}
      height={px}
      viewBox="-100 -100 200 200"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-shape={shapeId}
      data-color={fill}
    >
      {title ? <title>{title}</title> : null}
      <g ref={groupRef}>
        <path ref={pathRef} d={staticD} fill={fill} fillRule="evenodd" />
      </g>
    </svg>
  );
}

export const BotAvatar = memo(BotAvatarImpl);
BotAvatar.displayName = 'BotAvatar';
export default BotAvatar;
