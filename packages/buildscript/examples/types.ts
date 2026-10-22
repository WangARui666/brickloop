export interface BuildExample {
  id: string;
  name: string;
  useCases: string;
  parameters: { name: string; description: string; default: number | string }[];
  /** Measured using standardPackingParts and the documented reference palette, seed 42. */
  partCount: number;
  code: string;
}
