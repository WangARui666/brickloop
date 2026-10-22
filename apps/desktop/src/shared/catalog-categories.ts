import type { Category, PartDef } from '@brickloop/catalog';
const shapes = [
  ['brick', '砖', 'Bricks'],
  ['round-brick', '圆砖', 'Round bricks'],
  ['modified-brick', '改装砖', 'Modified bricks'],
  ['slope', '斜面', 'Slopes'],
  ['curved-slope', '曲面斜面', 'Curved slopes'],
  ['inverted-slope', '倒斜面', 'Inverted slopes'],
  ['plate', '板', 'Plates'],
  ['round-plate', '圆板', 'Round plates'],
  ['modified-plate', '改装板', 'Modified plates'],
  ['tile', '平滑板', 'Tiles'],
  ['round-tile', '圆形平滑板', 'Round tiles'],
  ['wedge', '楔形', 'Wedges'],
  ['arch', '拱', 'Arches'],
  ['bracket', '支架', 'Brackets'],
  ['hinge', '铰链', 'Hinges'],
  ['bar-clip', '杆与夹', 'Bars and clips'],
  ['technic', '科技件', 'Technic'],
  ['wheel-tyre', '车轮与轮胎', 'Wheels and tyres'],
  ['door-window', '门窗', 'Doors and windows'],
  ['plant', '植物', 'Plants'],
  ['minifig', '人仔', 'Minifigures'],
  ['other', '其他', 'Other'],
] as const;
export const shapeCategories: Category[] = shapes.map(([id, nameZh, nameEn], order) => ({
  id: `shape-${id}`,
  nameZh,
  nameEn,
  parentId: null,
  order,
}));
export function shapeCategory(part: Pick<PartDef, 'nameEn' | 'categoryId'>): string {
  const title = part.nameEn.toLowerCase(),
    category = part.categoryId;
  let shape = 'other';
  if (category.startsWith('technic')) shape = 'technic';
  else if (category.startsWith('minifig')) shape = 'minifig';
  else if (/^(wheel|tyre|tire)/.test(category)) shape = 'wheel-tyre';
  else if (/^(door|window)/.test(category)) shape = 'door-window';
  else if (category.startsWith('plant')) shape = 'plant';
  else if (category.startsWith('slope'))
    shape = /inverted/.test(title) ? 'inverted-slope' : /curved/.test(title) ? 'curved-slope' : 'slope';
  else if (/^(brick|plate|tile)$/.test(category)) {
    shape = category;
    if (/\b(round|cylinder|cone|quarter|half round)\b/.test(title)) shape = `round-${category}`;
    else if (category !== 'tile' && /\b(with|modified|grille)\b/.test(title)) shape = `modified-${category}`;
  } else if (/^(bar|clip)/.test(category)) shape = 'bar-clip';
  else if (['wedge', 'arch', 'bracket', 'hinge'].includes(category)) shape = category;
  return `shape-${shape}`;
}
