import { createInstance } from 'i18next';
import type { i18n } from 'i18next';
import en from '../locales/en/common.json';
import zhCN from '../locales/zh-CN/common.json';

export function createI18n(options: { language?: 'zh-CN' | 'en' } = {}): i18n {
  // Bundled resources and synchronous initialization make t() ready on return.
  return createInstance(
    {
      lng: options.language ?? 'zh-CN',
      fallbackLng: 'zh-CN',
      supportedLngs: ['zh-CN', 'en'],
      load: 'currentOnly',
      defaultNS: 'common',
      ns: ['common'],
      initAsync: false,
      resources: {
        'zh-CN': { common: zhCN },
        en: { common: en },
      },
    },
    () => undefined,
  );
}
