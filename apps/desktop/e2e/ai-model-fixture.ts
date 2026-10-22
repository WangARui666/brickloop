import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect } from '@playwright/test';
import { launchElectron } from './electron-launch';

/** Isolated offline session for liveness and stall acceptance; existing fixtures are unchanged. */
export async function livenessSession(endpoint: string) {
  const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = await mkdtemp(path.join(desktop, '../../.devdata/tmp/m12-12-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BRICKLOOP_EVAL_API_KEY;
  delete env.BRICKLOOP_AI_EVAL;
  const app = await launchElectron({
    args: [desktop],
    timeout: 45000,
    env: {
      ...env,
      BRICKLOOP_DATA_DIR: directory,
      BRICKLOOP_TEST_STALL_NOTICE_MS: '2000',
      BRICKLOOP_TEST_STALL_MS: '5000',
      BRICKLOOP_TEST_RETRY_DELAY_MS: '1000',
    },
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const close = async () => {
    await app
      .windows()[0]
      ?.evaluate(() => window.brickloopEditorTest.prepareClose())
      .catch(() => undefined);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    const providerId = randomUUID();
    await page.evaluate(
      async ({ id, endpoint }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '离线活动测试',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true, debug: true, history: true });
      },
      { id: providerId, endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.keyboard.press('Control+k');
    return { app, page, providerId, directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Frame = {
  text?: string;
  reasoning?: string;
  errorMessage?: string;
  errorCode?: string;
  calls?: { name: string; arguments: unknown }[];
  hold?: boolean;
  delay?: number;
  gate?: string;
  status?: number;
  headers?: Record<string, string>;
  keepAliveForMs?: number;
  silent?: boolean;
  reasoningChunks?: string[];
  /** Back-to-back SSE deltas, with no timers between chunks. */
  burst?: { reasoning: string[]; text: string[] };
  /** Optional measured usage for context-compaction fixtures. */
  inputTokens?: number;
};
export interface ModelRequest {
  messages: {
    role: string;
    content: unknown;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  max_tokens?: number;
}

/** A diligent scripted model: choose work from the actual prompt and actual tool results. */
export function shortcutResponse(request: ModelRequest): Frame {
  const messages = request.messages;
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = JSON.stringify(user?.content);
  const calls = messages.flatMap((m) => m.tool_calls ?? []);
  const results = messages
    .filter((m) => m.role === 'tool')
    .map((m) => ({
      call: calls.find((c) => c.id === m.tool_call_id),
      result: JSON.parse(String(m.content)) as { ok: boolean; data?: Record<string, unknown>; code?: string },
    }));
  const data = (name: string) => results.find((r) => r.call?.function.name === name)?.result.data;
  const count = (name: string) => results.filter((r) => r.call?.function.name === name).length;
  const call = (name: string, args: unknown = {}): Frame => ({ calls: [{ name, arguments: args }] });
  if (!results.length) return call('get_model_summary');
  if (prompt.includes('解释')) return { text: `模型实测摘要：\n${JSON.stringify(data('get_model_summary'), null, 2)}` };
  if (!data('list_instances')) return call('list_instances', { limit: 500 });
  if (!data('validate')) return call('validate');
  if (!data('list_colors')) return call('list_colors');
  const scoped = prompt.includes('software-provided reference data');
  if (scoped && !data('get_selection')) return call('get_selection');
  const selected = data('get_selection')?.instanceIds as string[] | undefined;
  const rows = (
    data('list_instances')!.instances as { instanceId: string; partId: string; colorId: string; path: string[] }[]
  ).filter((r) => !scoped || selected?.includes(r.instanceId));
  const issues = data('validate')!.issues as { kind: string; paths: string[][] }[];
  const allowed = new Set(rows.map((r) => r.instanceId));
  const colors = data('list_colors')!.colors as { id: string }[];
  const red = colors.find((c) => c.id === 'c:bright-red')!.id;
  const mutations = results.filter((r) => ['delete', 'set_color', 'batch'].includes(r.call?.function.name ?? ''));
  if (!mutations.length) {
    if (prompt.includes('修复')) {
      const ids = [
        ...new Set(
          issues
            .filter((i) => ['collision', 'floating'].includes(i.kind))
            .flatMap((i) => {
              const target = [...i.paths].reverse().find((p) => allowed.has(p.at(-1)!));
              return target ? [target.at(-1)!] : [];
            }),
        ),
      ];
      return call('delete', { instanceIds: ids });
    }
    if (prompt.includes('替代件')) {
      const nonFactory = issues
        .filter((i) => i.kind === 'non_factory_part')
        .flatMap((i) => i.paths.map((p) => p.at(-1)!))
        .filter((id) => allowed.has(id));
      const original = rows.find((r) => nonFactory.includes(r.instanceId));
      if (original && !data('suggest_factory_substitutes'))
        return call('suggest_factory_substitutes', { partId: original.partId, colorId: red });
      if (original && !data('get_instance')) return call('get_instance', { instanceId: original.instanceId });
      const operations: { tool: string; arguments: unknown }[] = [];
      if (original) {
        const substitute = (data('suggest_factory_substitutes')!.parts as { id: string }[])[0]!;
        const instance = data('get_instance')!;
        operations.push(
          { tool: 'delete', arguments: { instanceIds: [original.instanceId] } },
          {
            tool: 'place_part',
            arguments: {
              partId: substitute.id,
              colorId: red,
              modelPath: original.path.slice(0, -1),
              pose: { kind: 'matrix', matrix_ldu: instance.transform },
            },
          },
        );
      }
      const recolor = issues
        .filter((i) => ['non_factory_color', 'unavailable_color'].includes(i.kind))
        .flatMap((i) => i.paths.map((p) => p.at(-1)!))
        .filter((id) => allowed.has(id) && !nonFactory.includes(id));
      if (recolor.length)
        operations.push({ tool: 'set_color', arguments: { instanceIds: [...new Set(recolor)], colorId: red } });
      return call('batch', { operations, atomic: true });
    }
    if (prompt.includes('配色')) {
      const nonFactory = new Set(
        issues.filter((i) => i.kind === 'non_factory_part').flatMap((i) => i.paths.map((p) => p.at(-1)!)),
      );
      return call('set_color', {
        instanceIds: rows.filter((r) => !nonFactory.has(r.instanceId) && r.colorId !== red).map((r) => r.instanceId),
        colorId: red,
      });
    }
  }
  if (count('validate') < 2) return call('validate');
  const errors = results.filter((r) => !r.result.ok).map((r) => r.result.code);
  return {
    text: errors.length
      ? `无法完成：${errors.join(', ')}`
      : '已按范围完成修改，重新校验；非本次指令处理的问题保留在检查结果中。',
  };
}
export async function fakeModel(respond?: (request: ModelRequest) => Frame) {
  const frames: Frame[] = [],
    requests: unknown[] = [];
  const routes = new Map<string, Frame[]>();
  const gates = new Map<string, () => void>();
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'offline-model', object: 'model', created: 1, owned_by: 'test' }],
        }),
      );
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (data: Buffer) => {
      body += data.toString();
    });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const parsed = JSON.parse(body) as ModelRequest;
      const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
      const route = [...routes.keys()].find((key) => JSON.stringify(user?.content).includes(key));
      const frame = (route ? routes.get(route)! : frames).shift() ?? respond?.(parsed) ?? { text: '完成。' };
      if (frame.status) {
        res.writeHead(frame.status, { 'Content-Type': 'application/json', ...frame.headers });
        res.end(
          JSON.stringify({
            error: {
              message: frame.errorMessage ?? 'Offline fixture failure',
              type: frame.status === 400 ? 'invalid_request_error' : 'server_error',
              ...(frame.errorCode ? { code: frame.errorCode } : {}),
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (frame.silent) {
        res.flushHeaders();
        return;
      }
      const event = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (frame.text && !frame.reasoningChunks && !frame.keepAliveForMs) event({ content: frame.text });
      if (frame.reasoning) event({ reasoning_content: frame.reasoning });
      if (frame.hold) return;
      const end = () => {
        frame.calls?.forEach((call, index) =>
          event({
            tool_calls: [
              {
                index,
                id: randomUUID(),
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        );
        event({}, frame.calls?.length ? 'tool_calls' : 'stop');
        res.write(
          `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: frame.inputTokens ?? 500, completion_tokens: Math.min(50, parsed.max_tokens ?? 50), total_tokens: (frame.inputTokens ?? 500) + Math.min(50, parsed.max_tokens ?? 50) } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      };
      if (frame.burst) {
        for (const text of frame.burst.reasoning) event({ reasoning_content: text });
        for (const text of frame.burst.text) event({ content: text });
        end();
      } else if (frame.keepAliveForMs) {
        res.flushHeaders();
        res.write(': keep-alive\n\n');
        const interval = setInterval(() => res.write(': keep-alive\n\n'), 300);
        const timer = setTimeout(() => {
          clearInterval(interval);
          if (frame.text) event({ content: frame.text });
          end();
        }, frame.keepAliveForMs);
        res.on('close', () => {
          clearInterval(interval);
          clearTimeout(timer);
        });
      } else if (frame.reasoningChunks) {
        res.flushHeaders();
        let index = 0;
        const timer = setInterval(() => {
          if (index < frame.reasoningChunks!.length) event({ reasoning_content: frame.reasoningChunks![index++] });
          else {
            clearInterval(timer);
            if (frame.text) event({ content: frame.text });
            end();
          }
        }, 300);
        res.on('close', () => clearInterval(timer));
      } else if (frame.gate) {
        gates.set(frame.gate, end);
        res.on('close', () => gates.delete(frame.gate!));
      } else if (frame.delay) {
        const timer = setTimeout(end, frame.delay);
        res.on('close', () => clearTimeout(timer));
      } else end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    frames,
    requests,
    route: (name: string, script: Frame[]) => routes.set(name, script),
    waiting: (gate: string) => gates.has(gate),
    release: (gate: string) => {
      const resume = gates.get(gate);
      gates.delete(gate);
      resume?.();
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
