import { useEffect, useState } from 'react';
import { activeTab, documentTabs, useDocumentStore } from './document-store';
import { analyzeContext } from './ai-context-analysis';
import { contextAnalysisCache } from './ai-context-cache';

/** Analysis has its own lifetime: edits keep the old snapshot useful, while losing
 * focus, hiding the panel or starting an AI task cancels its dedicated Worker. */
export function useContextAnalysis(visible: boolean, busy: boolean, documentId: string) {
  const [focused, setFocused] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
  const [, changed] = useState(0);
  useEffect(() => contextAnalysisCache.subscribe(() => changed((n) => n + 1)), []);
  useEffect(() => {
    const update = () => setFocused(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    contextAnalysisCache.retain([...documentTabs.values()].map((tab) => tab.session.document.documentId));
    if (!visible || !focused || busy) return;
    let timer: number | undefined,
      idle: number | undefined,
      running = false,
      stopped = false;
    let lastInput = performance.now();
    const controller = new AbortController();
    const clear = () => {
      clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
    };
    const schedule = () => {
      clear();
      if (stopped || running) return;
      const doc = activeTab().session.document;
      const delay = Math.max(contextAnalysisCache.delay(doc), 2000 - (performance.now() - lastInput));
      if (!Number.isFinite(delay)) return;
      timer = window.setTimeout(() => {
        idle = requestIdleCallback(
          () => {
            running = true;
            const snapshot = activeTab().session.document;
            const start = performance.now();
            contextAnalysisCache.start(snapshot.documentId, start);
            void analyzeContext(snapshot, controller.signal)
              .then((analysis) => {
                if (!stopped) contextAnalysisCache.remember(snapshot, analysis, performance.now() - start);
              })
              .catch(() => {
                // Keep the previous approximate value if a background refresh fails.
              })
              .finally(() => {
                contextAnalysisCache.finish(snapshot.documentId, performance.now() - start);
                running = false;
                schedule();
              });
          },
          { timeout: 1000 },
        );
      }, delay);
    };
    const input = () => {
      lastInput = performance.now();
      schedule();
    };
    const pointer = (event: PointerEvent) => {
      if (event.buttons) input();
    };
    window.addEventListener('input', input, true);
    window.addEventListener('keydown', input, true);
    window.addEventListener('pointerdown', input, true);
    window.addEventListener('pointermove', pointer, true);
    const unsubscribe = useDocumentStore.subscribe(schedule);
    const uncache = contextAnalysisCache.subscribe(schedule);
    schedule();
    return () => {
      stopped = true;
      controller.abort();
      clear();
      unsubscribe();
      uncache();
      window.removeEventListener('input', input, true);
      window.removeEventListener('keydown', input, true);
      window.removeEventListener('pointerdown', input, true);
      window.removeEventListener('pointermove', pointer, true);
    };
  }, [visible, focused, busy, documentId]);
  return { analysis: contextAnalysisCache.get(documentId)?.analysis, stats: contextAnalysisCache.stats(documentId) };
}
