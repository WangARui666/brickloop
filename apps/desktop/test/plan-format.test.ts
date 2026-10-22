import { expect, it } from 'vitest';
import { createI18n } from '@brickloop/i18n';
import { formatBoxCorner } from '../src/renderer/src/plan-format';

it.each([
  [{ x: 9, y: 9, z: 9 }, '9, 9, 9'],
  [{ x: 4, y: 1.2, z: 2 }, '4, 1.2, 2'],
  [{ x: -1.236, y: 12.344, z: 2.999 }, '-1.24, 12.34, 3'],
  [{ x: -0.001, y: 0.0051, z: 123456.781 }, '0, 0.01, 123456.78'],
] as const)('formats a max corner as x, y, z with at most two decimals: %j', (corner, text) => {
  expect(formatBoxCorner(corner)).toBe(text);
});

it.each(['zh-CN', 'en'] as const)('describes the component and max corners in %s without JSON', (language) => {
  const i18n = createI18n({ language });
  const text = i18n.t('imageUi.planRepairs.boxDetail', {
    n: 2,
    component: 'Roof',
    from: formatBoxCorner({ x: 9, y: 9, z: 9 }),
    to: formatBoxCorner({ x: 4, y: 1.2, z: 2 }),
  });
  expect(text).toBe(
    language === 'zh-CN'
      ? '第 2 个部件“Roof”：包围盒终点由 (9, 9, 9) 改为 (4, 1.2, 2)，按宽、深、高重算。'
      : 'Component 2 “Roof”: bounding-box end changed from (9, 9, 9) to (4, 1.2, 2), recalculated from width, depth and height.',
  );
});
