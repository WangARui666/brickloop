import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession } from '@brickloop/core';
import {
  activeTab,
  documentSession,
  documentTabs,
  registerDocumentRenderer,
  removeDocument,
} from '../src/renderer/src/document-store';
import { canAskSelection } from '../src/renderer/src/ask-store';

vi.mock('../src/renderer/src/mesh-client', () => ({
  sourceMeshes: new Map(),
  clearMeshCache: vi.fn(),
  getMesh: vi.fn(),
  retainMeshes: vi.fn(),
}));

const initialTab = activeTab();
afterEach(() => {
  documentTabs.clear();
  documentTabs.set(initialTab.session.document.documentId, initialTab);
  registerDocumentRenderer(() => {});
});

describe('M12-29 final document teardown', () => {
  it('stops rendering and subscriptions before deleting the last active tab', async () => {
    const unmount = vi.fn(() => {
      expect(activeTab()).toBe(initialTab);
      expect(() => canAskSelection()).not.toThrow();
    });
    registerDocumentRenderer(unmount);
    await removeDocument(documentSession.document.documentId, false);
    expect(unmount).toHaveBeenCalledExactlyOnceWith();
    expect(documentTabs.size).toBe(0);
  });

  it('keeps the renderer mounted while other documents remain', async () => {
    const session = new DocumentSession(createDocument());
    documentTabs.set(session.document.documentId, { ...initialTab, session });
    const unmount = vi.fn();
    registerDocumentRenderer(unmount);
    await removeDocument(session.document.documentId, false);
    expect(unmount).not.toHaveBeenCalled();
    expect(activeTab()).toBe(initialTab);
    expect(documentTabs.size).toBe(1);
  });
});
