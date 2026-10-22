const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export type IdGenerator = () => string;
export interface UlidOptions {
  clock?: () => number;
  random?: () => number;
}
export function createUlidGenerator({ clock = Date.now, random = Math.random }: UlidOptions = {}): IdGenerator {
  let lastTime = -1;
  let digits: number[] = [];
  return () => {
    let time = Math.floor(clock());
    if (!Number.isFinite(time) || time < 0 || time > 0xffffffffffff) throw new RangeError('Invalid ULID time');
    time = Math.max(time, lastTime);
    if (time === lastTime) {
      let index = 15;
      while (index >= 0 && digits[index] === 31) digits[index--] = 0;
      if (index < 0) throw new RangeError('ULID random sequence exhausted');
      digits[index] = digits[index]! + 1;
    } else {
      digits = Array.from({ length: 16 }, () => {
        const value = random();
        if (!(value >= 0 && value < 1)) throw new RangeError('Invalid ULID random source');
        return Math.floor(value * 32);
      });
    }
    lastTime = time;
    let prefix = '';
    for (let i = 0; i < 10; i++) {
      prefix = alphabet[time % 32]! + prefix;
      time = Math.floor(time / 32);
    }
    return prefix + digits.map((d) => alphabet[d]).join('');
  };
}
export const ulid: IdGenerator = createUlidGenerator();
export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
