import { afterEach, expect, it, vi } from 'vitest';
import { themeColor } from '@brickloop/viewport';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['  #2468AC  ', '#2468AC'],
  ['', '#17191F'],
])('exports themeColor through the package entry for computed value %j', (css, expected) => {
  const surface = {} as Parameters<typeof themeColor>[0];
  const getPropertyValue = vi.fn(() => css);
  const getComputedStyle = vi.fn(() => ({ getPropertyValue }));
  vi.stubGlobal('getComputedStyle', getComputedStyle);
  expect(themeColor(surface, 'viewport-bottom')).toBe(expected);
  expect(getComputedStyle).toHaveBeenCalledExactlyOnceWith(surface);
  expect(getPropertyValue).toHaveBeenCalledExactlyOnceWith('--bl-viewport-bottom');
});
