import type { AgentResult } from './agent/runtime.js';

export interface EvaluationCase {
  id: string;
  prompt: string;
  references: { asset: string; view: 'front' | 'right' }[];
}
const subjects = [
  '红屋顶小房屋',
  '带车库的房屋',
  '方形塔楼',
  '红白灯塔',
  '蓝色小汽车',
  '绿色货车',
  '黄色公交车',
  '蓝白小船',
  '橙色小猫',
  '棕色小狗',
  '蓝色小鸟',
  '灰色大象',
  '红色靠背椅',
  '棕色餐桌',
  '三层书架',
  '蓝白床铺',
  '红花绿叶盆栽',
  '绿色小树',
  '蓝灰机器人',
  '红衣小人',
] as const;
export const evaluationCases: readonly EvaluationCase[] = [
  ...subjects.map((subject, index) => ({
    id: `text-${String(index + 1).padStart(2, '0')}`,
    prompt: `搭建一个${subject}，宽度不超过 16 格。只使用工厂件和工厂色，保证单一连通分量，完成后校验并给出零件数。`,
    references: [],
  })),
  ...subjects.map((subject, index): EvaluationCase => ({
    id: `image-${String(index + 1).padStart(2, '0')}`,
    prompt: `根据参考图搭建${subject}，宽度不超过 16 格。保持轮廓与主要配色，使用真实工厂件、工厂色，校验并渲染对应视角。`,
    references: (index < 10 ? ['front' as const] : ['front' as const, 'right' as const]).map((view) => ({
      asset: `references/${String(index + 1).padStart(2, '0')}-${view}.png`,
      view,
    })),
  })),
];
export interface EvaluationMetrics {
  collisions: number;
  connectedComponents: number;
  nonFactoryParts: number;
  nonFactoryColors: number;
  partCount: number;
  silhouetteIoU?: number;
  colorDifference?: number;
}
export interface EvaluationRecord {
  caseId: string;
  provider: string;
  model: string;
  promptVersion: string;
  valid: boolean;
  metrics: EvaluationMetrics;
  elapsedMs: number;
  cost: number | null;
  stopReason: AgentResult['reason'];
}
/** Host provides isolated documents, reference assets and computed editor metrics. No API calls here. */
export async function evaluateSuite(options: {
  provider: string;
  model: string;
  promptVersion: string;
  cases?: readonly EvaluationCase[];
  signal?: AbortSignal;
  execute(test: EvaluationCase): Promise<{ result: AgentResult; metrics: EvaluationMetrics }>;
  save(record: EvaluationRecord): Promise<void>;
}): Promise<EvaluationRecord[]> {
  const records: EvaluationRecord[] = [];
  for (const test of options.cases ?? evaluationCases) {
    if (options.signal?.aborted) break;
    const { result, metrics } = await options.execute(test);
    const record: EvaluationRecord = {
      caseId: test.id,
      provider: options.provider,
      model: options.model,
      promptVersion: options.promptVersion,
      valid:
        metrics.partCount > 0 &&
        metrics.collisions === 0 &&
        metrics.connectedComponents === 1 &&
        metrics.nonFactoryParts === 0 &&
        metrics.nonFactoryColors === 0,
      metrics,
      elapsedMs: result.elapsedMs,
      cost: result.cost.amount,
      stopReason: result.reason,
    };
    await options.save(record);
    records.push(record);
  }
  return records;
}
