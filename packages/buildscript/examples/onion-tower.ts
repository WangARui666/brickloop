import type { BuildExample } from './types.js';
export const onionTower: BuildExample = {
  id: 'onion-tower',
  name: 'Onion dome tower',
  useCases: 'A small landmark with a cylindrical shaft and continuous dome profile.',
  parameters: [{ name: 'shaftHeight', description: 'Shaft height in plates.', default: 18 }],
  partCount: 236,
  code: `const shaftHeight=18;
cylinder(0.5,0.5,0,4,3,'gray');
cylinder(0.5,0.5,3,3,shaftHeight,'tan');
revolve(0.5,0.5,shaftHeight+3,[[0,3],[3,4],[6,3],[10,1],[11,0.5]],'blue');
pack({hollow:true,shell:1,support:6});`,
};
