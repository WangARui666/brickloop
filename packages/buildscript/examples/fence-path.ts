import type { BuildExample } from './types.js';
export const fencePath: BuildExample = {
  id: 'fence-path',
  name: 'Fence and footpath',
  useCases: 'Garden boundaries with spaced posts, overlapping rails and a tiled path.',
  parameters: [{ name: 'length', description: 'Fence length, a multiple of 6.', default: 24 }],
  partCount: 66,
  code: `const length=24;
box(0,0,0,length+1,8,1,'green');
box(0,3,1,length+1,3,1,'gray');
for(let x=0;x<=length;x+=6)box(x,0,1,1,1,9,'brown');
box(0,0,4,length+1,1,1,'brown');box(0,0,7,length+1,1,1,'brown');
pack({prefer:'plates',top:[{x:0,z:3,w:length+1,d:3,top:'tiles'}]});`,
};
