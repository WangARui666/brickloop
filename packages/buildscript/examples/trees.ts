import type { BuildExample } from './types.js';
export const trees: BuildExample = {
  id: 'trees',
  name: 'Broadleaf and conifer trees',
  useCases: 'Two reusable tree definitions for parks, gardens and forests.',
  parameters: [{ name: 'spacing', description: 'Distance between trees in studs.', default: 12 }],
  partCount: 184,
  code: `const spacing=12;
submodel('broadleaf',()=>{
  box(-1,-1,0,2,2,15,'brown');
  sphere(0,16,0,4,'green');
});
submodel('conifer',()=>{
  box(-1,-1,0,2,2,18,'brown');
  revolve(0.5,0.5,8,[[0,4],[4,2],[5,3],[9,1],[10,2],[15,0.5]],'green');
});
instance('broadleaf',{x:0,z:0,y:0});
instance('conifer',{x:spacing,z:0,y:0});`,
};
