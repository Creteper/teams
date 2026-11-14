import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AVATAR_COLORS,
  AVATAR_COLOR_HEX,
  AVATAR_SHAPES,
  BotAvatar,
  getShapeDef,
  resolveColor,
  resolveFill,
  resolveShape,
} from './index';
import { bbox } from './geometry';
import { blinkLid, BLINK_DURATION, tickerSize } from './motion';

afterEach(cleanup);

describe('tables', () => {
  it('lists all 25 shapes, unique, each with valid geometry inside the viewBox', () => {
    expect(AVATAR_SHAPES).toHaveLength(25);
    expect(new Set(AVATAR_SHAPES).size).toBe(25);
    for (const s of AVATAR_SHAPES) {
      const def = getShapeDef(s);
      expect(def.d.startsWith('M')).toBe(true);
      expect(def.d).not.toMatch(/NaN|Infinity/);
      const b = bbox(def.pts);
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeLessThanOrEqual(100);
      expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeGreaterThan(120);
    }
  });

  it('lists all 11 colours with hex values', () => {
    expect([...AVATAR_COLORS]).toEqual([
      'black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray',
    ]);
    for (const c of AVATAR_COLORS) {
      const sw = AVATAR_COLOR_HEX[c];
      for (const v of [sw.base, sw.light, sw.dark]) expect(v).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(Object.keys(AVATAR_COLOR_HEX).sort()).toEqual([...AVATAR_COLORS].sort());
    expect(AVATAR_COLOR_HEX.blue.base).toBe('#1084FE');
  });
});

describe('fallbacks', () => {
  it('resolves known values case-insensitively and via aliases', () => {
    expect(resolveShape(' Squircle ')).toBe('squircle');
    expect(resolveShape('sphere')).toBe('blob');
    expect(resolveShape('heartChubby')).toBe('heart');
    expect(resolveColor('BLUE')).toBe('blue');
    expect(resolveColor('grey')).toBe('gray');
  });

  it('falls back to blob / black for unknown, empty or non-string values', () => {
    for (const v of ['pumpkin-xl', '', undefined, null, 42, {}]) {
      expect(resolveShape(v)).toBe('blob');
      expect(resolveColor(v)).toBe('black');
    }
    expect(resolveFill('nope')).toBe('#000000');
    expect(resolveFill('#12abef')).toBe('#12abef');
    expect(resolveFill('black', 'dark')).toBe('#FFFFFF');
  });

  it('renders unknown shape/color without throwing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<BotAvatar shape="does-not-exist" color="ultraviolet" size={40} animated={false} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-shape')).toBe('blob');
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('#000000');
    expect(svg.getAttribute('width')).toBe('40');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('renders every shape × colour combination', () => {
    for (const s of AVATAR_SHAPES)
      for (const c of AVATAR_COLORS) {
        const { container, unmount } = render(<BotAvatar shape={s} color={c} size={24} animated={false} />);
        const path = container.querySelector('path')!;
        expect(path.getAttribute('fill')).toBe(AVATAR_COLOR_HEX[c].base);
        expect(path.getAttribute('fill-rule')).toBe('evenodd');
        // body + 2 cut-out eyes = 3 sub-paths
        expect(path.getAttribute('d')!.match(/M/g)).toHaveLength(3);
        unmount();
      }
  });
});

describe('animation lifecycle', () => {
  it('blink curve is shut at 45 % and open at both ends', () => {
    expect(blinkLid(0)).toBe(0);
    expect(blinkLid(BLINK_DURATION * 0.45)).toBeCloseTo(1, 5);
    expect(blinkLid(BLINK_DURATION)).toBe(0);
  });

  it('animated=false never subscribes; animated avatars unsubscribe on unmount', () => {
    // jsdom has no IntersectionObserver -> avatars count as visible
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const caf = vi.spyOn(window, 'cancelAnimationFrame');
    const still = render(<BotAvatar shape="hex" color="red" size={32} animated={false} />);
    expect(tickerSize()).toBe(0);
    still.unmount();

    let view: ReturnType<typeof render>;
    act(() => {
      view = render(
        <>
          <BotAvatar shape="hex" color="red" size={32} />
          <BotAvatar shape="cloud" color="blue" size={32} />
        </>,
      );
    });
    expect(tickerSize()).toBe(2);
    expect(raf).toHaveBeenCalledTimes(1); // one shared loop for all avatars
    act(() => view.unmount());
    expect(tickerSize()).toBe(0);
    expect(caf).toHaveBeenCalled();
    raf.mockRestore();
    caf.mockRestore();
  });

  it('prefers-reduced-motion makes avatars static', () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const v = render(<BotAvatar shape="egg" color="green" size={32} />);
    expect(tickerSize()).toBe(0);
    v.unmount();
    window.matchMedia = orig;
  });
});
