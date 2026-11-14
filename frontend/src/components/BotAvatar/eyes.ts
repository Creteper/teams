// Pseudo-3D eyes: each eye is a capsule drawn in the tangent plane of a
// virtual sphere, wrapped onto the sphere with the exponential map, rotated by
// the head pose (yaw / pitch / roll) and projected orthographically. Points
// that rotate behind the horizon are pinned to the silhouette. Original code.

import type { Pt } from './geometry';
import { capsule, toPath } from './geometry';
import type { EyeLayout } from './shapes';

type V3 = [number, number, number];

export interface Pose {
  /** head yaw, radians, + = looking right */
  yaw: number;
  /** head pitch, radians, + = looking up */
  pitch: number;
  /** roll, radians */
  roll: number;
  /** eyelid closure 0 (open) .. 1 (shut) */
  lid: number;
}

export const REST_POSE: Pose = { yaw: 0, pitch: 0, roll: 0, lid: 0 };

function rotate(v: V3, yaw: number, pitch: number, roll: number): V3 {
  // screen coords: x right, y down, z towards the viewer
  let [x, y, z] = v;
  // pitch (around x): + moves front points up (−y)
  let c = Math.cos(pitch);
  let s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  // yaw (around y): + moves front points right (+x)
  c = Math.cos(yaw);
  s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  // roll (around z)
  c = Math.cos(roll);
  s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

/** Map a tangent-plane offset (u, v in radians of arc) around the front pole onto the unit sphere. */
function expMap(u: number, v: number): V3 {
  const th = Math.hypot(u, v);
  if (th < 1e-9) return [0, 0, 1];
  const k = Math.sin(th) / th;
  return [u * k, v * k, Math.cos(th)];
}

const OUTLINE_STEPS = 8;

/** Eye outlines (two closed polylines) for a pose, in viewBox units. */
export function eyeOutlines(eye: EyeLayout, pose: Pose, offset: Pt = [0, 0]): Pt[][] {
  const R = eye.sphere;
  const lid = Math.min(1, Math.max(0, pose.lid));
  // lids squash the eye towards its centre line; a shut eye is a thin sliver
  const hh = Math.max(eye.h * (1 - 0.88 * lid), eye.w * 0.42);
  const hw = eye.w * (1 + 0.08 * lid);
  const local = capsule(hw, hh, 0, 0, OUTLINE_STEPS);
  const out: Pt[][] = [];
  for (const side of [-1, 1]) {
    const cx = eye.x + (side * eye.gap) / 2;
    const cy = eye.y;
    const pts: Pt[] = [];
    for (const [lx, ly] of local) {
      // the eye shape lives on the sphere: offsets measured as arc length
      const p = expMap((cx + lx) / R, (cy + ly) / R);
      let [x, y, z] = rotate(p, pose.yaw, pose.pitch, pose.roll);
      if (z < 0) {
        // behind the horizon: pin to the silhouette
        const l = Math.hypot(x, y) || 1;
        x /= l;
        y /= l;
        z = 0;
      }
      pts.push([offset[0] + x * R, offset[1] + y * R]);
    }
    out.push(pts);
  }
  return out;
}

export function eyesPath(eye: EyeLayout, pose: Pose, offset: Pt = [0, 0]): string {
  return eyeOutlines(eye, pose, offset).map(toPath).join('');
}
