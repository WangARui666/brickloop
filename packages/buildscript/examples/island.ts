import type { BuildExample } from './types.js';
export const island: BuildExample = {
  id: 'island',
  name: 'Island and water',
  useCases: 'A low terrain patch with sand banks, green hills and surrounding water.',
  parameters: [{ name: 'size', description: 'Square map width in studs.', default: 24 }],
  partCount: 211,
  code: `const size=24, rows=[];
box(0,0,0,size,size,1,'blue');
for(let z=0;z<size;z++){
  const row=[];for(let x=0;x<size;x++)row.push(Math.max(1,Math.floor(7-Math.hypot(x-size/2,z-size/2)*0.65)));
  rows.push(row);
}
heightmap(0,0,rows,(x,z,y)=>y===0?'blue':y<3?'tan':'green');
pack({top:[{x:0,z:0,w:size,d:size,top:'tiles'}]});`,
};
