import { expect, it } from 'vitest';
import { shapeCategories, shapeCategory } from '../src/shared/catalog-categories';
it('presents all 22 shape groups in A-23 order and classifies modified/round forms before base forms', () => {
  expect(shapeCategories.map((c) => c.nameZh)).toEqual([
    '砖',
    '圆砖',
    '改装砖',
    '斜面',
    '曲面斜面',
    '倒斜面',
    '板',
    '圆板',
    '改装板',
    '平滑板',
    '圆形平滑板',
    '楔形',
    '拱',
    '支架',
    '铰链',
    '杆与夹',
    '科技件',
    '车轮与轮胎',
    '门窗',
    '植物',
    '人仔',
    '其他',
  ]);
  expect(shapeCategory({ nameEn: 'Brick Round 2 x 2', categoryId: 'brick' })).toBe('shape-round-brick');
  expect(shapeCategory({ nameEn: 'Slope Brick Curved 2 x 2', categoryId: 'slope' })).toBe('shape-curved-slope');
  expect(shapeCategory({ nameEn: 'Plate 1 x 2 with Clip', categoryId: 'plate' })).toBe('shape-modified-plate');
});
