import type { ClipboardData, Placement } from '../clipboard';
import type { IdGenerator, InstancePath } from '../document';
import type { Vec3 } from '../math';
import type { Op } from '../ops';

export type BBox = readonly [number, number, number, number, number, number];
export interface CommandServices {
  id?: IdGenerator;
  bboxProvider?: (partId: string) => BBox | undefined;
}
type Paths = { paths?: InstancePath[] };
export type RotationPivot =
  { kind: 'selectionCenter'; point: Vec3 } | { kind: 'primaryOrigin' } | { kind: 'point'; point: Vec3 };
export type Command = (
  | { type: 'part.add'; partId: string; colorId: string; transform?: number[]; stepId?: string }
  | ({ type: 'transform.translate'; delta: Vec3; space?: 'world' | 'primaryLocal' } & Paths)
  | ({
      type: 'transform.rotate';
      axis: Vec3;
      degrees: number;
      pivot: RotationPivot;
      space?: 'world' | 'primaryLocal';
    } & Paths)
  | ({ type: 'transform.set'; transform: number[]; space?: 'world' | 'context' } & Paths)
  | ({ type: 'transform.snapToGrid'; step: number | Vec3; origin?: Vec3 } & Paths)
  | ({ type: 'color.set'; colorId: string } & Paths)
  | { type: 'color.replace'; from: string; to: string; scope: 'selection' | 'model' | 'document' }
  | ({ type: 'edit.delete' | 'edit.cut' } & Paths)
  | { type: 'edit.paste'; clipboard: ClipboardData; placement?: Placement }
  | ({ type: 'edit.clone'; placement?: Placement } & Paths)
  | ({ type: 'group.create'; name?: string } & Paths)
  | { type: 'group.dissolve'; groupIds?: string[] }
  | { type: 'group.rename'; groupId: string; name: string }
  | ({ type: 'submodel.create'; name: string } & Paths)
  | { type: 'submodel.instantiate'; modelId: string; transform?: number[]; colorId?: string; stepId?: string }
  | ({ type: 'submodel.makeUnique' } & Paths)
  | ({ type: 'submodel.explode' } & Paths)
  | { type: 'submodel.rename'; modelId: string; name: string }
  | { type: 'step.add'; position?: number; description?: string }
  | { type: 'step.remove'; stepId: string; targetStepId?: string }
  | { type: 'step.move'; stepId: string; position: number }
  | ({ type: 'step.assign'; stepId: string; position?: number } & Paths)
) & {
  label?: string;
  source?: 'ui' | 'ai' | 'mcp' | 'import';
  input?: 'keyboard' | 'button' | 'numeric' | 'pointer';
  mergeKey?: string;
};
export interface CommandOutput {
  ops: Op[];
  clipboard?: ClipboardData;
  selection?: InstancePath[];
}
