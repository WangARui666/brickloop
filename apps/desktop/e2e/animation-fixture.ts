/** The M9 cottage, with thirteen wall courses and eleven paving stones: exactly 2,000 parts. */
export const animationCottage = `submodel('庭院村舍', () => {
  for (let z=0; z<24; z+=2) for (let x=0; x<32; x+=4)
    part('3020', {x:x+2, z:z+1, y:1}, 'gray');
  for (let course=0; course<13; course++) {
    const y=4+course*3;
    for (let x=0; x<32; x++) {
      const window=(x>=5&&x<9||x>=23&&x<27)&&course>=4&&course<8;
      if (!window && !(x>=14&&x<18&&course<8)) part('3005', {x:x+.5,z:.5,y}, 'tan');
      if (!window) part('3005', {x:x+.5,z:23.5,y}, 'tan');
    }
    for (let z=1; z<23; z++) {
      part('3005', {x:.5,z:z+.5,y}, 'tan');
      part('3005', {x:31.5,z:z+.5,y}, 'tan');
    }
  }
  for (let tier=0; tier<9; tier++) for (let z=-1; z<25; z+=2)
    for (let x=-2+tier*2; x<34-tier*2; x+=4)
      part('3020', {x:x+2,z:z+1,y:41+tier}, 'c:bright-red');
  for(let i=0;i<11;i++)part('3020',{x:12+(i%3)*4,z:-1-Math.floor(i/3)*2,y:1},'gray');
});
instance('庭院村舍',{x:0,z:0,y:0});`;
