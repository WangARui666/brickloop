import fontkit from '@pdf-lib/fontkit';

interface CffDictionary {
  FDSelect: { fds: number[] };
}
interface CffSubset {
  cff: { length?: number; fdForGlyph(id: number): number };
  glyphs: number[];
  subsetFontdict(dictionary: CffDictionary): void;
}

/**
 * Compatibility adapter for the pinned @pdf-lib/fontkit 1.1.1:
 * - CFFSubset.subsetFontdict assigns repeat FDs to the last FD, rather than
 *   the FD first assigned to that glyph. Noto CJK uses several private dicts.
 * - CFFSubset.encode reads cff.length for the header offSize, but that field
 *   is absent, producing an invalid zero offSize.
 * Group only the FD/subroutine pass, then restore its selection to the
 * original glyph order. Charstrings, PDF CIDs and ToUnicode stay unchanged.
 * No global prototypes or dependency files are modified.
 */
export const instructionFontkit: typeof fontkit = {
  ...fontkit,
  create(bytes) {
    const font = fontkit.create(bytes);
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => {
      const subset = createSubset();
      // These internals are specific to the pinned CFF implementation; TTF
      // subsets use a different encoder and need no adjustment.
      const cffSubset = subset as unknown as CffSubset;
      if (cffSubset.cff && typeof cffSubset.subsetFontdict === 'function') {
        cffSubset.cff.length = 4;
        const subsetFontdict = cffSubset.subsetFontdict;
        cffSubset.subsetFontdict = function (dictionary) {
          const original = this.glyphs;
          this.glyphs = [...original].sort((a, b) => this.cff.fdForGlyph(a) - this.cff.fdForGlyph(b));
          try {
            subsetFontdict.call(this, dictionary);
            const selections = new Map(this.glyphs.map((glyph, index) => [glyph, dictionary.FDSelect.fds[index]!]));
            dictionary.FDSelect.fds = original.map((glyph) => selections.get(glyph)!);
          } finally {
            this.glyphs = original;
          }
        };
      }
      return subset;
    };
    return font;
  },
};
