import { z } from 'zod';
import { parseShortcuts } from './shortcuts';

export const preferencesSchema = z.object({
  unit: z.enum(['stud', 'mm', 'cm', 'ldu']).default('stud'),
  reopenLast: z.boolean().default(false),
  snapshotMinutes: z.number().int().min(1).max(60).default(5),
  grid: z.union([z.literal(20), z.literal(10), z.literal(5)]).default(20),
  angle: z
    .union([z.literal(90), z.literal(45), z.literal(22.5), z.literal(15), z.literal(5), z.literal(1)])
    .default(90),
  collisionPolicy: z.enum(['warn', 'block']).default('warn'),
  snap: z.boolean().default(true),
  edgeMode: z.enum(['auto', 'always']).default('auto'),
  mergeKeyboard: z.boolean().default(true),
  libraryPath: z.string().max(32768).default(''),
  logging: z.boolean().default(false),
  developerMode: z.boolean().default(false),
  shortcuts: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseShortcuts(value ?? {});
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid shortcuts' });
        return z.NEVER;
      }
    }),
});
export type Preferences = z.output<typeof preferencesSchema>;
export const defaultPreferences: Preferences = preferencesSchema.parse({});
