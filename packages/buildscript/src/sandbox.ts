import { getQuickJS } from 'quickjs-emscripten';
import { Engine } from './engine.js';
import { Budget, BuildFailure } from './limits.js';
import { engineUnavailable } from './errors.js';
import type { BuildError, BuildOptions, BuildResult } from './types.js';

const bootstrap = `
((bridge,seed)=>{
  'use strict';
  delete globalThis.__buildBridge;
  const stringify=JSON.stringify,parse=JSON.parse,ErrorClass=Error;
  const call=(name,args)=>{
    const response=parse(bridge(name,stringify(args)));
    if(response.error){const e=new ErrorClass(response.error.message);e.code=response.error.code;throw e;}
    return response.value;
  };
  for(const name of ['box','prism','wall','cylinder','revolve','sphere','cell','part','instance','color','pack','clear'])
    globalThis[name]=(...args)=>call(name,args);
  globalThis.parts=Object.freeze({find:(query)=>call('find',[query])});
  globalThis.heightmap=(x,z,rows,color)=>{
    if(typeof color!=='function')return call('heightmap',[x,z,rows,color]);
    if(!Number.isInteger(x)||!Number.isInteger(z)||!Array.isArray(rows))throw new ErrorClass('Invalid heightmap');
    for(let i=0;i<rows.length;i++){
      if(!Array.isArray(rows[i]))throw new ErrorClass('Invalid heightmap row');
      for(let j=0;j<rows[i].length;j++){
        const h=rows[i][j];if(!Number.isInteger(h)||h<0||h>1000000)throw new ErrorClass('Invalid height');
        for(let y=0;y<h;y++)call('cell',[x+j,y,z+i,color(x+j,z+i,y)]);
      }
    }
  };
  globalThis.submodel=(name,fn)=>{call('enterModel',[name]);try{fn();}finally{call('leave',[]);}};
  globalThis.transform=(opts,fn)=>{call('enterTransform',[opts]);try{fn();}finally{call('leave',[]);}};
  let state=seed>>>0;
  const random=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  globalThis.rand=random;Math.random=random;
  const OriginalDate=Date;
  function FixedDate(...args){if(!new.target)return new OriginalDate(0).toUTCString();return new OriginalDate(...(args.length?args:[0]));}
  FixedDate.prototype=OriginalDate.prototype;FixedDate.now=()=>0;FixedDate.parse=OriginalDate.parse;FixedDate.UTC=OriginalDate.UTC;
  Object.defineProperty(OriginalDate.prototype,'constructor',{value:FixedDate});
  globalThis.Date=FixedDate;
})(globalThis.__buildBridge,SEED);
`;
function failure(error: unknown, code: BuildError['code'] = 'RUNTIME'): BuildError {
  if (error instanceof BuildFailure)
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.suggestions ? { suggestions: error.suggestions } : {}),
    };
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}
function location(value: Record<string, unknown>, source: string): { line: number; column: number } {
  const match = String(value.stack ?? '').match(/build-script\.js:(\d+)(?::(\d+))?/);
  const line = Number(match?.[1] ?? value.lineNumber ?? 1);
  // QuickJS does not always supply columns; identify the first token on that source line.
  const column = Number(match?.[2] ?? value.columnNumber ?? (source.split('\n')[line - 1]?.search(/\S/) ?? 0) + 1);
  return { line: Math.max(1, line), column: Math.max(1, column) };
}
/** Pure engine. Call from a dedicated browser Worker in the desktop integration (M9-3).
 * This module uses only Web/ECMAScript APIs, never Node globals or host eval. */
export async function runBuildScript(code: string, options: BuildOptions): Promise<BuildResult | BuildError> {
  const start = performance.now();
  let budget: Budget;
  try {
    budget = new Budget(options.limits);
    if (budget.limits.memoryBytes < 512 * 1024)
      return { ok: false, code: 'MEMORY', message: 'QuickJS requires at least 512 KiB', line: 1, column: 1 };
  } catch (e) {
    return { ...failure(e), line: 1, column: 1 };
  }
  let module: Awaited<ReturnType<typeof getQuickJS>>;
  try {
    module = await getQuickJS();
  } catch (e) {
    return engineUnavailable(e);
  }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(Math.floor(budget.limits.memoryBytes / 2));
  runtime.setMaxStackSize(Math.min(1024 * 1024, Math.floor(budget.limits.memoryBytes / 8)));
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    timedOut = performance.now() - budget.started >= budget.limits.cpuMs;
    return timedOut || !!budget.fatal;
  });
  const vm = runtime.newContext();
  try {
    budget.check();
    if (code.length * 2 > budget.limits.memoryBytes / 8)
      throw new BuildFailure('MEMORY', 'Script source exceeds memory budget');
    const engine = new Engine(options, budget);
    const bridge = vm.newFunction('buildBridge', (nameHandle, argsHandle) => {
      try {
        const serialized = vm.getString(argsHandle);
        const bytes = serialized.length * 16 + 1024;
        budget.memory(bytes);
        try {
          const args = JSON.parse(serialized) as unknown[];
          const value = engine.invoke(vm.getString(nameHandle), args);
          return vm.newString(JSON.stringify({ value }));
        } finally {
          budget.memory(-bytes);
        }
      } catch (e) {
        return vm.newString(JSON.stringify({ error: failure(e) }));
      }
    });
    vm.setProp(vm.global, '__buildBridge', bridge);
    bridge.dispose();
    const evaluate = (source: string, filename: string): BuildError | undefined => {
      const result = vm.evalCode(source, filename, { type: 'global' });
      if (result.error) {
        const dumped = vm.dump(result.error) as Record<string, unknown>;
        result.error.dispose();
        const message = String(dumped.message ?? 'QuickJS allocation failed');
        const error = budget.fatal
          ? failure(budget.fatal)
          : {
              ok: false as const,
              code: timedOut
                ? ('TIMEOUT' as const)
                : /out of memory|allocation failed/i.test(message)
                  ? ('MEMORY' as const)
                  : dumped.name === 'SyntaxError'
                    ? ('SYNTAX' as const)
                    : ['SYNTAX', 'RUNTIME', 'TIMEOUT', 'MEMORY', 'LIMIT', 'PART_NOT_ALLOWED'].includes(
                          String(dumped.code),
                        )
                      ? (dumped.code as BuildError['code'])
                      : ('RUNTIME' as const),
              message: timedOut ? '运行超时 (execution timed out)' : message,
            };
        return { ...error, ...location(dumped, code) };
      }
      result.value.dispose();
      return undefined;
    };
    const setupError = evaluate(bootstrap.replace('SEED', String((options.seed ?? 0) >>> 0)), 'build-api.js');
    if (setupError) return setupError;
    const error = evaluate(code, 'build-script.js');
    if (error) return error;
    while (runtime.hasPendingJob()) {
      budget.check();
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const dumped = vm.dump(jobs.error) as Record<string, unknown>;
        jobs.error.dispose();
        return { ...failure(String(dumped.message)), ...location(dumped, code) };
      }
    }
    budget.check();
    const result = engine.finish();
    result.stats.ms = performance.now() - start;
    return result;
  } catch (e) {
    return { ...failure(e), line: 1, column: 1 };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
