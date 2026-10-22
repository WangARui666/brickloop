import { pinyin } from 'pinyin-pro';

/** Longest terms win. Unknown text stays visible for later factory corrections. */
export const TERMS_ZH: Readonly<Record<string, string>> = {
  'Studs on Side': '侧面凸点',
  'Stud on Side': '侧面凸点',
  'with Clip': '带夹',
  'with Bar': '带杆',
  'with Handle': '带把手',
  Baseplate: '底板',
  Brick: '砖',
  Plate: '板',
  Tile: '平滑板',
  Slope: '斜面',
  Wedge: '楔形',
  Round: '圆形',
  Modified: '改装',
  Arch: '拱形',
  Bracket: '支架',
  Hinge: '铰链',
  Clip: '夹',
  Bar: '杆',
  Technic: '科技',
  Axle: '十字轴',
  Pin: '销',
  Beam: '梁',
  Gear: '齿轮',
  Wheel: '车轮',
  Tyre: '轮胎',
  Tire: '轮胎',
  Window: '窗',
  Door: '门',
  Panel: '面板',
  Cone: '圆锥',
  Cylinder: '圆柱',
  Dish: '碟',
  Plant: '植物',
  Minifig: '人仔',
  Pattern: '印刷',
  with: '带',
  Inverted: '倒置',
  Curved: '曲面',
  Corner: '转角',
  Ball: '球',
  Socket: '球窝',
  Joint: '关节',
  Hole: '孔',
  Grille: '格栅',
  Jumper: '跳板',
  Studs: '凸点',
  Stud: '凸点',
  Head: '头',
  Torso: '躯干',
  Arm: '手臂',
  Hand: '手',
  Legs: '腿',
  Hips: '髋',
  Reinforced: '加强',
  Open: '开口',
  Closed: '封闭',
  Centre: '中心',
  Center: '中心',
  Side: '侧面',
  Handle: '把手',
  Horizontal: '水平',
  Vertical: '竖直',
  Left: '左',
  Right: '右',
  Small: '小',
  Large: '大',
  Thin: '薄',
  Thick: '厚',
  Assembly: '组件',
  Flexible: '柔性',
  Sticker: '贴纸',
  and: '和',
  without: '无',
};

export const SYNONYMS: Readonly<Record<string, string>> = {
  砖块: '砖',
  光面板: '平滑板',
  光滑板: '平滑板',
  科技轴: '十字轴',
  轮皮: '轮胎',
  zk: '砖',
};

const terms = Object.keys(TERMS_ZH).sort((a, b) => b.length - a.length);
const termPattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'gi');
const lowerTerms = new Map(Object.entries(TERMS_ZH).map(([en, zh]) => [en.toLowerCase(), zh]));

export function translateTitle(title: string): string {
  let text = title.trim().replace(/\s+/g, ' ');
  text = text.replace(/\bSlope\s+(\d+(?:\.\d+)?)(?=\s+\d)/i, 'Slope $1°');
  // Chinese shape adjectives precede the base noun, while dimensions stay intact.
  text = text.replace(/^(Brick|Plate|Tile)\s+(.+?)\s+Round\b/i, 'Round $1 $2');
  text = text.replace(/^(Brick|Plate|Tile)\s+Round\b/i, 'Round $1');
  text = text.replace(termPattern, (word) => lowerTerms.get(word.toLowerCase()) ?? word);
  return text
    .replace(/(\d)\s*[x×*]\s*(?=\d)/gi, '$1×')
    .replace(/圆形\s+(砖|板|平滑板)/g, '圆形$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pinyinKeywords(text: string): string[] {
  return [
    pinyin(text, { toneType: 'none', type: 'array' }).join(''),
    pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join(''),
  ];
}

export function normalizeSearch(text: string): string {
  let value = text
    .toLowerCase()
    .replace(/(\d)\s*[x×*]\s*(?=\d)/gi, '$1x')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [alias, canonical] of Object.entries(SYNONYMS)) {
    value = alias === 'zk' ? value.replace(/\bzk\b/g, canonical) : value.replaceAll(alias, canonical);
  }
  return value;
}
