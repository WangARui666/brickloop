import { useRef } from 'react';
import { useShellStore, useTranslation } from './store';

export function PanelResizeHandle({ side }: { side: 'left' | 'right' }) {
  const t = useTranslation();
  const width = useShellStore((state) => (side === 'left' ? state.leftWidth : state.rightWidth));
  const setWidth = useShellStore((state) => state.setPanelWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === 'left' ? 1 : -1;
  return (
    <div
      className={`panel-resize panel-resize-${side}`}
      role="separator"
      tabIndex={0}
      aria-label={t(side === 'left' ? 'desktop.panels.resizeLibrary' : 'desktop.panels.resizeInspector')}
      aria-controls={side === 'left' ? 'library-panel' : 'inspector-panel'}
      aria-orientation="vertical"
      aria-valuemin={side === 'left' ? 220 : 260}
      aria-valuemax={side === 'left' ? 420 : 480}
      aria-valuenow={width}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (drag.current) setWidth(side, drag.current.width + (event.clientX - drag.current.x) * direction);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          setWidth(side, width + (event.key === 'ArrowRight' ? 8 : -8) * direction);
          event.preventDefault();
        }
      }}
    />
  );
}
