import { normalizeTransform } from './math.js';
import { parseLDraw } from './parser.js';
import type { LibraryResolver } from './resolver.js';
import type { EmbeddedData, GeometryLine, LDrawLine, ReferenceLine } from './types.js';

export interface ModelStep {
  instances: ReferenceLine[];
  meta: string[];
  geometry: GeometryLine[];
  /** Interleaving order of the three lists, preserving BFC and unknown meta placement. */
  order: ('instance' | 'meta' | 'geometry')[];
}
export interface ModelSubmodel {
  fileName: string;
  steps: ModelStep[];
}
export interface LDrawModel {
  fileName: string;
  isMpd: boolean;
  submodels: ModelSubmodel[];
  data: EmbeddedData[];
}
const emptyStep = (): ModelStep => ({ instances: [], meta: [], geometry: [], order: [] });

/** Structural import only: references (including missing ones) remain editable instances. */
export function readModel(text: string, fileName: string, resolver?: LibraryResolver): LDrawModel {
  // Accepted for the shared import API; structural import deliberately does not resolve geometry.
  void resolver;
  const parsed = parseLDraw(text, fileName);
  return {
    fileName: parsed.fileName,
    isMpd: parsed.isMpd,
    data: parsed.data,
    submodels: parsed.subfiles.map((file) => {
      let step = emptyStep();
      const steps = [step];
      for (const line of file.lines) {
        if (line.type === 0 && line.command === 'STEP') {
          step = emptyStep();
          steps.push(step);
        } else if (line.type === 0) {
          step.meta.push(line.raw);
          step.order.push('meta');
        } else if (line.type === 1) {
          step.instances.push({ ...line, transform: normalizeTransform(line.transform) });
          step.order.push('instance');
        } else {
          step.geometry.push(line);
          step.order.push('geometry');
        }
      }
      return { fileName: file.fileName, steps };
    }),
  };
}

function formatLine(line: LDrawLine): string {
  if (line.type === 0) return line.raw;
  const color = line.color >= 0x2000000 ? `0x${line.color.toString(16).toUpperCase()}` : String(line.color);
  if (line.type === 1) return `1 ${color} ${normalizeTransform(line.transform).join(' ')} ${line.fileName}`;
  return `${line.type} ${color} ${line.vertices.flat().join(' ')}`;
}

export function writeModel(model: LDrawModel): string {
  const output: string[] = [];
  const mpd = model.isMpd || model.submodels.length > 1 || model.data.length > 0;
  for (const file of model.submodels) {
    if (mpd) output.push(`0 FILE ${file.fileName}`);
    for (const [stepIndex, step] of file.steps.entries()) {
      if (stepIndex > 0) output.push('0 STEP');
      const counters = { instance: 0, meta: 0, geometry: 0 };
      const emit = (kind: ModelStep['order'][number]) => {
        const index = counters[kind]++;
        if (kind === 'meta') {
          if (step.meta[index] !== undefined) output.push(step.meta[index]!);
        } else {
          const line = kind === 'instance' ? step.instances[index] : step.geometry[index];
          if (line) output.push(formatLine(line));
        }
      };
      for (const kind of step.order) emit(kind);
      for (const kind of ['meta', 'instance', 'geometry'] as const) {
        const length =
          kind === 'meta' ? step.meta.length : kind === 'instance' ? step.instances.length : step.geometry.length;
        while (counters[kind] < length) emit(kind);
      }
    }
    if (mpd) output.push('0 NOFILE');
  }
  for (const data of model.data) {
    output.push(`0 !DATA ${data.fileName}`);
    for (let i = 0; i < data.base64.length; i += 80) output.push(`0 !: ${data.base64.slice(i, i + 80)}`);
    output.push('0 NOFILE');
  }
  return `${output.join('\r\n')}\r\n`;
}
