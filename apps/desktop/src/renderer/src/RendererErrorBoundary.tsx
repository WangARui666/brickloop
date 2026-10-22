import { Component, useState } from 'react';
import type { ReactNode } from 'react';
import { documentTabs } from './document-store';
import { useTranslation } from './store';

function RecoveryPage() {
  const t = useTranslation();
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <main className="renderer-recovery" role="alert">
      <h1>{t('desktop.rendererError')}</h1>
      <p>{t('desktop.rendererRecovery')}</p>
      {failed && <p>{t('files.recoveryFailed')}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          // Flush the existing recovery journal before reloading; initialization offers recovery.
          void window.brickloop
            .aiStop()
            .then(() => Promise.all([...documentTabs.values()].map((tab) => tab.pending)))
            .then(() => window.brickloop.reloadRenderer())
            .catch(() => {
              setFailed(true);
              setBusy(false);
            });
        }}
      >
        {t('desktop.reloadRenderer')}
      </button>
    </main>
  );
}

export class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <RecoveryPage /> : this.props.children;
  }
}
