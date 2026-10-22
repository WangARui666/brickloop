import type { ReactNode } from 'react';
import { Button, Modal } from 'antd';
import { useTranslation } from './store';

/** Shared settings shell; pages are supplied by their owning features. */
export function SettingsDialog({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
  const t = useTranslation();
  return (
    <Modal
      title={t('settingsUi.title')}
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('aiUi.close')}</Button>}
      width={760}
      className="settings-dialog ai-settings-modal"
      destroyOnHidden
    >
      {children}
    </Modal>
  );
}
