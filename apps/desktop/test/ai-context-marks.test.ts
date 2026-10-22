import { expect, it, vi } from 'vitest';
import { readContextMarks } from '../src/renderer/src/ai-integration';
import { parseContextMarks } from '../src/renderer/src/ai-context';

vi.mock('../src/renderer/src/document-store', () => ({
  activeTab: () => undefined,
  setDocumentLock: vi.fn(),
}));
vi.mock('../src/renderer/src/mesh-client', () => ({
  sourceMeshes: new Map(),
  getMesh: vi.fn(),
  clearMeshCache: vi.fn(),
  retainMeshes: vi.fn(),
}));

it('returns empty context marks without throwing or warning when no tab is active', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(() => readContextMarks()).not.toThrow();
    expect(readContextMarks()).toEqual({ version: 1, clearedTurnIds: [], discardedTurnIds: [] });
    expect(readContextMarks()).toEqual(parseContextMarks(undefined).marks);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
