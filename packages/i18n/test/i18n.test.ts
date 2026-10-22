import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '../src/index';

describe('createI18n', () => {
  it('returns an initialized Chinese instance with the common UI labels', () => {
    const i18n = createI18n();

    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe('zh-CN');
    expect(i18n.t('app.name')).toBe('Brickloop（积环）');
    expect(['file', 'edit', 'view', 'model', 'tools', 'help'].map((key) => i18n.t(`menu.${key}`))).toEqual([
      '文件',
      '编辑',
      '视图',
      '模型',
      '工具',
      '帮助',
    ]);
    expect(['partCount', 'dimensions', 'grid', 'lastRecoveryPoint'].map((key) => i18n.t(`status.${key}`))).toEqual([
      '零件数',
      '尺寸',
      '网格',
      '最后恢复点',
    ]);
    expect(i18n.t('language.zh-CN')).toBe('简体中文');
    expect(i18n.t('language.en')).toBe('English');
  });

  it('accepts English and interpolates parameters in both languages', () => {
    const english = createI18n({ language: 'en' });
    expect(english.t('app.name')).toBe('Brickloop');
    expect(english.t('menu.file')).toBe('File');
    expect(english.t('common:partCountValue', { count: 12 })).toBe('Parts: 12');
    expect(createI18n().t('partCountValue', { count: 12 })).toBe('零件数：12');
  });

  it('changes language, emits events, and supports unsubscribing', async () => {
    const i18n = createI18n();
    const listener = vi.fn();
    i18n.on('languageChanged', listener);

    await i18n.changeLanguage('en');
    expect(i18n.t('menu.file')).toBe('File');
    expect(listener).toHaveBeenCalledExactlyOnceWith('en');

    i18n.off('languageChanged', listener);
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('menu.file')).toBe('文件');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps each instance language independent', async () => {
    const first = createI18n();
    const second = createI18n();
    await first.changeLanguage('en');

    expect(first.t('menu.edit')).toBe('Edit');
    expect(second.t('menu.edit')).toBe('编辑');
  });

  it('falls back to Chinese when an English resource is absent', () => {
    const i18n = createI18n({ language: 'en' });
    i18n.removeResourceBundle('en', 'common');

    expect(i18n.t('menu.file')).toBe('文件');
  });
});
