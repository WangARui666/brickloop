import { expect } from '@playwright/test';
import { test } from './electron-test';
import { fakeModel } from './ai-model-fixture';
import { usageSession, closeUsage, cleanupUsage } from './real-usage-helpers';

test('M12-22: burst reasoning and reply preserve every character without page errors', async () => {
  test.setTimeout(120000);
  const chunks = Array.from({ length: 4000 }, (_, i) => String(i % 10));
  const text = chunks.join('');
  const server = await fakeModel();
  server.frames.push({ burst: { reasoning: chunks, text: chunks } });
  const session = await test.step('launch offline chat', () => usageSession(server.endpoint));
  try {
    const { page } = session;
    await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('流式突发测试');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => server.requests.length).toBe(1);
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.result?.reason))
      .toBe('completed');
    expect(await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.text)).toBe(text);
    await expect(page.locator('.ai-turn .ai-assistant .ai-markdown').last()).toHaveText(text);
  } finally {
    await closeUsage(session.app);
    await server.close();
    await cleanupUsage(session.directory);
  }
});
