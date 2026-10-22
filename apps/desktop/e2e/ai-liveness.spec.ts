import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { Locator, Page } from '@playwright/test';
import { fakeModel, livenessSession } from './ai-model-fixture';
import { fixturePlan, imageModelServer } from './image-model-fixture';

async function expectCompactLiveness(card: Locator, state: string) {
  const line = card.locator('.ai-liveness');
  await expect(line).toHaveAttribute('role', 'status');
  await expect(line).toHaveAttribute('aria-live', 'off');
  await expect(line.locator('.sr-only')).toHaveAttribute('aria-live', 'polite');
  await expect(line.locator('.sr-only')).toHaveAttribute('aria-atomic', 'true');
  await expect(line).toHaveCSS('white-space', 'nowrap');
  await expect(line).toHaveCSS('text-overflow', 'ellipsis');
  await expect(line).toHaveCSS('overflow', 'hidden');
  const layout = await line.evaluate((element) => {
    const card = element.closest('.image-task-card, .ai-turn')!;
    const row = element.parentElement!;
    const withStatus = card.getBoundingClientRect().height;
    const bounds = element.getBoundingClientRect();
    const style = element.getAttribute('style');
    element.style.display = 'none';
    const withoutStatus = card.getBoundingClientRect().height;
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
    return {
      withStatus,
      withoutStatus,
      kind: card.matches('.image-task-card') ? 'image' : 'chat',
      inMetadata: row.matches('.ai-task-meta, .image-task-budget'),
      rowHeight: row.getBoundingClientRect().height,
      height: bounds.height,
      width: bounds.width,
      title: element.getAttribute('title'),
      text: element.querySelector('span')!.textContent,
    };
  });
  expect(layout.inMetadata).toBe(true);
  expect(layout.withStatus).toBe(layout.withoutStatus);
  expect(layout.height).toBeLessThanOrEqual(layout.rowHeight);
  expect(layout.width).toBeGreaterThanOrEqual(110);
  expect(layout.title).toBe(layout.text);
  await test.info().attach(`liveness-layout-${layout.kind}-${state}`, {
    body: Buffer.from(JSON.stringify({ state, ...layout })),
    contentType: 'application/json',
  });
}

async function start(page: Page, kind: 'chat' | 'image', providerId: string, directStart = true) {
  if (kind === 'chat') {
    await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('描述模型');
    await page.getByRole('button', { name: '发送', exact: true }).click();
  } else
    await page.evaluate(
      async ({ providerId, directStart }) => {
        await window.brickloopEditorTest.imageStart({
          providerId,
          model: 'offline-model',
          directStart,
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
      },
      { providerId, directStart },
    );
}
async function finished(page: Page, kind: 'chat' | 'image') {
  await expect
    .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running), { timeout: 90000 })
    .toBe(false);
  const turn = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1));
  expect(kind === 'image' ? turn?.report?.reason : turn?.result?.reason).toBe('completed');
  await expect(page.locator('.ai-liveness')).toHaveCount(0);
  return turn!;
}
for (const kind of ['chat', 'image'] as const) {
  test(`A-115 ${kind}: reasoning chunks update character counts and disappear on completion`, async () => {
    test.setTimeout(120000);
    const server = kind === 'chat' ? await fakeModel() : await imageModelServer();
    if ('frames' in server)
      server.frames.push({
        reasoningChunks: Array.from({ length: 10 }, () => 'private fixture thought '.repeat(10)),
        text: '已完成。',
      });
    else server.controls.reasoningRequests = 1;
    const session = await livenessSession(server.endpoint);
    try {
      const { page } = session;
      await start(page, kind, session.providerId);
      const line = page.locator(kind === 'image' ? '.image-task-card .ai-liveness' : '.ai-turn .ai-liveness');
      await expect(line).toContainText('模型正在思考');
      await expectCompactLiveness(page.locator(kind === 'image' ? '.image-task-card' : '.ai-turn').last(), 'activity');
      const first = await line.innerText();
      expect(first).toContain('已生成约');
      await expect
        .poll(async () => (await line.innerText()).match(/已生成约 (\S+) 字/)?.[1])
        .not.toBe(first.match(/已生成约 (\S+) 字/)?.[1]);
      await finished(page, kind);
      const saved = await page.evaluate(() =>
        window.brickloopEditorTest.savedHistory(window.brickloopEditorTest.snapshot().document.documentId),
      );
      expect(saved).not.toContain('private fixture thought');
      expect(saved).not.toContain('"type":"activity"');
      const dataDirectory = await page.evaluate(async () => (await window.brickloop.getAppInfo()).dataDirectory);
      const logs = (
        await Promise.all(
          (await readdir(path.join(dataDirectory, 'ai/logs'))).map((name) =>
            readFile(path.join(dataDirectory, 'ai/logs', name), 'utf8'),
          ),
        )
      ).join('\n');
      expect(logs).not.toContain('"event":"activity"');
      expect(logs).not.toContain('private fixture thought');
    } finally {
      await session.close();
      await server.close();
    }
  });
  test(`A-116 ${kind}: silent headers warn, retry the same request, then complete`, async () => {
    test.setTimeout(120000);
    const server = kind === 'chat' ? await fakeModel() : await imageModelServer();
    if ('frames' in server) server.frames.push({ silent: true }, { text: '恢复完成。' });
    else server.controls.stallRequests = 1;
    const session = await livenessSession(server.endpoint);
    try {
      const { page } = session;
      await start(page, kind, session.providerId);
      const card = page.locator(kind === 'image' ? '.image-task-card' : '.ai-turn').last();
      await expect(card.locator('.ai-liveness')).toContainText('正在等待服务商响应');
      await expectCompactLiveness(card, 'waiting');
      await expect(card.locator('.ai-liveness.is-warning')).toContainText('秒没有收到数据');
      await expectCompactLiveness(card, 'silent-warning');
      await expect(card).toContainText('秒后第 1 次重试（最多 10 次）', { timeout: 10000 });
      await expect(card.locator('.ai-liveness')).toContainText('秒后第 1 次重试（最多 10 次）');
      await expect(card.locator('.ai-liveness.is-warning')).toHaveCount(0);
      await expectCompactLiveness(card, 'retry-after-silence');
      const turn = await finished(page, kind);
      expect(turn.events.filter((e) => e.type === 'retry')).toMatchObject([
        { attempt: 1, error: { category: 'network', code: 'STREAM_STALLED' } },
      ]);
      expect(server.requests[0]).toEqual(server.requests[1]);
      expect(turn.events.some((e) => e.type === 'activity')).toBe(false);
    } finally {
      await session.close();
      await server.close();
    }
  });
}
for (const kind of ['chat', 'image'] as const) {
  test(`A-122 ${kind}: keep-alive comments maintain a live connection beyond the idle timeout`, async () => {
    test.setTimeout(120000);
    const server = kind === 'chat' ? await fakeModel() : await imageModelServer();
    if ('frames' in server) server.frames.push({ keepAliveForMs: 7000, text: '保活后完成。' });
    else server.controls.keepAliveRequests = 1;
    const session = await livenessSession(server.endpoint);
    try {
      await start(session.page, kind, session.providerId);
      const line = session.page.locator(kind === 'image' ? '.image-task-card .ai-liveness' : '.ai-turn .ai-liveness');
      await expect(line).toContainText('服务商正在排队或处理，连接正常');
      await expectCompactLiveness(
        session.page.locator(kind === 'image' ? '.image-task-card' : '.ai-turn').last(),
        'keep-alive',
      );
      // Observe continuously beyond the fixture's five-second byte-idle threshold.
      for (let i = 0; i < 6; i++) {
        await session.page.waitForTimeout(900);
        await expect(line).not.toHaveClass(/is-warning/);
        await expect(line).toContainText('连接正常');
        expect(server.requests).toHaveLength(1);
      }
      const turn = await finished(session.page, kind);
      expect(turn.events.filter((e) => e.type === 'retry')).toHaveLength(0);
      expect(JSON.stringify(turn)).not.toMatch(/keep-alive|transport_activity/);
    } finally {
      await session.close();
      await server.close();
    }
  });

  test(`A-121 ${kind}: Retry-After controls the displayed wait and retry ordinal`, async () => {
    test.setTimeout(120000);
    const server = kind === 'chat' ? await fakeModel() : await imageModelServer();
    const responses: { status: number; headers: Record<string, string> }[] = [
      { status: 429, headers: { 'retry-after-ms': '4000', 'retry-after': '99' } },
      { status: 429, headers: { 'retry-after': '3' } },
    ];
    if ('frames' in server) server.frames.push(...responses, { text: '重试后完成。' });
    else server.controls.retryResponses.push(...responses);
    const session = await livenessSession(server.endpoint);
    try {
      await start(session.page, kind, session.providerId);
      const card = session.page.locator(kind === 'image' ? '.image-task-card' : '.ai-turn').last();
      await expect(card).toContainText('4 秒后第 1 次重试（最多 10 次）');
      await expectCompactLiveness(card, 'retry-wait-1');
      await expect(card.locator('.ai-liveness')).not.toHaveClass(/is-warning/);
      await expect(card).toContainText('3 秒后第 2 次重试（最多 10 次）');
      await expectCompactLiveness(card, 'retry-wait-2');
      const turn = await finished(session.page, kind);
      expect(turn.events.filter((e) => e.type === 'retry')).toMatchObject([
        { attempt: 1, delayMs: 4000, error: { category: 'rate_limit', status: 429 } },
        { attempt: 2, delayMs: 3000, error: { category: 'rate_limit', status: 429 } },
      ]);
      expect(server.requests[0]).toEqual(server.requests[1]);
      expect(server.requests[1]).toEqual(server.requests[2]);
      expect(JSON.stringify(turn)).not.toMatch(/retry-after|x-should-retry/);
    } finally {
      await session.close();
      await server.close();
    }
  });
}
test('A-117: repairs bounding boxes before confirmation and builds the planned dimensions', async () => {
  test.setTimeout(120000);
  const server = await imageModelServer();
  server.controls.planOverride = {
    ...structuredClone(fixturePlan),
    buildOrder: ['body'],
    components: [
      {
        ...fixturePlan.components[0]!,
        size: { width: 4, depth: 2, height: 1.2 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 9, z: 9 } },
      },
    ],
  };
  server.controls.buildPlanBoxes = true;
  const session = await livenessSession(server.endpoint);
  try {
    const { page } = session;
    await start(page, 'image', session.providerId, false);
    const modal = page.locator('.image-plan-modal');
    await expect(modal.locator('.plan-color-repairs summary')).toHaveText('已调整 1 处包围盒');
    await modal.locator('.plan-color-repairs summary').click();
    await expect(modal.locator('.plan-color-repairs li')).toHaveText(
      '第 1 个部件“主体”：包围盒终点由 (9, 9, 9) 改为 (4, 1.2, 2)，按宽、深、高重算。',
    );
    const button = modal.getByRole('button', { name: '开始搭建', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    const turn = await finished(page, 'image');
    expect(turn.report?.plan?.components[0]!.boundingBox).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 4, y: 1.2, z: 2 },
    });
    const runs = turn.events.filter((e) => e.type === 'tool_result' && e.call.name === 'run_build_script');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.type === 'tool_result' && run.result.ok).toBe(true);
      if (run.type !== 'tool_result' || !run.result.ok) continue;
      const data = run.result.data as {
        submodels: {
          bounds: { min: { x: number; z: number; level: number }; max: { x: number; z: number; level: number } };
        }[];
      };
      const box = data.submodels[0]!.bounds;
      expect([box.max.x - box.min.x, box.max.z - box.min.z, (box.max.level - box.min.level) / 2.5]).toEqual([
        4, 2, 1.2,
      ]);
    }
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBeGreaterThan(0);
  } finally {
    await session.close();
    await server.close();
  }
});
