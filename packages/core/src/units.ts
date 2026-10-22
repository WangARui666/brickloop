export const LDU_PER_STUD = 20;
export const LDU_PER_PLATE = 8;
export const LDU_PER_BRICK = 24;
export const MM_PER_LDU = 0.4;
export const LDU_PER_INCH = 63.5;
export const LDU_PER_CM = 25;

export type LengthUnit = 'ldu' | 'stud' | 'plate' | 'brick' | 'mm' | 'cm' | 'inch';

const lduPerUnit: Record<LengthUnit, number> = {
  ldu: 1,
  stud: LDU_PER_STUD,
  plate: LDU_PER_PLATE,
  brick: LDU_PER_BRICK,
  mm: 1 / MM_PER_LDU,
  cm: LDU_PER_CM,
  inch: LDU_PER_INCH,
};

export function toLdu(value: number, unit: LengthUnit): number {
  return value * lduPerUnit[unit];
}

export function fromLdu(ldu: number, unit: LengthUnit): number {
  return ldu / lduPerUnit[unit];
}
