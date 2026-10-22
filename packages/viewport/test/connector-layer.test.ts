import { expect, it } from 'vitest';
import { connectorStyle } from '../src/connector-layer';
import type { Connector } from '@brickloop/connect';
const connector = (type: Connector['type'], options: Partial<Connector> = {}): Connector => ({
  id: 'point',
  type,
  frame: { origin: [0, 0, 0], axis: [0, -1, 0], ref: [1, 0, 0] },
  ...options,
});
it('uses designer colors and distinguishes hollow, cross, pin-depth and paired shapes', () => {
  expect(connectorStyle(connector('stud'))).toEqual({ color: '#ef4444', shape: 'solid' });
  expect(connectorStyle(connector('stud.hollow')).shape).toBe('tube');
  expect(connectorStyle(connector('antistud')).color).toBe('#3485ff');
  expect(connectorStyle(connector('axle'))).toEqual({ color: '#163d94', shape: 'cross' });
  expect(connectorStyle(connector('pin.hole'))).toEqual({ color: '#ffdb3b', shape: 'depth' });
  expect(connectorStyle(connector('hinge.click', { role: 'b' })).color).toBe('#89943f');
  expect(connectorStyle(connector('fixed', { role: 'a', tag: 'special' })).color).toBe('#b575ed');
  expect([11, 17, 30].map((size) => connectorStyle(connector('fixed', { tag: `tyre-seat-${size}mm` })).color)).toEqual([
    '#3485ff',
    '#ff8a3d',
    '#ef4444',
  ]);
});
