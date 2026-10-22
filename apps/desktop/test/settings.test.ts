import { describe, expect, it } from 'vitest';
import { decodeSettings, parseSettings, serializeSettings } from '../src/main/settings';
import type { Language } from '../src/shared/api';

describe('settings codec', () => {
  it('preserves active pack and deduplicated favorites while upgrading old settings', () => {
    expect(
      parseSettings(
        serializeSettings({
          language: 'en',
          activePackId: 'factory-2026',
          favoriteColors: ['c:bright-red', 'c:bright-red'],
        }),
      ),
    ).toEqual({ language: 'en', activePackId: 'factory-2026', favoriteColors: ['c:bright-red'] });
    expect(
      parseSettings('{"language":"zh-CN","activePackId":"../invalid","favoriteColors":[null,"c:bright-red"]}'),
    ).toEqual({ language: 'zh-CN', favoriteColors: ['c:bright-red'] });
  });
  it.each(['zh-CN', 'en'] as const)('round trips %s and writes only language', (language) => {
    const content = serializeSettings({ language });
    expect(parseSettings(content)).toEqual({ language });
    expect(JSON.parse(content)).toEqual({ language });
    expect(content.endsWith('\n')).toBe(true);
  });
  it('accepts future fields on read without copying them into settings', () => {
    expect(parseSettings('{"language":"en","future":true}')).toEqual({ language: 'en' });
  });
  it('uses Chinese defaults for a missing file', () => {
    expect(decodeSettings(undefined)).toEqual({ settings: { language: 'zh-CN' }, corrupt: false });
  });
  it.each(['', '{', 'null', '[]', '{}', '{"language":"fr"}', '{"language":42}', '"en"'])(
    'marks corrupt input: %s',
    (content) => {
      expect(decodeSettings(content)).toEqual({ settings: { language: 'zh-CN' }, corrupt: true });
    },
  );
  it('rejects invalid runtime values on write', () => {
    expect(() => serializeSettings({ language: 'fr' as Language })).toThrow(TypeError);
  });
});
it.each([
  [80, 10, null, null],
  [90, 15, 90, 15],
  [80, 15, null, 15],
  [90, 10, 90, null],
  [null, null, null, null],
])('migrates old saved limits %s / %s', (toolLimit, durationMinutes, tools, minutes) => {
  const parsed = parseSettings(JSON.stringify({ language: 'en', ai: { toolLimit, durationMinutes } }));
  expect(parsed.ai).toMatchObject({ limitsVersion: 1, toolLimit: tools, durationMinutes: minutes });
  expect(parseSettings(serializeSettings(parsed))).toEqual(parsed);
});
it('defaults to unlimited and preserves explicit legacy-sized limits after migration', () => {
  const parsed = parseSettings('{"language":"en","ai":{}}');
  expect(parsed.ai).toMatchObject({ toolLimit: null, durationMinutes: null });
  parsed.ai!.toolLimit = 80;
  parsed.ai!.durationMinutes = 10;
  expect(parseSettings(serializeSettings(parsed)).ai).toMatchObject({ toolLimit: 80, durationMinutes: 10 });
});
