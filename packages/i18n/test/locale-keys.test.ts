import { describe, expect, it } from 'vitest';
import en from '../locales/en/common.json';
import zhCN from '../locales/zh-CN/common.json';
import { checkLocaleKeys } from '../scripts/locale-keys';
import type { LocaleMessages } from '../scripts/locale-keys';

describe('checkLocaleKeys', () => {
  it('passes for the shipped resources', () => {
    expect(checkLocaleKeys({ 'zh-CN': { common: zhCN }, en: { common: en } })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('fails when a Chinese key is deleted from a copy of the shipped resources', () => {
    const chinese: LocaleMessages = structuredClone(zhCN);
    delete chinese.partCountValue;

    expect(checkLocaleKeys({ 'zh-CN': { common: chinese }, en: { common: en } })).toEqual({
      ok: false,
      errors: ['zh-CN: missing key "common:partCountValue"'],
      warnings: [],
    });
  });

  it('warns but passes when an English key is deleted', () => {
    const english: LocaleMessages = structuredClone(en);
    delete english.partCountValue;

    expect(checkLocaleKeys({ 'zh-CN': { common: zhCN }, en: { common: english } })).toEqual({
      ok: true,
      errors: [],
      warnings: ['en: missing key "common:partCountValue"'],
    });
  });

  it('compares nested keys across all languages and namespaces', () => {
    const result = checkLocaleKeys({
      'zh-CN': { common: { menu: { file: '文件' } } },
      en: { common: { menu: { file: 'File' } } },
      fr: { common: { menu: { file: 'Fichier' } }, model: { action: { save: 'Enregistrer' } } },
    });

    expect(result).toEqual({
      ok: false,
      errors: ['zh-CN: missing key "model:action.save"'],
      warnings: ['en: missing key "model:action.save"'],
    });
  });

  it('fails if the entire Chinese language is absent', () => {
    expect(checkLocaleKeys({ en: { common: en } })).toEqual({
      ok: false,
      errors: ['zh-CN: missing language resources'],
      warnings: [],
    });
  });

  it('warns but passes if the entire English language is absent', () => {
    expect(checkLocaleKeys({ 'zh-CN': { common: zhCN } })).toEqual({
      ok: true,
      errors: [],
      warnings: ['en: missing language resources'],
    });
  });
});
