// Desktop presentation order (A-23); catalog IDs and its public API remain unchanged.
const order = [
  'brick',
  'brick-round',
  'brick-modified',
  'slope',
  'slope-curved',
  'slope-inverted',
  'plate',
  'plate-round',
  'plate-modified',
  'tile',
  'tile-round',
  'wedge',
  'arch',
  'bracket',
  'hinge',
  'bar',
  'clip',
  'technic',
  'wheel',
  'tyre',
  'tire',
  'door',
  'window',
  'plant',
  'minifig',
];
export function categoryRank(id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? order.length : index;
}
