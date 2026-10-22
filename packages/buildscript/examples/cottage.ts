import type { BuildExample } from './types.js';
export const cottage: BuildExample = {
  id: 'cottage',
  name: 'Windowed cottage',
  useCases: 'Village buildings with a door, windows and a stepped pitched roof.',
  parameters: [
    { name: 'width', description: 'House width in studs, at least 10.', default: 12 },
    { name: 'depth', description: 'House depth in studs.', default: 10 },
  ],
  partCount: 154,
  code: `const width=12, depth=10;
box(0,0,0,width,depth,1,'gray');
wall([[0.5,0.5],[width-0.5,0.5],[width-0.5,depth-0.5],[0.5,depth-0.5],[0.5,0.5]],1,12,'tan',
  {openings:[{at:4,width:3,y:1,h:9},{at:14,width:3,y:5,h:4},{at:27,width:3,y:5,h:4}]});
// Roof slabs form a visible pitched silhouette, with a one-stud eave.
for(let step=0;step<6;step++)box(-1+step,-1,13+step*2,width+2-step*2,depth+2,2,'red');
box(width/2-1,-1,25,2,depth+2,1,'red');
pack({prefer:'bricks'});`,
};
