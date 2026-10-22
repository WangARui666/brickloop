import type { BuildExample } from './types.js';
export const car: BuildExample = {
  id: 'car',
  name: 'Compact display car',
  useCases: 'A six-stud-wide display vehicle, with block wheels and a glazed cabin.',
  parameters: [{ name: 'length', description: 'Body length in studs, at least 10.', default: 12 }],
  partCount: 40,
  code: `const length=12;
for(const x of [2,length-4])for(const z of [-1,5])box(x,z,0,2,2,3,'black');
box(0,0,2,length,6,2,'red');
box(3,1,4,6,4,3,'blue');
box(3,1,7,6,4,1,'red');
box(0,1,4,2,4,1,'red');
box(length-1,0,3,1,1,1,'yellow');box(length-1,5,3,1,1,1,'yellow');
pack({top:'tiles'});`,
};
