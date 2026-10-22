import type { StructurePlan } from '@brickloop/ai';

/** Original teaching model. Coordinates use studs horizontally and plate heights vertically. */
export const guideHouseParts: {
  name: string;
  part: string;
  color: string;
  x: number;
  y: number;
  z: number;
  turn?: boolean;
}[] = [];
for (const x of [-2, 2])
  for (const z of [-2, 0, 2]) guideHouseParts.push({ name: '地基', part: '3020', color: 'c:bright-blue', x, y: 1, z });
for (const y of [4, 7, 10]) {
  for (const x of [-2, 2])
    for (const z of [-2, 2])
      guideHouseParts.push({
        name: y === 10 && z === -2 ? `前檐${x}` : '墙体',
        part: '3001',
        color: 'c:bright-yellow',
        x,
        y,
        z,
      });
  for (const x of [-3.5, 3.5])
    guideHouseParts.push({ name: '侧墙', part: '3004', color: 'c:bright-yellow', x, y, z: 0, turn: true });
}
for (const x of [-2, 2]) {
  for (const z of [-2, 0, 2]) guideHouseParts.push({ name: '屋檐', part: '3020', color: 'c:bright-red', x, y: 11, z });
  for (const z of [-1, 1]) guideHouseParts.push({ name: '屋面', part: '3001', color: 'c:bright-red', x, y: 14, z });
  guideHouseParts.push({ name: '屋脊', part: '3001', color: 'c:bright-red', x, y: 17, z: 0 });
}
guideHouseParts.push(
  { name: '烟囱', part: '3005', color: 'c:bright-blue', x: 2.5, y: 20, z: 0.5 },
  { name: '门廊', part: '3004', color: 'c:bright-blue', x: -2, y: 3, z: -3.5 },
);

export const guideHousePlan: StructurePlan = {
  name: '红顶小屋',
  components: [
    {
      id: '墙体',
      name: '墙体与门廊',
      size: { width: 10, depth: 7, height: 7.2 },
      boundingBox: { min: { x: -5, y: 0, z: -4 }, max: { x: 5, y: 7.2, z: 3 } },
      category: 'buildings',
      strategy: 'parts',
      colors: ['c:bright-yellow', 'c:bright-blue'],
      partTypes: ['砖', '板'],
      connections: [],
    },
    {
      id: '屋顶',
      name: '屋顶与烟囱',
      size: { width: 12, depth: 6, height: 6 },
      boundingBox: { min: { x: -6, y: 7.2, z: -3 }, max: { x: 6, y: 13.2, z: 3 } },
      category: 'buildings',
      strategy: 'parts',
      colors: ['c:bright-red', 'c:bright-blue'],
      partTypes: ['砖', '板'],
      connections: [{ target: '墙体', description: '屋顶连接墙体顶面' }],
    },
  ],
  buildOrder: ['墙体', '屋顶'],
};

/** Four real script revisions; approved chat/review scenes keep guideHouseParts above. */
export function guideHouseScript(round: number) {
  return `// 第 ${round} 轮：${['主体起稿', '调整墙体比例与屋顶台阶', '增加门廊与烟囱', '移除重叠砖并接好烟囱'][Math.min(round, 4) - 1]}
const round = ${round};
function layer(w,d,y,plate,turn=false){
  const width=turn?d:w, depth=turn?w:d;
  for(let z=0;z<depth;z+=2) for(let x=0;x<width;){
    const n=Math.min(4,width-x);
    part(plate?(n===4?'3020':'3022'):(n===4?'3001':'3003'),
      {x:(turn?z+1:x+n/2)-w/2,z:(turn?x+n/2:z+1)-d/2,y,rotY:turn?90:0},
      plate?'c:bright-red':color);
    x+=n;
  }
}
let color='c:bright-yellow';
const wallTop=round===1?12:18;
submodel('墙体',()=>{
  for(let y=3;y<=wallTop;y+=3)layer(10,6,y,false,(y/3)%2===0);
  if(round<4)part('3001',{x:-3,z:-2,y:3},'c:bright-yellow'); // 收尾时移除这块重复砖
  if(round>=3)part('3004',{x:0,z:-3.5,y:3},'c:bright-blue');
});
instance('墙体',{x:0,z:0,y:0});
color='c:bright-red';
submodel('屋顶',()=>{
  if(round===1){layer(10,6,13,true);layer(10,6,14,true,true);}
  else for(let step=0;step<3;step++){
    const width=12-step*4, base=wallTop+step*5;
    layer(width,6,base+3,false);layer(width,6,base+4,true,true);layer(width,6,base+5,true);
  }
  if(round>=3)part('3005',{x:2.5,z:0.5,y:round<4?33:31},'c:bright-blue');
});
instance('屋顶',{x:0,z:0,y:0});`;
}
