import type { Category } from '@brickloop/catalog';
import type { BomResult, OutputCatalog } from '@brickloop/io';

export type Paper = 'A4-portrait' | 'A4-landscape' | 'A5' | 'Letter';
export type Language = 'zh-CN' | 'en';
export interface InstructionCatalog extends OutputCatalog {
  categories?: readonly Pick<Category, 'id' | 'order'>[];
}
export interface InstructionOptions {
  paper?: Paper;
  stepsPerPage?: 1 | 2 | 4;
  includeCover?: boolean;
  includeBom?: boolean;
  /** Show part names in step PLIs; defaults to false. BOM names are always shown. */
  pliShowNames?: boolean;
  dpi?: number;
  language?: Language;
  rootModelId?: string;
  catalog?: InstructionCatalog;
  defaultColorId?: string;
  /** ISO date/time; defaults to a fixed epoch, never the wall clock. */
  metadataDate?: string;
}
export interface ResolvedInstructionOptions {
  paper: Paper;
  stepsPerPage: 1 | 2 | 4;
  includeCover: boolean;
  includeBom: boolean;
  pliShowNames: boolean;
  dpi: number;
  language: Language;
  rootModelId: string;
  defaultColorId: string;
  metadataDate: string;
}
/** Top-left origin; all values are points (1/72 inch). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TextElement {
  kind: 'text';
  role: 'header' | 'step-number' | 'label' | 'quantity' | 'name' | 'footer';
  text: string;
  box: Box;
  size: number;
  bold: boolean;
  align: 'left' | 'center';
  /** Single-line text with an ellipsis when it exceeds its box. */
  overflow?: 'ellipsis';
  color?: string;
}
export interface StepImageSource {
  kind: 'step';
  modelId: string;
  /** Zero-based index in ModelDef.stepIds. */
  stepIndex: number;
  inheritedColorId: string;
}
export interface PartImageSource {
  kind: 'part';
  partId: string;
  colorId: string;
}
export interface ImageElement {
  kind: 'image';
  box: Box;
  source: StepImageSource | PartImageSource;
}
export interface PanelElement {
  kind: 'panel';
  box: Box;
  radius: number;
}
export interface LineElement {
  kind: 'line';
  /** The bounding strip; draw along its horizontal or vertical center. */
  box: Box;
  direction: 'horizontal' | 'vertical';
  thickness: number;
  color: string;
}
export type PageElement = TextElement | ImageElement | PanelElement | LineElement;
export interface PartListItem {
  kind: 'part' | 'model';
  id: string;
  colorId: string;
  quantity: number;
  name: string;
  colorName: string;
  number: string;
  factoryNo: string;
  categoryId: string;
  image: PartImageSource | StepImageSource;
}
export interface InstructionStep {
  modelId: string;
  modelName: string;
  stepIndex: number;
  number: string;
  isSubmodel: boolean;
  inheritedColorId: string;
  description: string;
  pli: PartListItem[];
}
export interface InstructionPage {
  kind: 'cover' | 'steps' | 'pli' | 'bom';
  width: number;
  height: number;
  /** Indices into InstructionPlan.steps (empty for cover/BOM). */
  stepIndices: number[];
  elements: PageElement[];
}
export interface InstructionPlan {
  options: ResolvedInstructionOptions;
  title: string;
  author: string;
  steps: InstructionStep[];
  bom: BomResult;
  pages: InstructionPage[];
}
export interface StepRenderRequest {
  modelId: string;
  stepIndex: number;
  highlightNew: true;
  widthPx: number;
  heightPx: number;
  /** Resolve `inherit` using this color, including submodel thumbnails. */
  inheritedColorId: string;
  signal?: AbortSignal;
}
export interface PartRenderRequest {
  partId: string;
  colorId: string;
  sizePx: number;
  signal?: AbortSignal;
}
export interface InstructionHost {
  renderStep(request: StepRenderRequest): Uint8Array | Promise<Uint8Array>;
  renderPart(request: PartRenderRequest): Uint8Array | Promise<Uint8Array>;
  fonts: { regular: Uint8Array; bold: Uint8Array };
  signal?: AbortSignal;
  onProgress?(progress: { completedPages: number; totalPages: number }): void;
}
