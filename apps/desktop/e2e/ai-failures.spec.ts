import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectron } from './electron-launch';
import { imageModelServer } from './image-model-fixture';
import { fakeModel, livenessSession } from './ai-model-fixture';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const shots = path.join(root, '.devdata/e2e-results/m12-1');
const fakeKey = 'sk-test-123';

async function expectRetainedFailure(
  page: Page,
  taskId: string,
  parts: number,
  server: Awaited<ReturnType<typeof imageModelServer>>,
  expected: { providerId: string; request: string; category: string; code: string },
) {
  await expect
    .poll(() => page.evaluate((id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)?.status, taskId))
    .toBe('merged');
  expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(parts);
  await expect(page.getByTestId('review-bar')).toBeVisible();
  await expect(page.locator(`[data-task-id="${taskId}"] .ai-context-summarized`)).toHaveText('已以摘要计入');
  await expect(page.locator(`[data-task-id="${taskId}"] .ai-context-excluded`)).toHaveCount(0);
  await expect(page.getByTestId('ai-context-bar')).toContainText('1 轮');
  server.controls.failure = null;
  const before = server.requests.length;
  const followup = await page.evaluate(
    (providerId) =>
      window.brickloop.aiStart({
        providerId,
        model: 'deepseek-flash',
        effort: 'balanced',
        text: '只说明当前进度，不修改模型',
        images: [],
        selection: false,
        modelContext: true,
      }),
    expected.providerId,
  );
  await expect
    .poll(() =>
      page.evaluate((id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)?.status, followup),
    )
    .toBe('merged');
  expect(server.requests).toHaveLength(before + 1);
  const history = server.requests[before]!.messages.slice(1, -1);
  expect(history).toHaveLength(1);
  expect(history[0]?.role).toBe('user');
  const content = history[0]!.content;
  const summary = typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('\n');
  expect(summary).toContain('[失败回合摘要（已保留修改）]');
  expect(summary).toContain(`用户请求：${expected.request}`);
  expect(summary).toContain(`失败原因：${JSON.stringify({ category: expected.category, code: expected.code })}`);
  const edits = JSON.parse(summary.split('已完成修改：')[1]!) as Record<string, unknown>;
  expect(edits).toMatchObject({ added: parts, modified: 0, deleted: 0 });
  expect(JSON.stringify(history)).not.toContain('tool_calls');
  expect(JSON.stringify(history)).not.toContain('tool_call_id');
  expect(JSON.stringify(history)).not.toContain('image_url');
  await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
  expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual([]);
}

for (const mode of [
  'truncated',
  'http400',
  'http402',
  'chat500',
  'chat500AfterPart',
  'imageConnection',
  'chatConnection',
] as const) {
  test(
    (mode === 'http402' || mode === 'chat500AfterPart' ? 'M12-9b A-113 ' : 'M12-1 ') +
      {
        truncated: 'IMG-10 truncated output recovery',
        http400: 'IMG-11 HTTP 400 report and banner',
        http402: 'HTTP 402 Insufficient Balance report and banner after a successful build',
        chat500: 'AI-09 HTTP 500 turn and debug log',
        chat500AfterPart: 'HTTP 500 retains a placed part for review and undo after retries fail',
        imageConnection: 'M12-6 image round 2 recovers after tools',
        chatConnection: 'M12-6 chat recovers after a tool',
      }[mode],
    async () => {
      test.setTimeout(180000);
      await mkdir(shots, { recursive: true });
      await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
      const directory = await mkdtemp(path.join(root, '.devdata/tmp/ai-failures-'));
      const server = await imageModelServer();
      server.controls.failure = mode;
      let app: ElectronApplication | undefined;
      try {
        const env = Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        );
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.BRICKLOOP_EVAL_API_KEY;
        delete env.BRICKLOOP_AI_EVAL;
        app = await launchElectron({
          args: [desktop],
          env: { ...env, BRICKLOOP_DATA_DIR: directory, BRICKLOOP_TEST_RETRY_DELAY_MS: '1000' },
          timeout: 45000,
        });
        const page = await app.firstWindow();
        await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
          timeout: 45000,
        });
        await page.waitForFunction(() => !!window.brickloopEditorTest);
        const id = randomUUID();
        await page.evaluate(
          async ({ id, endpoint, key }) => {
            const snapshot = await window.brickloop.aiSaveProvider(
              {
                id,
                presetId: 'deepseek',
                name: '离线 DeepSeek 验收',
                type: 'compatible',
                endpoint,
                model: 'deepseek-flash',
                models: ['deepseek-flash'],
                proxy: 'system',
                proxyUrl: '',
                prices: { input: 1, output: 2, cacheRead: 0.1 },
              },
              key,
            );
            await window.brickloop.aiSaveSettings({
              ...snapshot.settings,
              localOnly: true,
              debug: true,
              history: true,
            });
          },
          { id, endpoint: server.endpoint, key: fakeKey },
        );
        await page.reload();
        await page.waitForFunction(() => !!window.brickloopEditorTest);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.keyboard.press('Control+k');
        if (mode === 'chat500' || mode === 'chat500AfterPart' || mode === 'chatConnection') {
          await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('检查模型');
          await page.getByRole('button', { name: '发送', exact: true }).click();
          if (mode === 'chat500' || mode === 'chat500AfterPart') {
            await expect(page.locator('.ai-turn .ai-failure')).toContainText('服务商错误', { timeout: 20000 });
            await expect(page.locator('.ai-turn .ai-failure')).toContainText('HTTP 500');
          } else await expect(page.locator('.ai-turn .ai-activities')).toContainText('临时错误，已重试 1 次');
        } else {
          const base64 = (await readFile(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'))).toString(
            'base64',
          );
          await page.evaluate(
            async ({ id, base64 }) => {
              await window.brickloopEditorTest.imageStart({
                providerId: id,
                model: 'deepseek-flash',
                directStart: true,
                budget: { toolCalls: 400, durationMs: 120000, rounds: 5 },
                input: {
                  description: '按参考图搭建小房子',
                  viewMode: 'fixed',
                  priority: 'buildable',
                  images: [{ name: '正面', view: 'front', image: { type: 'image', mime: 'image/png', base64 } }],
                  targetSize: 'small',
                  palette: { source: 'factory' },
                  parts: { source: 'all' },
                  style: '',
                },
              });
            },
            { id, base64 },
          );
          if (mode === 'imageConnection')
            await expect(page.locator('.image-task-card')).toContainText('秒后第 1 次重试（最多 10 次）', {
              timeout: 90000,
            });
          await expect(page.locator('.image-report')).toBeVisible({ timeout: 120000 });
        }
        await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
        const saved = await page.evaluate(() => {
          const api = window.brickloopEditorTest;
          return { turn: api.aiState().turns.at(-1), history: api.savedHistory(api.snapshot().document.documentId) };
        });
        if (mode === 'truncated') {
          expect(saved.turn?.report?.reason).toBe('completed');
          expect(saved.turn?.report?.partCount).toBeGreaterThan(0);
          await page.locator('.image-report .image-round-timeline summary').first().click();
          await expect(page.locator('.image-report')).toContainText('输出被截断，已重试');
          const requests = server.requests.filter((r) => r.tools?.length);
          expect(requests[1]?.max_tokens).toBe(256000);
          expect(JSON.stringify(requests[1]?.messages)).toContain('that script was not executed');
          expect(JSON.stringify(requests[1]?.messages)).toContain('shorter script or patch');
          expect(saved.history).not.toContain('offline reasoning replay');
        } else if (mode === 'http402') {
          const report = saved.turn?.report;
          expect(report).toMatchObject({
            reason: 'error',
            partCount: 2,
            colorCount: 1,
            transaction: 'committed',
            failure: {
              stage: 'round',
              round: 2,
              attempts: 1,
              error: {
                category: 'quota_exceeded',
                status: 402,
                code: 'invalid_request_error',
                providerMessage: 'Insufficient Balance',
              },
            },
          });
          expect(report?.rounds).toHaveLength(1);
          expect(report?.unfinished).not.toContainEqual({ code: 'counts' });
          expect(report?.summaryZh).toContain('余额或额度不足');
          expect(
            saved.turn?.events.filter(
              (e) => e.type === 'tool_result' && e.call.name === 'run_build_script' && e.result.ok,
            ),
          ).toHaveLength(2);
          expect(saved.turn?.events.filter((e) => e.type === 'retry')).toHaveLength(0);
          for (const locator of [page.locator('.image-report .ai-failure'), page.locator('.ai-panel > .ant-alert')]) {
            await expect(locator).toContainText('余额或额度不足');
            await expect(locator).toContainText('请检查服务商的余额与可用额度。');
            await expect(locator).toContainText('HTTP 402');
            await expect(locator).toContainText('Insufficient Balance');
            await expect(locator).not.toContainText('请求被服务商拒绝');
          }
          await expect(page.locator('.image-report')).not.toContainText('尚未统计');
          expect(saved.history).toContain('"category":"quota_exceeded"');
          expect(saved.history).not.toContain(fakeKey);
          await expectRetainedFailure(page, saved.turn!.id, report!.partCount!, server, {
            providerId: id,
            request: '按参考图搭建小房子',
            category: 'quota_exceeded',
            code: 'invalid_request_error',
          });
        } else if (mode === 'chat500AfterPart') {
          expect(saved.turn?.result).toMatchObject({
            reason: 'error',
            requestAttempts: 11,
            error: { category: 'server', status: 500, code: 'server_error' },
          });
          expect(
            saved.turn?.events.filter((e) => e.type === 'tool_result' && e.call.name === 'place_part' && e.result.ok),
          ).toHaveLength(1);
          expect(saved.turn?.events.filter((e) => e.type === 'retry')).toHaveLength(10);
          expect(server.requests.filter((r) => r.tools?.length)).toHaveLength(12);
          for (const locator of [page.locator('.ai-turn .ai-failure'), page.locator('.ai-panel > .ant-alert')]) {
            await expect(locator).toContainText('服务商错误');
            await expect(locator).toContainText('HTTP 500');
            await expect(locator).toContainText('Offline diagnostic: failed after placement');
          }
          expect(saved.history).toContain('"reason":"error"');
          expect(saved.history).not.toContain(fakeKey);
          await expectRetainedFailure(page, saved.turn!.id, 1, server, {
            providerId: id,
            request: '检查模型',
            category: 'server',
            code: 'server_error',
          });
        } else if (mode === 'imageConnection' || mode === 'chatConnection') {
          const retries = saved.turn?.events.filter((e) => e.type === 'retry');
          expect(retries).toHaveLength(1);
          expect(retries?.[0]).toMatchObject({ attempt: 1, delayMs: 1000, error: { category: 'network' } });
          expect(saved.turn?.text).not.toContain('partial failed response');
          expect(saved.history).toContain('"type":"retry"');
          const repeated = server.requests.filter(
            (r, i) => i > 0 && JSON.stringify(r) === JSON.stringify(server.requests[i - 1]),
          );
          expect(repeated).toHaveLength(1);
          const dataDirectory = await page.evaluate(async () => (await window.brickloop.getAppInfo()).dataDirectory);
          const logDirectory = path.join(dataDirectory, 'ai/logs');
          const logs = (
            await Promise.all((await readdir(logDirectory)).map((f) => readFile(path.join(logDirectory, f), 'utf8')))
          ).join('\n');
          const retryLog = logs
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((entry) => entry.event === 'retry');
          expect(retryLog).toMatchObject({ attempt: 1, delayMs: 1000, error: { category: 'network' } });
          expect(retryLog?.error).not.toHaveProperty('providerMessage');
          expect(logs).not.toContain('partial failed response');
          expect(logs).not.toContain(fakeKey);
          if (mode === 'imageConnection') {
            expect(saved.turn?.report?.reason).toBe('completed');
            expect(saved.turn?.report?.rounds[1]?.warnings).toContain('transient_retry');
            const round = page.locator('.image-report [data-round="2"]');
            await round.locator('summary').first().click();
            await expect(round).toContainText('临时错误，已重试');
            expect(
              saved.turn?.events.filter((e) => e.type === 'tool_result' && e.call.name === 'run_build_script'),
            ).toHaveLength(saved.turn?.report?.rounds.length ?? 0);
          } else {
            expect(saved.turn?.result?.reason).toBe('completed');
            expect(saved.turn?.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
            await expect(page.locator('.ai-turn .ai-activities')).toContainText('临时错误，已重试 1 次');
            await expect(page.locator('.ai-turn .ai-failure')).toHaveCount(0);
          }
        } else {
          if (mode === 'chat500') {
            await expect
              .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status))
              .toBe('failed');
            expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual([]);
            await expect(page.getByTestId('review-bar')).toHaveCount(0);
          }
          const detail = page.locator(mode === 'http400' ? '.image-report .ai-failure' : '.ai-turn .ai-failure');
          const banner = page.locator('.ai-panel > .ant-alert');
          for (const locator of [detail, banner]) {
            await expect(locator).toContainText(mode === 'http400' ? '请求被服务商拒绝' : '服务商错误');
            await expect(locator).toContainText(mode === 'http400' ? 'HTTP 400' : 'HTTP 500');
            await expect(locator).toContainText('invalid_parameter');
            await expect(locator).toContainText('Offline diagnostic: rejected');
            await expect(locator).not.toContainText('操作未完成，请检查服务商');
            await expect(locator).not.toContainText('common:');
          }
          expect(await page.locator('body').innerText()).not.toContain(fakeKey);
          expect(saved.history).toContain('invalid_parameter');
          expect(saved.history).not.toContain(fakeKey);
          if (mode === 'http400') {
            expect(saved.turn?.report?.failure).toMatchObject({
              stage: 'round',
              round: 1,
              attempts: 1,
              error: { status: 400, code: 'invalid_parameter' },
            });
            expect(server.requests.filter((r) => r.tools?.length)).toHaveLength(1);
          }
          const dataDirectory = await page.evaluate(async () => (await window.brickloop.getAppInfo()).dataDirectory);
          expect(dataDirectory.startsWith(directory)).toBe(true);
          const logs = (
            await Promise.all(
              (await readdir(path.join(dataDirectory, 'ai/logs'))).map((f) =>
                readFile(path.join(dataDirectory, 'ai/logs', f), 'utf8'),
              ),
            )
          ).join('\n');
          expect(logs).toContain('"category":"' + (mode === 'http400' ? 'invalid_request' : 'server') + '"');
          expect(logs).toContain('"status":' + (mode === 'http400' ? '400' : '500'));
          expect(logs).toContain('"code":"invalid_parameter"');
          expect(logs).not.toContain('Offline diagnostic');
          expect(logs).not.toContain('providerMessage');
          expect(logs).not.toContain(fakeKey);
        }
        if (
          mode === 'http402' ||
          mode === 'chat500AfterPart' ||
          mode === 'imageConnection' ||
          mode === 'chatConnection'
        )
          return;
        await page
          .locator(mode === 'truncated' ? '.image-report' : '.ai-failure')
          .first()
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shots, mode + '.png'), animations: 'disabled' });
      } finally {
        if (app) {
          const page = app.windows()[0];
          await page?.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
          await app.close();
        }
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const kind of ['chat', 'image'] as const)
  test(`A-116 ${kind}: four stalled requests report the provider silence`, async () => {
    test.setTimeout(120000);
    const server = kind === 'chat' ? await fakeModel() : await imageModelServer();
    if ('frames' in server) server.frames.push(...Array.from({ length: 4 }, () => ({ silent: true })));
    else server.controls.stallRequests = 4;
    const session = await livenessSession(server.endpoint);
    try {
      const { page, providerId } = session;
      if (kind === 'chat') {
        await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('等待测试');
        await page.getByRole('button', { name: '发送', exact: true }).click();
      } else
        await page.evaluate(async (providerId) => {
          await window.brickloopEditorTest.imageStart({
            providerId,
            model: 'offline-model',
            directStart: true,
            budget: { toolCalls: 400, durationMs: 120000, rounds: 5 },
            input: {
              description: '搭建小房子',
              images: [],
              targetSize: 'small',
              style: '',
              priority: 'appearance',
              palette: { source: 'factory' },
              parts: { source: 'all' },
            },
          });
        }, providerId);
      await expect
        .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status), { timeout: 45000 })
        .toBe('failed');
      const detail = page.locator(kind === 'image' ? '.image-report .ai-failure' : '.ai-turn .ai-failure');
      await expect(detail).toContainText('服务商长时间没有响应');
      await expect(detail).toContainText('STREAM_STALLED');
      await expect(detail).toContainText('稍后再试，或换一个模型');
      await expect(page.locator('.ai-liveness')).toHaveCount(0);
      const turn = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1));
      const failure = kind === 'chat' ? turn?.result : turn?.report?.failure;
      expect(failure?.error).toMatchObject({ category: 'network', code: 'STREAM_STALLED' });
      expect(failure?.error).not.toHaveProperty('providerMessage');
      expect(turn?.events.filter((e) => e.type === 'retry')).toHaveLength(3);
      expect(server.requests).toHaveLength(4);
      if (kind === 'image') expect(turn?.report?.summaryZh).toContain('服务商长时间没有响应');
    } finally {
      await session.close();
      await server.close();
    }
  });

for (const shouldRetry of [true, false])
  test(`A-121: x-should-retry=${shouldRetry} overrides the HTTP retry decision`, async () => {
    test.setTimeout(120000);
    const server = await fakeModel();
    server.frames.push(
      { status: shouldRetry ? 400 : 503, headers: { 'x-should-retry': String(shouldRetry) } },
      { text: '按响应头重试后完成。' },
    );
    const session = await livenessSession(server.endpoint);
    try {
      await session.page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('响应头测试');
      await session.page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => session.page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
      const turn = await session.page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1));
      expect(turn?.result?.reason).toBe(shouldRetry ? 'completed' : 'error');
      expect(turn?.events.filter((e) => e.type === 'retry')).toHaveLength(shouldRetry ? 1 : 0);
      expect(server.requests).toHaveLength(shouldRetry ? 2 : 1);
    } finally {
      await session.close();
      await server.close();
    }
  });
