export type Vec3 = readonly [number, number, number];
export type Matrix4 = Float64Array;

export function identity(): Matrix4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function fromLDraw(m: readonly number[]): Matrix4 {
  if (m.length !== 12 || !m.every(Number.isFinite)) throw new RangeError('Expected 12 finite LDraw numbers');
  return new Float64Array([
    m[3]!,
    m[6]!,
    m[9]!,
    0,
    m[4]!,
    m[7]!,
    m[10]!,
    0,
    m[5]!,
    m[8]!,
    m[11]!,
    0,
    m[0]!,
    m[1]!,
    m[2]!,
    1,
  ]);
}

export function toLDraw(m: Matrix4): number[] {
  return [m[12]!, m[13]!, m[14]!, m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
}

export function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const result = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += a[k * 4 + row]! * b[col * 4 + k]!;
      result[col * 4 + row] = value;
    }
  }
  return result;
}

// Pivoted elimination also supports general 4×4 matrices, not just rigid transforms.
function eliminate(m: Matrix4, inverse: boolean): { det: number; matrix: Matrix4 } {
  if (m.length !== 16 || !m.every(Number.isFinite)) throw new RangeError('Expected a finite 4×4 matrix');
  const a = m.slice();
  const result = identity();
  let det = 1;
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++)
      if (Math.abs(a[col * 4 + row]!) > Math.abs(a[col * 4 + pivot]!)) pivot = row;
    const value = a[col * 4 + pivot]!;
    if (value === 0) {
      if (inverse) throw new RangeError('Singular matrix');
      return { det: 0, matrix: result };
    }
    if (pivot !== col) {
      det = -det;
      for (let k = 0; k < 4; k++) {
        [a[k * 4 + col], a[k * 4 + pivot]] = [a[k * 4 + pivot]!, a[k * 4 + col]!];
        [result[k * 4 + col], result[k * 4 + pivot]] = [result[k * 4 + pivot]!, result[k * 4 + col]!];
      }
    }
    det *= value;
    for (let k = 0; k < 4; k++) {
      a[k * 4 + col] = a[k * 4 + col]! / value;
      result[k * 4 + col] = result[k * 4 + col]! / value;
    }
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = a[col * 4 + row]!;
      for (let k = 0; k < 4; k++) {
        a[k * 4 + row] = a[k * 4 + row]! - factor * a[k * 4 + col]!;
        result[k * 4 + row] = result[k * 4 + row]! - factor * result[k * 4 + col]!;
      }
    }
  }
  return { det, matrix: result };
}

export function invert(m: Matrix4): Matrix4 {
  return eliminate(m, true).matrix;
}
export function determinant(m: Matrix4): number {
  return eliminate(m, false).det;
}
export function translation(v: Vec3): Matrix4 {
  const m = identity();
  m.set(v, 12);
  return m;
}
export function transformPoint(m: Matrix4, p: Vec3): [number, number, number] {
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return [0, 1, 2].map((i) => (m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!) / w) as [
    number,
    number,
    number,
  ];
}
export function transformDirection(m: Matrix4, v: Vec3): [number, number, number] {
  return [0, 1, 2].map((i) => m[i]! * v[0] + m[4 + i]! * v[1] + m[8 + i]! * v[2]) as [number, number, number];
}
export function rotationAxisAngle(axis: Vec3, degrees: number): Matrix4 {
  const length = Math.hypot(...axis);
  if (!Number.isFinite(length) || length === 0 || !Number.isFinite(degrees))
    throw new RangeError('Invalid axis or angle');
  const [x, y, z] = axis.map((v) => v / length) as [number, number, number];
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians),
    s = Math.sin(radians),
    t = 1 - c;
  return fromLDraw([
    0,
    0,
    0,
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ]);
}
export function rotateAboutPivot(m: Matrix4, axis: Vec3, degrees: number, pivot: Vec3): Matrix4 {
  return multiply(
    multiply(
      multiply(translation(pivot), rotationAxisAngle(axis, degrees)),
      translation([-pivot[0], -pivot[1], -pivot[2]]),
    ),
    m,
  );
}
export function snapToGrid(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) throw new RangeError('Invalid grid');
  return Math.round(value / step) * step || 0;
}

export function normalizeForSave(m12: readonly number[]): number[] {
  const m = fromLDraw(m12);
  const det = determinant(m);
  const gram = multiply(transposeRotation(m), m);
  let error = 0;
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) error = Math.max(error, Math.abs(gram[c * 4 + r]! - (c === r ? 1 : 0)));
  // Polar decomposition preserves handedness. The tolerance gives serialization a
  // fixed point instead of perturbing already orthogonal matrices on every save.
  if (Math.abs(Math.abs(det) - 1) < 1e-6 && error > 1e-12) {
    const position = [m[12]!, m[13]!, m[14]!] as const;
    m[12] = m[13] = m[14] = 0;
    for (let iteration = 0; iteration < 32; iteration++) {
      const inverseTranspose = transposeRotation(invert(m));
      let delta = 0;
      for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++) {
          const i = c * 4 + r,
            next = (m[i]! + inverseTranspose[i]!) / 2;
          delta = Math.max(delta, Math.abs(next - m[i]!));
          m[i] = next;
        }
      if (delta < 1e-14) break;
    }
    m.set(position, 12);
  }
  const common = [0, 1, -1, 0.5, -0.5, Math.SQRT1_2, -Math.SQRT1_2, Math.sqrt(3) / 2, -Math.sqrt(3) / 2];
  return toLDraw(m).map((value, i) =>
    i < 3 ? Number(value.toFixed(4)) || 0 : (common.find((v) => Math.abs(v - value) < 1e-9) ?? value),
  );
}
function transposeRotation(m: Matrix4): Matrix4 {
  const result = identity();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) result[c * 4 + r] = m[r * 4 + c]!;
  return result;
}
