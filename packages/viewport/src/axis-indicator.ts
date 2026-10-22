import type { Camera } from 'three/webgpu';
import { documentAxes, ldrawToWorld } from './coordinates';
import { viewportColors } from './theme';

export function createAxisIndicator() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 96 96');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.testid = 'axis-indicator';
  Object.assign(svg.style, {
    position: 'absolute',
    right: '12px',
    bottom: '12px',
    width: '96px',
    height: '96px',
    borderRadius: '6px',
    pointerEvents: 'none',
    background: `color-mix(in srgb, var(--bl-bg-panel, ${viewportColors['bg-panel']}) 72%, transparent)`,
    border: `1px solid var(--bl-border, ${viewportColors.border})`,
  });
  const axes = (Object.keys(documentAxes) as (keyof typeof documentAxes)[]).map((label) => {
    const group = document.createElementNS(ns, 'g');
    const line = document.createElementNS(ns, 'line');
    const text = document.createElementNS(ns, 'text');
    const token = `axis-${label.toLowerCase()}` as 'axis-x' | 'axis-y' | 'axis-z';
    group.setAttribute('style', `color:var(--bl-${token}, ${viewportColors[token]})`);
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.75');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('x1', '48');
    line.setAttribute('y1', '48');
    text.textContent = label;
    text.setAttribute('fill', 'currentColor');
    text.setAttribute('font-size', '12');
    text.setAttribute('font-family', 'inherit');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    group.append(line, text);
    svg.append(group);
    return { label, group, line, text };
  });
  return {
    element: svg,
    update(camera: Camera) {
      const inverse = camera.quaternion.clone().invert();
      const ordered = axes
        .map((axis) => ({ ...axis, direction: ldrawToWorld(documentAxes[axis.label]).applyQuaternion(inverse) }))
        .sort((a, b) => a.direction.z - b.direction.z);
      for (const axis of ordered) {
        const { x, y } = axis.direction;
        axis.line.setAttribute('x2', String(48 + x * 27));
        axis.line.setAttribute('y2', String(48 - y * 27));
        axis.text.setAttribute('x', String(48 + x * 37));
        axis.text.setAttribute('y', String(48 - y * 37));
        svg.append(axis.group);
      }
    },
  };
}
