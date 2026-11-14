import { useEffect, type RefObject } from 'react';
import { eyesPath, type Pose } from './eyes';
import {
  blinkLid,
  BLINK_DURATION,
  hashString,
  pointer,
  prng,
  retainPointer,
  spring,
  stepSprings,
  subscribeTicker,
} from './motion';
import type { ShapeDef } from './shapes';

// One IntersectionObserver for every avatar: off-screen avatars stop ticking.
type VisCb = (visible: boolean) => void;
const visCallbacks = new WeakMap<Element, VisCb>();
let observer: IntersectionObserver | null = null;
function observe(el: Element, cb: VisCb): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true);
    return () => {};
  }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) visCallbacks.get(e.target)?.(e.isIntersecting);
    });
  }
  visCallbacks.set(el, cb);
  observer.observe(el);
  return () => {
    visCallbacks.delete(el);
    observer?.unobserve(el);
  };
}

export interface MotionOptions {
  enabled: boolean;
  seed: string;
  followPointer: boolean;
}

/**
 * Drives one avatar imperatively (attributes are written straight to the SVG
 * nodes, React does not re-render per frame). Idle behaviour: breathing
 * squash, wandering gaze on springs, random blinks (sometimes doubled),
 * optional pointer following. Everything is torn down on unmount or when
 * `enabled` turns false, and the static frame is restored.
 */
export function useAvatarMotion(
  svgRef: RefObject<SVGSVGElement | null>,
  groupRef: RefObject<SVGGElement | null>,
  pathRef: RefObject<SVGPathElement | null>,
  def: ShapeDef,
  staticD: string,
  { enabled, seed, followPointer }: MotionOptions,
): void {
  useEffect(() => {
    const svg = svgRef.current;
    const group = groupRef.current;
    const path = pathRef.current;
    if (!enabled || !svg || !group || !path) return;

    const rnd = prng(hashString(seed + ':' + def.name));
    const eye = def.eye;
    const bottom = Math.max(...def.pts.map((p) => p[1]));
    const yaw = spring(2.4, 0.72);
    const pitch = spring(2.4, 0.72);
    const squash = spring(3.2, 0.42);
    const springs = [yaw, pitch, squash];
    const carry = { acc: 0 };
    const phase = rnd() * Math.PI * 2;
    let t = rnd() * 10;
    let nextBlink = 0.6 + rnd() * 3;
    let blinkAt = -1;
    let pendingDouble = false;
    let nextLook = 0.4 + rnd() * 2;

    const pose: Pose = { yaw: 0, pitch: 0, roll: 0, lid: 0 };

    const tick = (dt: number) => {
      t += dt;

      // ---- gaze target: pointer when it moved recently, otherwise wander ----
      const now = performance.now() / 1000;
      if (followPointer && now - pointer.t < 2.5) {
        const r = svg.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const reach = Math.max(120, r.width * 4);
        yaw.target = Math.max(-1, Math.min(1, (pointer.x - cx) / reach));
        pitch.target = Math.max(-1, Math.min(1, -(pointer.y - cy) / reach));
      } else if (t >= nextLook) {
        const centre = rnd() < 0.35;
        const ny = centre ? 0 : (rnd() * 2 - 1) * 0.85;
        const np = centre ? 0 : (rnd() * 2 - 1) * 0.5;
        if (Math.abs(ny - yaw.target) > 0.4) squash.v -= 0.35; // tiny "hop" on big glances
        yaw.target = ny;
        pitch.target = np;
        nextLook = t + 1.2 + rnd() * 3.2;
      }

      // ---- blinks ----
      if (blinkAt < 0 && t >= nextBlink) {
        blinkAt = t;
      }
      let lid = 0;
      if (blinkAt >= 0) {
        const bt = t - blinkAt;
        lid = blinkLid(bt);
        if (bt >= BLINK_DURATION) {
          blinkAt = -1;
          if (!pendingDouble && rnd() < 0.18) {
            pendingDouble = true;
            nextBlink = t + 0.12;
          } else {
            pendingDouble = false;
            nextBlink = t + 2.2 + rnd() * 4.5;
          }
        }
      }

      stepSprings(springs, dt, carry);

      // ---- pose & body ----
      pose.yaw = yaw.x * eye.gazeRange;
      pose.pitch = pitch.x * eye.gazeRange;
      pose.roll = -yaw.x * 0.04;
      pose.lid = lid;
      const breathe = 0.018 * Math.sin((t / 3.4) * Math.PI * 2 + phase);
      const sy = 1 + breathe + squash.x * 0.12;
      const sx = 1 - (sy - 1) * 0.7;
      const tx = yaw.x * 3;
      const ty = -pitch.x * 2;
      group.setAttribute(
        'transform',
        `translate(${tx.toFixed(2)} ${(ty + bottom).toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(0 ${(-bottom).toFixed(2)})`,
      );
      path.setAttribute('d', def.d + eyesPath(eye, pose, [yaw.x * 2, -pitch.x * 1.5]));
    };

    let unsubscribe: (() => void) | null = null;
    const releasePointer = followPointer ? retainPointer() : () => {};
    const unobserve = observe(svg, (visible) => {
      if (visible && !unsubscribe) unsubscribe = subscribeTicker(tick);
      else if (!visible && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    });

    return () => {
      unobserve();
      unsubscribe?.();
      unsubscribe = null;
      releasePointer();
      group.removeAttribute('transform');
      path.setAttribute('d', staticD);
    };
  }, [svgRef, groupRef, pathRef, def, staticD, enabled, seed, followPointer]);
}
