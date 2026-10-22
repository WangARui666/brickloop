import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { launchElectron } from '../e2e/electron-launch';
import type { ElectronApplication } from '@playwright/test';
import { evaluationCases } from '../../../packages/ai/src/evaluation';
import { redact } from '../../../packages/ai/src/secrets';
import type { WorkflowReport } from '@brickloop/ai';
import type { AiProvider } from '../src/shared/ai-api';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const profile = path.join(root, '.devdata/ai-eval-profile'),
  resultsRoot = path.join(root, '.devdata/ai-eval-results');
const exec = promisify(execFile);
const endpoints = {
  openai: 'https://api.openai.com/v1',
  compatible: 'http://127.0.0.1:11434/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

export async function runEvaluation(args = process.argv.slice(2)) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!,
      value = args[index + 1];
    if (!['--provider', '--model', '--base-url', '--cases'].includes(key) || !value || value.startsWith('--'))
      throw new Error(
        'Use --provider <openai|compatible|anthropic|gemini> --model <name> [--base-url <url>] [--cases <id,prefix,…>]',
      );
    values.set(key, value);
  }
  const provider = values.get('--provider'),
    model = values.get('--model'),
    key = process.env.BRICKLOOP_EVAL_API_KEY;
  if (!provider || !(provider in endpoints) || !model)
    throw new Error('A supported --provider and --model are required.');
  if (!key) throw new Error('BRICKLOOP_EVAL_API_KEY is required.');
  const filters = values.get('--cases')?.split(',').filter(Boolean) ?? [];
  const cases = evaluationCases.filter(
    (c) => !filters.length || filters.some((f) => c.id.startsWith(f) || c.prompt.includes(f)),
  );
  if (!cases.length) throw new Error('No matching evaluation cases.');
  // Never delete an existing profile: it may belong to an interrupted run requiring inspection.
  if (
    await stat(profile).then(
      () => true,
      () => false,
    )
  )
    throw new Error('The evaluation profile already exists: .devdata/ai-eval-profile');
  await exec(
    process.execPath,
    [
      path.join(root, 'scripts/devenv.mjs'),
      'pnpm',
      '-F',
      '@brickloop/desktop',
      'exec',
      'electron-vite',
      'build',
      '--mode',
      'test',
    ],
    { cwd: root, maxBuffer: 4_000_000, windowsHide: true },
  );
  const output = path.join(resultsRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(output, { recursive: true });
  await mkdir(profile, { recursive: true });
  let app: ElectronApplication | undefined;
  const records: {
    id: string;
    valid: boolean;
    partCount: number | null;
    colorCount: number | null;
    connectedComponents: number | null;
    issues: WorkflowReport['validation'];
    views: { view: string; iou: number; colorDifference: number | null; round: number }[];
    elapsedMs: number;
    cost: number | null;
    reason: string;
  }[] = [];
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const clean = (value: string) => redact(value, [key]);
  try {
    app = await launchElectron({
      args: [desktop],
      env: { ...env, BRICKLOOP_DATA_DIR: profile, BRICKLOOP_AI_EVAL: '1' },
      timeout: 45000,
    });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-library-ready="true"]', { timeout: 60000 });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    const providerId = randomUUID();
    await page.evaluate(
      async (p) => {
        const snapshot = await window.brickloop.aiSaveProvider(p);
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, history: false, debug: false });
      },
      {
        id: providerId,
        type: provider as AiProvider['type'],
        name: provider,
        endpoint: values.get('--base-url') ?? endpoints[provider as keyof typeof endpoints],
        model,
        models: [model],
        proxy: 'system',
        proxyUrl: '',
      } satisfies AiProvider,
    );
    for (const test of cases) {
      const images = await Promise.all(
        test.references.map(async (ref) => ({
          name: ref.view,
          view: ref.view,
          image: {
            type: 'image' as const,
            mime: 'image/png' as const,
            base64: (await readFile(path.join(root, 'packages/ai/test/ai-eval', ref.asset))).toString('base64'),
          },
        })),
      );
      await page.evaluate(
        async ({ providerId, model, test, images }) => {
          window.brickloopEditorTest.action('file.new');
          const id = await window.brickloopEditorTest.imageStart({
            providerId,
            model,
            input: {
              description: test.prompt,
              images,
              style: '',
              targetSize: { width: 16 },
              palette: { source: 'factory' },
              parts: { source: 'factory' },
            },
            directStart: true,
            budget: { toolCalls: 400, durationMs: 1800000 },
          });
          if (!id) throw new Error('EVALUATION_START_FAILED');
        },
        { providerId, model, test, images },
      );
      await page.waitForFunction(() => !window.brickloopEditorTest.aiState().running, undefined, { timeout: 1860000 });
      const data = await page.evaluate(async () => ({
        turn: [...window.brickloopEditorTest.aiState().turns].reverse().find((t) => !!t.report),
        summary: await window.brickloopEditorTest.modelSummary(),
      }));
      const report = data.turn?.report;
      if (!report) throw new Error('EVALUATION_REPORT_MISSING');
      const summary = data.summary as { ok: boolean; data?: { connectedComponents?: number } },
        components = summary.ok ? (summary.data?.connectedComponents ?? null) : null;
      const views = [
        ...new Map(report.comparisons.filter((c) => c.componentId === null).map((c) => [c.referenceId, c])).values(),
      ];
      records.push({
        id: test.id,
        valid:
          (report.partCount ?? 0) > 0 &&
          components === 1 &&
          report.validation.checked &&
          report.validation.issues.length === 0,
        partCount: report.partCount,
        colorCount: report.colorCount,
        connectedComponents: components,
        issues: report.validation,
        views: views.map((c) => ({ view: c.view, iou: c.iou, colorDifference: c.colorDifference, round: c.round })),
        elapsedMs: report.elapsedMs,
        cost: data.turn?.cost?.amount ?? null,
        reason: report.reason,
      });
      const validRate = records.filter((r) => r.valid).length / records.length;
      await writeFile(
        path.join(output, 'results.json'),
        clean(JSON.stringify({ provider, model, validRate, records }, null, 2)) + '\n',
      );
      const markdown =
        `# AI evaluation\n\nProvider: ${provider} · Model: ${model}\n\nValidity: ${(validRate * 100).toFixed(1)}% (${records.filter((r) => r.valid).length}/${records.length})\n\n| Case | Valid | Views / IoU | Parts | Colors | Time (s) | Cost (USD) | Stop reason |\n|---|---|---|---:|---:|---:|---:|---|\n` +
        records
          .map(
            (r) =>
              `| ${r.id} | ${r.valid} | ${r.views.map((v) => `${v.view}: ${v.iou.toFixed(4)}`).join(', ')} | ${r.partCount ?? 'unknown'} | ${r.colorCount ?? 'unknown'} | ${(r.elapsedMs / 1000).toFixed(1)} | ${r.cost ?? 'unpriced'} | ${r.reason} |`,
          )
          .join('\n') +
        '\n';
      await writeFile(path.join(output, 'summary.md'), clean(markdown));
      console.log(`${test.id}: ${report.reason}`);
    }
    console.log(`Evaluation results: ${path.relative(root, output)}`);
    return output;
  } finally {
    if (app) {
      const page = app.windows()[0];
      await page
        ?.evaluate(async () => {
          await window.brickloop.aiStop();
          window.brickloopEditorTest.prepareClose();
        })
        .catch(() => undefined);
      await app.close();
    }
    // This exact path was created above, is owned by this run, and stays inside the repository.
    await rm(profile, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvaluation().catch(() => {
    console.error('Evaluation failed. Check arguments, BRICKLOOP_EVAL_API_KEY and the selected endpoint.');
    process.exitCode = 1;
  });
}
