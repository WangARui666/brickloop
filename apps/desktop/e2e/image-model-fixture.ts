import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { StructurePlan } from '@brickloop/ai';
import { guideHousePlan, guideHouseScript } from './guide-house-fixture';

export const fixturePlan: StructurePlan = {
  name: '红顶小房子',
  components: [
    {
      id: 'body',
      name: '主体',
      size: { width: 6, depth: 6, height: 3 },
      colors: ['c:bright-red'],
      partTypes: ['砖'],
      connections: [],
    },
    {
      id: 'roof',
      name: '屋顶',
      size: { width: 6, depth: 6, height: 3 },
      colors: ['c:bright-red'],
      partTypes: ['砖'],
      connections: [{ target: 'body', description: '连接主体顶面' }],
    },
  ],
  buildOrder: ['body', 'roof'],
};
export const cathedralPlan: StructurePlan = {
  name: '十六部件大教堂',
  components: Array.from({ length: 16 }, (_, i) => ({
    id: `section-${i}`,
    name: ['正门台阶', '主殿墙体', '左侧钟楼', '右侧钟楼', '尖顶穹顶', '彩色玻璃窗', '后殿', '庭院'][i % 8]! + i,
    size: { width: 4, depth: 4, height: 3 },
    boundingBox: { min: { x: i * 4 + 0.5, y: 0.5, z: -0.5 }, max: { x: i * 4 + 4.5, y: 3.5, z: 3.5 } },
    colors: ['c:bright-red', 'c:bright-yellow'],
    partTypes: [
      '1×1砖',
      '1×2砖',
      '1×4砖',
      '2×4砖',
      '1×1板',
      '2×4板',
      '斜面砖',
      '圆顶',
      '透明窗',
      '拱门',
      '平滑板',
      '装饰柱',
    ],
    connections: i ? [{ target: `section-${i - 1}`, description: '连接相邻墙体' }] : [],
    category: 'buildings',
    strategy: 'shapes',
  })),
  buildOrder: Array.from({ length: 16 }, (_, i) => `section-${i}`),
};
export const towerPlan: StructurePlan = {
  name: '红顶塔楼建筑',
  components: [
    {
      id: 'body',
      name: '建筑主体',
      size: { width: 20, depth: 16, height: 14.4 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 14.4, z: 16 } },
      category: 'buildings',
      strategy: 'shapes',
      colors: ['c:bright-yellow'],
      partTypes: ['砖'],
      connections: [],
    },
    {
      id: 'roof',
      name: '屋顶平台',
      size: { width: 20, depth: 16, height: 4.8 },
      boundingBox: { min: { x: 0, y: 14.4, z: 0 }, max: { x: 20, y: 19.2, z: 16 } },
      category: 'buildings',
      strategy: 'parts',
      colors: ['c:bright-red'],
      partTypes: ['砖'],
      connections: [{ target: 'body', description: '连接墙顶' }],
    },
    {
      id: 'tower',
      name: '塔楼',
      size: { width: 8, depth: 8, height: 12 },
      boundingBox: { min: { x: 6, y: 19.2, z: 4 }, max: { x: 14, y: 31.2, z: 12 } },
      category: 'buildings',
      strategy: 'parts',
      colors: ['c:bright-yellow', 'c:bright-red'],
      partTypes: ['砖'],
      connections: [{ target: 'roof', description: '连接屋顶平台' }],
    },
  ],
  buildOrder: ['body', 'roof', 'tower'],
};
/** Four alternating bonds connect rows, columns and successive layers. */
export function towerScript(repaired: boolean): string {
  return `function layer(w,d,y,ring,color,index){
  const turn=index%2, offset=Math.floor(index/2)%2;
  const width=turn?d:w, depth=turn?w:d;
  function occupied(x,z){return !ring||x<2||z<2||x>=width-2||z>=depth-2;}
  for(let z=0;z<depth;z++) for(let x=0;x<width;){
    if(!occupied(x,z)){x++;continue;}
    const n=x+1<width&&occupied(x+1,z)&&(x+offset)%2===0?2:1;
    part(n===2?'3004':'3005',{x:turn?z+0.5:x+n/2,z:turn?x+n/2:z+0.5,y,rotY:turn?90:0},color); x+=n;
  }
}
submodel('body',()=>{for(let i=0;i<12;i++)layer(20,16,(i+1)*3,i>=4,'c:bright-yellow',i);});
instance('body',{x:0,z:0,y:0});
submodel('roof',()=>{for(let i=0;i<4;i++)layer(20,16,(i+1)*3,false,'c:bright-red',i);});
instance('roof',{x:0,z:0,y:36});
submodel('tower',()=>{for(let i=0;i<10;i++)layer(8,8,(i+1)*3,i<6,i<6?'c:bright-yellow':'c:bright-red',i);});
instance('tower',{x:6,z:4,y:48});
${repaired ? '// buildability: duplicate removed' : "part('3004',{x:1,z:0.5,y:3},'c:bright-yellow'); // deliberate collision, repaired at the end"}`;
}
interface Request {
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
  tools?: unknown[];
  max_tokens?: number;
}
export async function imageModelServer() {
  const requests: Request[] = [];
  const requestBytes: number[] = [];
  const controls = {
    status: 0,
    statusOnBuild: false,
    delay: 0,
    budget: false,
    hold: false,
    wallRoof: false,
    failedCompare: false,
    compareExcluded: false,
    guideHouse: false,
    cathedral: false,
    planOverride: null as StructurePlan | null,
    originPlan: false,
    planColorsOnce: null as string[] | null,
    largePreview: false,
    animationCode: null as string | null,
    reasoningRequests: 0,
    stallRequests: 0,
    keepAliveRequests: 0,
    keepAliveForMs: 7000,
    retryResponses: [] as { status: number; headers: Record<string, string> }[],
    buildPlanBoxes: false,
    failure: null as
      | 'truncated'
      | 'http400'
      | 'http402'
      | 'chat500'
      | 'chat500AfterPart'
      | 'imageConnection'
      | 'chatConnection'
      | null,
  };
  let injected = false;
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
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
      const request = JSON.parse(body) as Request;
      requests.push(request);
      requestBytes.push(Buffer.byteLength(body));
      const retryResponse = controls.retryResponses.shift();
      if (retryResponse) {
        res.writeHead(retryResponse.status, { 'Content-Type': 'application/json', ...retryResponse.headers });
        res.end(JSON.stringify({ error: { message: 'Offline retry fixture', type: 'rate_limit_error' } }));
        return;
      }
      if (controls.stallRequests > 0) {
        controls.stallRequests--;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        return;
      }
      const texts = request.messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((v) => v.text ?? '').join('\n')));
      const build = texts.find((t) => t.startsWith('Script workflow round:'));
      if (
        (build && controls.failure === 'http400') ||
        (!build && request.tools?.length && controls.failure === 'chat500')
      ) {
        res.writeHead(controls.failure === 'http400' ? 400 : 500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'invalid_parameter',
              message: 'Offline diagnostic: rejected sk-test-123; check compact script.',
            },
          }),
        );
        return;
      }
      if (build && controls.failure === 'truncated' && !injected) {
        injected = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'incomplete',
                        type: 'function',
                        function: { name: 'run_build_script', arguments: '{"scriptId":"incomplete","code":"' },
                      },
                    ],
                  },
                  finish_reason: 'length',
                },
              ],
            }) +
            '\n\n',
        );
        return;
      }
      if (controls.status && (!controls.statusOnBuild || build)) {
        res.writeHead(controls.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Offline image fixture failure', type: 'invalid_request_error' } }));
        return;
      }
      const system = request.messages
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content))
        .join('\n');
      const results = request.messages
        .filter((m) => m.role === 'tool')
        .flatMap((m) => {
          try {
            return [
              JSON.parse(String(m.content)) as {
                ok: boolean;
                data?: {
                  created?: string[];
                  submodelId?: string;
                  partId?: string;
                  parts?: unknown[];
                  scriptId?: string;
                  code?: string;
                };
              },
            ];
          } catch {
            return [];
          }
        });
      if (!build && controls.failure === 'chat500AfterPart' && results.some((r) => r.ok && r.data?.created?.length)) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: {
              type: 'server_error',
              code: 'server_error',
              message: 'Offline diagnostic: failed after placement',
            },
          }),
        );
        return;
      }
      if (
        controls.failure === 'http402' &&
        build?.startsWith('Script workflow round: 2\n') &&
        results.some((r) => r.ok && r.data?.scriptId)
      ) {
        res.writeHead(402, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: {
              message: 'Insufficient Balance',
              type: 'invalid_request_error',
              param: null,
              code: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      if (
        !injected &&
        ((controls.failure === 'imageConnection' &&
          build?.startsWith('Script workflow round: 2\n') &&
          results.some((r) => r.ok && r.data?.scriptId)) ||
          (controls.failure === 'chatConnection' && !build && results.length > 0))
      ) {
        injected = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: 'partial failed response' }, finish_reason: null }] }) +
            '\n\n',
        );
        const timer = setTimeout(() => res.destroy(), 100);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      let text = '已完成本轮搭建。';
      let call: { name: string; arguments: object } | undefined;
      const car = texts.some((t) => t.includes('小汽车'));
      const tower = texts.some((t) => t.includes('塔楼'));
      if (!request.tools?.length)
        text = JSON.stringify(
          controls.cathedral
            ? cathedralPlan
            : controls.guideHouse
              ? guideHousePlan
              : tower
                ? towerPlan
                : car
                  ? {
                      ...fixturePlan,
                      name: '小汽车',
                      components: fixturePlan.components.map((c) => ({
                        ...c,
                        name: c.id === 'body' ? '车身' : '车轮',
                      })),
                    }
                  : fixturePlan,
        );
      if (!request.tools?.length) {
        if (controls.planOverride) text = JSON.stringify(controls.planOverride);
        if (controls.originPlan || controls.planColorsOnce) {
          const plan = JSON.parse(text) as StructurePlan;
          const firstColors = controls.planColorsOnce;
          controls.planColorsOnce = null;
          text = JSON.stringify({
            ...plan,
            components: plan.components.map(({ boundingBox, ...component }, index) => ({
              ...component,
              ...(controls.originPlan
                ? { origin: boundingBox?.min ?? { x: 0, y: index * 3, z: 0 } }
                : boundingBox
                  ? { boundingBox }
                  : {}),
              ...(index === 0 && firstColors ? { colors: firstColors } : {}),
            })),
          });
        }
        const requirements = texts.join('\n').match(/Requirements: (.+)\nAll user amendments:/)?.[1];
        const input = requirements
          ? (JSON.parse(requirements) as {
              viewMode?: string;
              images?: { referenceId: string; view: string }[];
            })
          : {};
        if (input.viewMode !== 'fixed') {
          const viewEstimates = (input.images ?? []).flatMap((ref, index) =>
            ref.view === 'auto' || ref.view === 'unknown'
              ? [
                  {
                    referenceId: ref.referenceId,
                    view: index === 0 ? 'front' : index === 1 ? 'left' : 'none',
                    confidence: index === 0 ? 0.9 : index === 1 ? 0.8 : 0.2,
                    reason:
                      index === 0
                        ? '主体正面完整可见。'
                        : index === 1
                          ? '主体左侧轮廓完整可见。'
                          : '局部特写，无法与整体标准视角比较。',
                  },
                ]
              : [],
          );
          text = JSON.stringify({ ...(JSON.parse(text) as object), viewEstimates });
        }
      } else if (controls.failure === 'chat500AfterPart' && !build && !results.length) {
        call = {
          name: 'place_part',
          arguments: { partId: 'ld:3001', colorId: 'c:bright-red', pose: { kind: 'grid', x: 0, z: 0, level: 3 } },
        };
      } else if (controls.failure === 'chatConnection' && !build && !results.length) {
        call = { name: 'list_colors', arguments: {} };
      } else if (build) {
        const round = Number(build.match(/Script workflow round: (\d+)/)?.[1]);
        if (controls.guideHouse)
          text = [
            '主体轮廓已搭好，下一轮调整墙体高度和屋顶台阶。',
            '墙体已加高，屋顶改为三层台阶，接下来补上入口和烟囱。',
            '已添加蓝色门廊和烟囱，最后检查重复砖与烟囱连接。',
            '已移除重复砖，并将烟囱接到屋顶。最终检查没有冲突或悬空。',
          ][Math.min(round, 4) - 1]!;
        const scriptId = system.match(/Main scriptId: (\S+)/)?.[1] ?? 'image-fixture';
        if (!results.some((r) => r.ok && r.data?.code) && controls.failure !== 'truncated')
          call = { name: 'get_build_example', arguments: { id: car ? 'car' : tower ? 'onion-tower' : 'cottage' } };
        else if (!results.some((r) => r.ok && r.data?.scriptId)) {
          let code =
            controls.animationCode ??
            (controls.largePreview
              ? round === 1
                ? "part('3001',{x:0,z:0,y:3},'c:bright-red');"
                : `// A 40-stud building encloses the empty-document camera.
for(let x=-18;x<20;x+=4) for(let z=-19;z<20;z+=2)
  part('3001',{x,z,y:3},'c:bright-red');
for(let level=0;level<${round > 2 ? 25 : 24};level++) {
  for(let x=-18;x<20;x+=4) for(const z of [-19,19])
    part('3001',{x,z,y:(level+1)*3},'c:bright-red');
  for(let z=-16;z<18;z+=4) for(const x of [-19,19])
    part('3001',{x,z,y:(level+1)*3,rotY:90},'c:bright-red');
}`
              : controls.guideHouse
                ? guideHouseScript(round)
                : tower
                  ? towerScript(build.includes('Phase: buildability'))
                  : `// Round ${round}
submodel('body',()=>part('3001',{x:0,z:0,y:3},'${controls.wallRoof ? 'c:bright-yellow' : 'c:bright-red'}'));
instance('body',{x:0,z:0,y:0});
submodel('roof',()=>part('${controls.wallRoof ? '3020' : '3001'}',{x:0,z:0,y:${controls.wallRoof ? 4 : 6}},'c:bright-red'));
instance('roof',{x:0,z:0,y:0});`);
          if (controls.buildPlanBoxes) {
            const plan = JSON.parse(build.match(/\nPlan: (.+)\nComponents/)![1]!) as StructurePlan;
            code = plan.components
              .map((c) => {
                const min = c.boundingBox!.min;
                return `submodel('${c.id}',()=>box(${min.x},${min.z},${min.y * 2.5},${c.size.width},${c.size.depth},${c.size.height * 2.5},'${c.colors[0]}'));instance('${c.id}',{x:0,z:0,y:0});`;
              })
              .join('\n');
          }
          call = { name: 'run_build_script', arguments: { scriptId, code, mode: 'replace' } };
        } else if (controls.failedCompare && !results.some((r) => !r.ok))
          call = { name: 'compare_to_reference', arguments: { referenceId: 'missing-reference', view: 'front' } };
        else if (controls.compareExcluded && !results.some((r) => !r.ok)) {
          const note = build.match(/Reference images for compare_to_reference: (.+)/)?.[1];
          const references = note ? (JSON.parse(note) as { referenceId: string; view: string | null }[]) : [];
          const excluded = references.find((ref) => ref.view === null);
          if (excluded)
            call = {
              name: 'compare_to_reference',
              arguments: { referenceId: excluded.referenceId, view: 'isometric' },
            };
        } else if (controls.budget && !texts.some((t) => t.includes('tool-call budget has been exhausted')))
          call = { name: 'list_colors', arguments: {} };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const event = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const finish = () => {
        if (controls.failure) event({ reasoning_content: 'offline reasoning replay' });
        if (call)
          event({
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          });
        else if (controls.cathedral && !request.tools?.length) {
          for (let i = 0; i < text.length; i += 8) event({ content: text.slice(i, i + 8) });
        } else event({ content: text });
        event({}, call ? 'tool_calls' : 'stop');
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      };
      if (controls.keepAliveRequests > 0) {
        controls.keepAliveRequests--;
        res.flushHeaders();
        res.write(': keep-alive\n\n');
        const interval = setInterval(() => res.write(': keep-alive\n\n'), 300);
        const timer = setTimeout(() => {
          clearInterval(interval);
          finish();
        }, controls.keepAliveForMs);
        res.on('close', () => {
          clearInterval(interval);
          clearTimeout(timer);
        });
        return;
      }
      if (controls.reasoningRequests > 0) {
        controls.reasoningRequests--;
        res.flushHeaders();
        let chunks = 0;
        const timer = setInterval(() => {
          if (chunks++ < 10) event({ reasoning_content: 'private fixture thought '.repeat(10) });
          else {
            clearInterval(timer);
            finish();
          }
        }, 300);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (controls.hold) {
        event({ content: '' });
        return;
      }
      if (controls.delay) {
        const timer = setTimeout(finish, controls.delay);
        res.on('close', () => clearTimeout(timer));
      } else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PORT');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    controls,
    requests,
    requestBytes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
