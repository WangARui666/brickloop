import { expect, it } from 'vitest';
import { createDocument, DocumentSession } from '@brickloop/core';
import { DocumentProjection } from '../../../packages/viewport/src/document-projection';
import { ReviewLayer } from '../../../packages/viewport/src/review-layer';

it('review masks own buffers independently of the live document when replaced or disposed', () => {
  const projection = new DocumentProjection();
  const session = new DocumentSession(createDocument());
  session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
  projection.sync(session.document, session.workspace, [
    {
      id: 'c:red',
      legoName: 'Red',
      nameZh: '红',
      legoColorId: 21,
      ldrawCode: 4,
      rgb: '#ff0000',
      edgeRgb: '#220000',
      finish: 'solid',
      alpha: 1,
    },
  ]);
  const source = projection.definitions.get('ld:3001')!.geometry;
  const review = new ReviewLayer(projection);
  try {
    review.set({ added: [projection.rows[0]!.path], changed: [], moved: [], ghosts: [], visible: true });
    const mask = review.maskRoot.children[0] as unknown as { geometry: typeof source };
    expect(mask.geometry.index).not.toBe(source.index);
    expect(mask.geometry.index!.array).toEqual(source.index!.array);
    expect(mask.geometry.index!.array.buffer).not.toBe(source.index!.array.buffer);
    expect(mask.geometry.getAttribute('position')).not.toBe(source.getAttribute('position'));
    review.set(null);
    expect(projection.rows).toHaveLength(1);
  } finally {
    review.dispose();
    projection.dispose();
  }
});
