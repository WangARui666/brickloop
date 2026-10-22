import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Tabs } from 'antd';
import { Search } from 'lucide-react';
import type { AboutInfo } from '../../shared/release-api';
import { usePreferences } from './preferences-store';
import { useTranslation } from './store';

export function AboutDialog() {
  const t = useTranslation(),
    open = usePreferences((s) => s.about);
  const [info, setInfo] = useState<AboutInfo | null>(null),
    [error, setError] = useState(false),
    [query, setQuery] = useState('');
  useEffect(() => {
    if (open)
      void window.brickloop
        .aboutInfo()
        .then(setInfo)
        .catch(() => setError(true));
  }, [open]);
  const visibleLicenses =
    info?.licenses.filter((item) => `${item.name} ${item.license}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return (
    <Modal
      title={t('aboutUi.title')}
      open={open}
      width={640}
      className="about-dialog"
      onCancel={() => usePreferences.setState({ about: false })}
      footer={<Button onClick={() => usePreferences.setState({ about: false })}>{t('aiUi.close')}</Button>}
    >
      {error && <Alert type="error" title={t('aboutUi.failed')} />}
      {info && (
        <Tabs
          items={[
            {
              key: 'about',
              label: t('aboutUi.about'),
              children: (
                <div className="about-content">
                  <h2>{t('aboutUi.product')}</h2>
                  <p>{t('aboutUi.developer')}</p>
                  <p className="secondary">{t('aboutUi.copyright')}</p>
                  <p className="secondary">{t('aboutUi.usage')}</p>
                  <dl className="info-grid">
                    {(['version', 'commit', 'date', 'electron', 'chromium', 'node'] as const).map((key) => (
                      <div key={key}>
                        <dt>{t(`aboutUi.${key}`)}</dt>
                        <dd>{info[key]}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ),
            },
            {
              key: 'licenses',
              label: t('aboutUi.licenses'),
              children: (
                <div className="license-content">
                  <Input
                    allowClear
                    prefix={<Search />}
                    aria-label={t('aboutUi.search')}
                    placeholder={t('aboutUi.search')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <p className="secondary">{t('aboutUi.count', { count: info.licenses.length })}</p>
                  <div className="license-list">
                    {!visibleLicenses.length && (
                      <div className="settings-empty">
                        <Search />
                        <span>{t('aboutUi.noResults')}</span>
                      </div>
                    )}
                    {visibleLicenses.map((item) => (
                      <article key={`${item.name}/${item.version}`}>
                        <strong>
                          {item.name} {item.version}
                        </strong>
                        <p>{item.license}</p>
                        {item.repository && <small>{item.repository}</small>}
                        {item.text && (
                          <details>
                            <summary>{t('aboutUi.attribution')}</summary>
                            <pre>{item.text}</pre>
                          </details>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
