import { AssemblyEngine } from './assembly-engine';
import type { AssemblySnapshot } from './assembly-engine';

/** One worker-local engine. Snapshots cross structured-clone boundaries, so compare
 * part definitions by value before using AssemblyEngine's existing delta sync. */
export class AiCheckEngine {
  private engine = new AssemblyEngine();
  private documentId: string | undefined;
  private parts = new Map<string, string>();

  sync(snapshot: AssemblySnapshot): AssemblyEngine {
    if (this.documentId !== snapshot.doc.documentId) {
      this.engine = new AssemblyEngine();
      this.parts.clear();
      this.documentId = snapshot.doc.documentId;
    }
    const signatures = new Map(snapshot.parts.map(([id, part]) => [id, JSON.stringify(part)]));
    try {
      this.engine.sync(
        {
          ...snapshot,
          parts: snapshot.parts.filter(([id]) => this.parts.get(id) !== signatures.get(id)),
        },
        false,
      );
      this.parts = signatures;
      return this.engine;
    } catch (error) {
      // A failed sync can have partially changed the indexes; the next full snapshot repairs them.
      this.documentId = undefined;
      throw error;
    }
  }
}
