import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RendererErrorBoundary } from './RendererErrorBoundary';
import { useShellStore } from './store';
import './styles.css';
import { fontFamily, shellVariables } from './theme';
import { initializeAi } from './ai-integration';
import { initializeMacros } from './macro-store';
import { registerDocumentRenderer } from './document-store';

for (const [key, value] of Object.entries(shellVariables))
  document.documentElement.style.setProperty(key, String(value));
document.documentElement.style.fontFamily = fontFamily;

const container = document.getElementById('root');
if (!container) throw new Error('Missing renderer root');
const root = createRoot(container);
registerDocumentRenderer(() => root.unmount());
root.render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);
void useShellStore.getState().initialize();
initializeAi();
initializeMacros();
