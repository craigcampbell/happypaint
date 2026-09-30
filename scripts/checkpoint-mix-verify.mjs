import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<title>Checkpoint continuation test</title>');return;}
 if(!/^\/src\/utils\/[A-Za-z0-9]+(?:\.js)?$/.test(url.pathname)){res.writeHead(404).end();return;}
 try{res.setHeader('Content-Type','text/javascript');res.end(readFileSync(root+url.pathname.slice(1)+(url.pathname.endsWith('.js')?'':'.js')));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(19124,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:19124');
 const result=await page.evaluate(async()=>{
  const {createMixMap}=await import('/src/utils/mixMap.js');
  const {replayFrameOnto}=await import('/src/utils/opReplay.js');
  const {createLayerCanvas}=await import('/src/utils/layers.js');
  const c=createLayerCanvas(128,128),g=c.getContext('2d');g.fillStyle='#ff0000';g.fillRect(0,0,128,128);
  const m=createMixMap(()=>c,128,128);const sampled=Array.from(m.sample(32,32));
  // An unmarked write deliberately leaves old sampled cells. Restoring from
  // pixels alone would incorrectly change this authoritative cached sample.
  g.fillStyle='#0000ff';g.fillRect(0,0,128,128);
  if(typeof m.captureState!=='function'||typeof m.restoreState!=='function')return {available:false};
  m.markDirty({x0:64,y0:64,w:16,h:16});const state=m.captureState();
  const resumed=createMixMap(()=>c,128,128);resumed.restoreState(state);
  const stalePreserved=JSON.stringify(Array.from(resumed.sample(32,32)))===JSON.stringify(sampled);
  const refreshed=Array.from(resumed.sample(70,70));
  const fresh=createMixMap(()=>c,128,128);const freshSample=Array.from(fresh.sample(32,32));
  let refused=0;for(const bad of [{...state,width:1},{...state,data:new Uint8ClampedArray(2)},{...state,dirty:{x0:NaN,y0:0,w:1,h:1}}]){try{fresh.restoreState(bad);}catch{refused++;}}
  const shape={kind:'shape',tool:'rect',start:{x:5,y:5},end:{x:100,y:100},opts:{color:'#008800',fillShape:true}};
  let captured;await replayFrameOnto(c,[shape],128,128,null,{onMixState:s=>{captured=s;}});
  const before=Array.from(g.getImageData(10,10,1,1).data);
  await replayFrameOnto(c,[],128,128,null,{preservePixels:true,mixState:captured});
  const after=Array.from(g.getImageData(10,10,1,1).data);
  return {available:true,stalePreserved,refreshed,freshSample,refused,hookCaptured:!!captured,preservePixels:JSON.stringify(before)===JSON.stringify(after)};
 });
 assert.equal(result.available,true,'mix state capture/restore API missing');
 assert.equal(result.stalePreserved,true);assert.deepEqual(result.refreshed,[0,0,255]);assert.deepEqual(result.freshSample,[0,0,255]);assert.equal(result.refused,3);assert.equal(result.hookCaptured,true);assert.equal(result.preservePixels,true);
 console.log('PASS 7 checkpoint mix/continuation checks',JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
