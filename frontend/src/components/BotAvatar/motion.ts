// Motion primitives: a shared requestAnimationFrame ticker, critically-tuned
// springs integrated with a fixed-step semi-implicit Euler, a blink curve and a
// tiny seeded PRNG. Original code.

// ---------------- shared ticker ----------------

export type TickFn = (dt: number, now: number) => void;

const subscribers = new Set<TickFn>();
let rafId = 0;
let last = 0;

function frame(now: number) {
  rafId = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
  last = now;
  if (typeof document === 'undefined' || !document.hidden) {
    for (const fn of subscribers) fn(dt, now / 1000);
  }
  if (subscribers.size > 0) rafId = requestAnimationFrame(frame);
  else last = 0;
}

/**
 * Subscribe to the single shared animation loop. One rAF drives every avatar
 * on screen; the loop stops by itself when nothing is subscribed.
 * Returns the unsubscribe function (cancels the rAF when it was the last one).
 */
export function subscribeTicker(fn: TickFn): () => void {
  subscribers.add(fn);
  if (!rafId && typeof requestAnimationFrame === 'function') {
    last = 0;
    rafId = requestAnimationFrame(frame);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      last = 0;
    }
  };
}

/** For tests / diagnostics. */
export function tickerSize(): number {
  return subscribers.size;
}

// ---------------- springs ----------------

export interface Spring {
  x: number;
  v: number;
  target: number;
  /** angular frequency ω = 2πf */
  omega: number;
  /** damping ratio ζ (1 = critical) */
  zeta: number;
}

export const spring = (freqHz: number, zeta: number, x = 0): Spring => ({
  x,
  v: 0,
  target: x,
  omega: 2 * Math.PI * freqHz,
  zeta,
});

const STEP = 1 / 120;

/** Advance springs by dt using fixed 120 Hz semi-implicit Euler substeps. */
export function stepSprings(springs: readonly Spring[], dt: number, carry: { acc: number }): void {
  carry.acc += dt;
  while (carry.acc >= STEP) {
    carry.acc -= STEP;
    for (const s of springs) {
      const a = -s.omega * s.omega * (s.x - s.target) - 2 * s.zeta * s.omega * s.v;
      s.v += a * STEP; // velocity first …
      s.x += s.v * STEP; // … then position with the new velocity
    }
  }
}

// ---------------- blink ----------------

/** Blink length in seconds; the lid is fully shut at 45 % of it. */
export const BLINK_DURATION = 0.26;
const BLINK_PEAK = 0.45;

/** Lid closure (0..1) at time t seconds into a blink; 0 outside the blink. */
export function blinkLid(t: number): number {
  if (t <= 0 || t >= BLINK_DURATION) return 0;
  const u = t / BLINK_DURATION;
  if (u < BLINK_PEAK) {
    const k = u / BLINK_PEAK;
    return k * k * (3 - 2 * k);
  }
  const k = (u - BLINK_PEAK) / (1 - BLINK_PEAK);
  return 1 - k * k * (3 - 2 * k);
}

// ---------------- PRNG ----------------

/** Small deterministic PRNG (mulberry32-style). */
export function prng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to give each avatar its own stable rhythm. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------- pointer (shared) ----------------

export const pointer = { x: 0, y: 0, t: -Infinity };
let pointerRefs = 0;
const onPointer = (e: PointerEvent) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.t = performance.now() / 1000;
};

/** Ref-counted global pointermove listener for gaze following. */
export function retainPointer(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (pointerRefs++ === 0) window.addEventListener('pointermove', onPointer, { passive: true });
  return () => {
    if (--pointerRefs === 0) window.removeEventListener('pointermove', onPointer);
  };
}
