import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrationWindow, frameCanvasBytes } from '../src/utils/frameHydration.js';
const frames = (count,layers) => Array.from({length:count},(_,i)=>({id:`f${i}`,layerMeta:Array.from({length:layers},(_,j)=>({id:`L${j}`}))}));
test('three-layer scene admits only a stable budget-fitting neighborhood',()=>{
 const f=frames(60,3),budget=240*1024*1024;
 const selected=hydrationWindow(f,30,budget,2);
 assert.deepEqual([...selected],[30,29]);
 assert([...selected].reduce((n,i)=>n+frameCanvasBytes(f[i]),0)<=budget);
 f[31].layers=f[31].layerMeta.map(()=>({canvas:{width:4000,height:2500}}));
 assert.deepEqual([...hydrationWindow(f,30,budget,2)],[30,29]);
});
test('one-layer scenes retain the full existing neighborhood',()=>{
 assert.deepEqual([...hydrationWindow(frames(20,1),10,240*1024*1024,2)],[10,9,11,8,12]);
});
test('active frame is admitted even when its own canvas exceeds the budget',()=>{
 assert.deepEqual([...hydrationWindow(frames(8,6),0,1,2)],[0]);
});
