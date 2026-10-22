import { contextModelSummary, estimateContext } from './ai-context';

self.onmessage = (
  event: MessageEvent<
    Omit<Parameters<typeof estimateContext>[0], 'summary'> & {
      analysis: Parameters<typeof contextModelSummary>[0];
      activeModelPath: string[];
    }
  >,
) => {
  const started = performance.now();
  const usage = estimateContext({
    ...event.data,
    summary: contextModelSummary(event.data.analysis, event.data.activeModelPath),
  });
  self.postMessage({ usage, calculationMs: performance.now() - started });
};
