import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SOURCE=process.env.CHECKPOINT_MAIN_SOURCE || '/home/craig/Projects/happypaint/app_data/.rooms';
const OUT='/home/craig/Projects/happypaint-evidence/room-loading-implementation-2026-09-29/phase3';
const SCRATCH='/home/craig/.hermes/cache/scratch/checkpoint-e2e';
const meta=JSON.parse(fs.readFileSync(path.join(SOURCE,'MAIN.json')));
const baseRaw=JSON.parse(fs.readFileSync(path.join(SOURCE,'MAIN.history.json')));
const base=Array.isArray(baseRaw)?baseRaw:baseRaw.history;
const last=base.at(-1)?.opId||0;
const log=fs.readFileSync(path.join(SOURCE,'MAIN.ops.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
const hidden=new Set(meta.hiddenOpIds||[]);
const ops=[...base,...log.filter(o=>o.opId>last)].filter(o=>!hidden.has(o.opId));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const children=[];let browser;
const results={scope:'Actual unchanged captured MAIN ops, two real isolated servers, built studio, trusted worker ON vs OFF; visible composite hashes, not cross-device proof',ops:ops.length,joins:[]};
async function boot(port,enabled){
 const dir=path.join(SCRATCH,String(port));fs.mkdirSync(path.join(dir,'.rooms'),{recursive:true});const now=Date.now();
 fs.writeFileSync(path.join(dir,'.rooms','MAIN.json'),JSON.stringify({history:ops,frames:meta.frames,scenes:meta.scenes,audience:'kid_safe',brushMode:meta.brushMode,wetCanvas:meta.wetCanvas,createdAt:now,savedAt:now,wipeAt:now+86400000}));
 const c=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,PB_URL:'',ADMIN_KEY:'checkpoint-e2e-only',AUTO_CLOSE:'off',ENABLE_TRUSTED_CHECKPOINTS:enabled?'1':'',CHECKPOINT_CHROME_PATH:'/usr/bin/google-chrome',CHECKPOINT_JOB_TIMEOUT_MS:'120000',CHECKPOINT_MIN_OPS:'10'},stdio:['ignore','pipe','pipe']});
 let logs='';c.stdout.on('data',b=>logs+=b);c.stderr.on('data',b=>logs+=b);children.push(c);
 for(let i=0;i<150;i++){if(c.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)return;}catch{}await sleep(100);}throw Error('server boot timeout');
}
try{
 await boot(19125,true);await boot(19126,false);
 const warm=new WebSocket('ws://127.0.0.1:19125/ws?room=MAIN&gz=1');warm.on('open',()=>warm.send(JSON.stringify({type:'auth',token:null})));
 const metrics=async()=>await(await fetch('http://127.0.0.1:19125/api/admin/metrics',{headers:{'x-admin-key':'checkpoint-e2e-only'}})).json();
 let cp;
 for(let i=0;i<180;i++){cp=(await metrics()).checkpoints;if(cp?.entries>0)break;if(cp?.buildFailures>0)throw Error(JSON.stringify(cp));await sleep(1000);}warm.close();assert(cp?.entries>0,'real MAIN checkpoint was not generated');results.warmed=cp;
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu','--disable-accelerated-2d-canvas']});
 for(const port of [19126,19125]){
  const context=await browser.newContext({viewport:{width:375,height:812},deviceScaleFactor:1});await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const page=await context.newPage();const events=[];const errors=[];let advertised=false,nacks=0;const t=performance.now();
  page.on('pageerror',e=>errors.push(e.message));page.on('websocket',ws=>{if(ws.url().includes('/ws?'))advertised ||= new URL(ws.url()).searchParams.has('cp');ws.on('framereceived',ev=>{if(typeof ev.payload!=='string')events.push({type:'binary',bytes:ev.payload.length,ms:performance.now()-t});});ws.on('framesent',ev=>{if(String(ev.payload).includes('checkpoint_nack'))nacks++;});});
  await page.goto(`http://127.0.0.1:${port}/join/MAIN`,{waitUntil:'domcontentloaded'});await page.bringToFront();
  await page.waitForFunction(()=>window.__drawesomeFrames&&(document.querySelector('#load-curtain-title')?.textContent==='Your canvas is ready!'||!document.querySelector('.load-curtain')),null,{timeout:120000});
  const readyMs=performance.now()-t;
  const pixels=await page.evaluate(async()=>{const c=document.querySelector('.display-canvas');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return {width:c.width,height:c.height,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',p))).map(x=>x.toString(16).padStart(2,'0')).join('')};});
  results.joins.push({checkpoint:port===19125,advertised,nacks,readyMs,events,errors,pixels});await context.close();
 }
 results.finalMetrics=(await metrics()).checkpoints;fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'parent-real-main-e2e.json'),JSON.stringify(results,null,2));
 assert(results.joins.every(r=>r.advertised&&r.nacks===0&&r.errors.length===0));assert(results.finalMetrics.hits>0);assert.equal(results.joins[0].pixels.hash,results.joins[1].pixels.hash,'checkpoint and full replay visible pixels diverged');console.log(JSON.stringify(results,null,2));
}finally{
 await browser?.close();for(const c of children){if(c.exitCode===null){c.kill('SIGTERM');await Promise.race([new Promise(r=>c.once('exit',r)),sleep(5000)]);if(c.exitCode===null)c.kill('SIGKILL');}}
 fs.rmSync(SCRATCH,{recursive:true,force:true});
}
