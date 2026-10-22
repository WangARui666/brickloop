import { identity, translation } from '@brickloop/core';
import type { Vec3 } from '@brickloop/core';
import type { Connector, ConnectorFile, ConnectorInstance, ConnectorType } from '../src';
export function connector(type: ConnectorType, extra: Partial<Connector> = {}): Connector {
  const hole = [
    'antistud',
    'antistud.tube',
    'bar.hole',
    'clip',
    'axle.hole',
    'pin.hole',
    'ball.socket',
    'bar.thin.hole',
    'wheel.hole',
  ].includes(type);
  return {
    id: type,
    type,
    frame: { origin: [0, 0, 0], axis: hole ? [0, 1, 0] : [0, -1, 0], ref: [1, 0, 0] },
    ...extra,
  };
}
export const file = (connectors: Connector[]): ConnectorFile => ({
  schema: 1,
  partId: 'ld:fixture',
  status: 'draft',
  source: 'independent fixture',
  connectors,
});
export const instance = (
  id: string,
  connectors: readonly Connector[],
  position: Vec3 = [0, 0, 0],
): ConnectorInstance => ({ path: [id], worldMatrix: translation(position), connectors });
export const unit = identity();
export const bar = () => connector('bar', { length: 10, diameter: 8, rotation: 'free' });
export const hole = () => connector('bar.hole', { length: 20, diameter: 8, rotation: 'free' });
