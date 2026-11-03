// Real server; synthetic identities and scratch-only data. Ports 9221/9222.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WS from 'ws';
import { chromium } from 'playwright';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;
const dir = mkdtempSync('/home/craig/.hermes/cache/scratch/book-permissions-');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = []; let proc; let log = ''; const failures = []; let count = 0;
function check(ok, name) { count++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures.push(name); }
for (const d of ['.rooms', '.sketchbooks', '.thumbs', '.audio']) mkdirSync(`${dir}/${d}`, { recursive: true });
const fixtureId = 'sb_1111111111111111';
writeFileSync(`${dir}/.sketchbooks/${fixtureId}.json`, JSON.stringify({ id: fixtureId, ownerProfileId: 'fixture_owner', public: false, artists: ['fixture_owner'], pages: ['BADMET','NOREFS','ABSENT'].map((room,i) => ({room,day:i+1,prompt:'fixture',date:'2026-10-01'})) }));
writeFileSync(`${dir}/.rooms/BADMET.json`, '{corrupt');
const soundId='snd_111111111111111111111111';
writeFileSync(`${dir}/.audio/${soundId}.wav`, Buffer.from('RIFF0000WAVEsynthetic'));
writeFileSync(`${dir}/.rooms/NOREFS.json`, JSON.stringify({audience:'artist_public',ownerProfileId:null,soundtrack:{id:soundId,mime:'audio/wav'}}));
writeFileSync(`${dir}/.rooms/ORPHAN.json`, JSON.stringify({audience:'artist_public',ownerProfileId:'intruder',painters:['intruder'],sketchbook:{book:'sb_9999999999999999',day:1}}));
for (const code of ['BADMET','NOREFS','ABSENT','ORPHAN']) writeFileSync(`${dir}/.rooms/${code}.history.json`, JSON.stringify([{kind:'text',text:`SECRET_${code}`,opId:1}]));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA6sAAAAASUVORK5CYII=';
writeFileSync(`${dir}/.sheets.json`, JSON.stringify([{id:'ordinary',name:'ordinary',image:png}]));
const mock = http.createServer((q,s) => { const raw=String(q.headers.authorization||'').replace(/^Bearer /,''); const id=raw==='invalid'?'':raw; s.writeHead(id?200:401,{'Content-Type':'application/json'}); s.end(JSON.stringify({record:{id,name:id}})); });
async function start(cloud=true) {
  proc=spawn(NODE,['server.js'],{cwd:ROOT,env:{...process.env,HOME:dir,DATA_DIR:dir,PORT:'9221',PB_URL:cloud?'http://127.0.0.1:9222':'',ADMIN_KEY:'synthetic-only'},stdio:['ignore','pipe','pipe']});
  proc.stdout.on('data',d=>log+=d);proc.stderr.on('data',d=>log+=d);
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9221/healthz')).ok)return;}catch{ /* Missing optional response or startup not ready. */ }await sleep(100);}throw Error('server startup failed '+log);
}
async function stop(){for(const c of clients)c.ws.terminate();const done=new Promise(r=>proc.once('exit',r));proc.kill('SIGTERM');await done;}
async function api(path,token=null,body=null){const r=await fetch('http://127.0.0.1:9221'+path,{method:body===null?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===null?undefined:JSON.stringify(body)});let data;try{data=await r.json();}catch{ /* Missing optional response or startup not ready. */ }return {status:r.status,body:data};}
async function connect(room,token=null,spectate=false,key=null){const ws=new WS('ws://127.0.0.1:9221/ws?room='+room+(spectate?'&spectate=1':''));const c={ws,msgs:[]};clients.push(c);ws.on('message',d=>{try{c.msgs.push(JSON.parse(d));}catch{ /* Missing optional response or startup not ready. */ }});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});if(!spectate)ws.send(JSON.stringify({type:'auth',token,userKey:key||'dk_fixture_'+(token||'guest')}));await sleep(180);return c;}
const connected=c=>c.msgs.some(m=>m.type==='connected');
try {
 await new Promise((r,j)=>{mock.once('error',j);mock.listen(9222,'127.0.0.1',r);}); await start();
 for(const code of ['BADMET','NOREFS','ABSENT','ORPHAN']) {
   const c=await connect(code,'intruder'); check(!connected(c)&&!JSON.stringify(c.msgs).includes('SECRET_'),`${code} denies stranger and retained history`);
   if(code!=='ORPHAN'){const owner=await connect(code,'fixture_owner');check(connected(owner)&&JSON.stringify(owner.msgs).includes(`SECRET_${code}`),`${code} reconstructs owner and preserves history`);}
 }
 const audio=await fetch('http://127.0.0.1:9221/api/audio/'+soundId);check(audio.status===404,'retained audio denies anonymous source book access');
 const ownerAudio=await fetch('http://127.0.0.1:9221/api/audio/'+soundId,{headers:{Authorization:'Bearer fixture_owner'}});check(ownerAudio.ok&&ownerAudio.headers.get('cache-control')?.includes('no-store'),'retained audio owner access is noncacheable');
 const b=(await api('/api/sketchbooks','owner',{public:true})).body.book;
 const pages=[];for(const day of [1,2])pages.push((await api(`/api/sketchbooks/${b.id}/pages`,'owner',{day})).body.page.room);
 const inv=(await api(`/api/sketchbooks/${b.id}/invites`,'owner',{})).body;
 await api('/api/sketchbooks/accept','artist',{token:inv.token});
 const owners=[],artists=[]; for(const code of pages){owners.push(await connect(code,'owner'));artists.push(await connect(code,'artist'),await connect(code,'artist'));}
 await connect(pages[0],'visitor'); await api('/api/me/rooms','visitor');
 const strangerPost=await api('/api/wall','visitor',{room:pages[0],frames:[png]});check(strangerPost.status===403,'public book viewer cannot claim Wall publication');
 check((await api('/api/wall','owner',{room:pages[0],frames:[png]})).status===200,'public book owner may publish');
 owners[0].ws.send(JSON.stringify({type:'set_trace_photo',image:png}));await sleep(180);
 const trace=owners[0].msgs.findLast(m=>m.type==='sheet')?.sheetId;check(!!trace,'trace fixture created');
 await api(`/api/sketchbooks/${b.id}/visibility`,'owner',{public:false});
 writeFileSync(`${dir}/.thumbs/${pages[0]}.jpg`,'synthetic-thumb');
 check(!(await api('/api/me/rooms','visitor')).body.rooms.some(r=>r.code===pages[0]),'cached My Rooms rechecks private book');
 check((await api(`/api/me/rooms/${pages[0]}/thumb`,'visitor')).status===404,'My Rooms thumbnail rechecks private book');
 if(trace){check((await api('/api/sheets/'+trace)).status===404,'private trace denies anonymous retained URL');check((await api('/api/sheets/'+trace,'owner')).body?.image===png,'private trace authorized JSON dataURL image transport');}
 if(trace){
   const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
   try {
     const page=await browser.newPage();await page.goto('http://127.0.0.1:9221/healthz');
     const loaded=await page.evaluate(async id=>{
       const response=await fetch('/api/sheets/'+id,{headers:{Authorization:'Bearer owner'},cache:'no-store'});
       const data=await response.json();const image=new globalThis.Image();image.src=data.image;await image.decode();return response.ok&&image.naturalWidth===1;
     },trace);
     check(loaded,'real browser authenticated fetch decodes private trace dataURL');
   } finally {await browser.close();}
 }
 await api(`/api/sketchbooks/${b.id}/artists/revoke`,'owner',{profileId:'artist'});await sleep(180);
 check(artists.every(c=>c.ws.readyState===WS.CLOSED),'REST revoke closes every private tab on every page');
 check(owners.every(c=>c.ws.readyState===WS.OPEN),'REST revoke preserves owner tabs');
 check((await api('/api/sketchbooks/'+b.id,'artist')).status===404,'revoked artist reader denied');
 if(trace)check((await api('/api/sheets/'+trace,'artist')).status===404,'revoked artist trace denied');
 await api('/api/sketchbooks/accept','artist',{token:inv.token});const wa=await connect(pages[0],'artist'),wb=await connect(pages[1],'artist');
 const target=owners[0].msgs.filter(m=>m.type==='user_joined').findLast(m=>m.user?.profileId==='artist')?.user?.id || wa.msgs.find(m=>m.type==='connected')?.userId;
 owners[0].ws.send(JSON.stringify({type:'paint_revoke',targetId:target}));await sleep(180);
 check(wa.ws.readyState===WS.CLOSED&&wb.ws.readyState===WS.CLOSED,'WS revoke closes private artist across pages');
 await api('/api/sketchbooks/accept','artist',{token:inv.token});
 const ra=await connect(pages[0],'artist'),rb=await connect(pages[1],'artist');
 const revokeRoute=await api(`/api/rooms/${pages[0]}/painters/revoke`,'owner',{profileId:'artist'});await sleep(180);
 check(revokeRoute.status===200&&ra.ws.readyState===WS.CLOSED&&rb.ws.readyState===WS.CLOSED,'room REST revoke closes artist across private pages');
 await api(`/api/sketchbooks/${b.id}/visibility`,'owner',{public:true});
 const specs=await Promise.all(pages.map(code=>connect(code,null,true)));const outsiders=await Promise.all(pages.map(code=>connect(code,'outsider')));
 await api('/api/account/scrub-chat','owner',{});await sleep(180);
 check([...specs,...outsiders].every(c=>c.ws.readyState===WS.CLOSED),'account deletion privacy transition sweeps every page');
 await sleep(2800);await stop();await start();
 check(!connected(await connect(pages[1],'artist')),'revoked artist denied after restart');
 check(connected(await connect(pages[0],'owner')),'owner retained after restart');
 const hidden=(await api('/api/sketchbooks','hiddenowner',{public:true})).body.book;const hp=(await api(`/api/sketchbooks/${hidden.id}/pages`,'hiddenowner',{day:1})).body.page.room;
 const hv=await connect(hp,'hiddenvisitor');
 const hr=await fetch(`http://127.0.0.1:9221/api/admin/sketchbooks/${hidden.id}/hide`,{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':'synthetic-only'},body:'{}'});check(hr.ok,'hide fixture accepted');await sleep(100);check(hv.ws.readyState===WS.CLOSED&&!connected(await connect(hp,null,true)),'hidden book closes and denies stranger streams');
 const publicBook=(await api('/api/sketchbooks','publicowner',{public:true})).body.book;
 const publicPage=(await api(`/api/sketchbooks/${publicBook.id}/pages`,'publicowner',{day:1})).body.page.room;
 const publicInvite=(await api(`/api/sketchbooks/${publicBook.id}/invites`,'publicowner',{})).body;
 await api('/api/sketchbooks/accept','publicartist',{token:publicInvite.token});
 const publicTabs=await Promise.all([connect(publicPage,'publicartist'),connect(publicPage,'publicartist')]);
 await api(`/api/sketchbooks/${publicBook.id}/artists/revoke`,'publicowner',{profileId:'publicartist'}); await sleep(120);
 check(publicTabs.every(c=>c.ws.readyState===WS.OPEN&&c.msgs.findLast(m=>m.type==='role_changed')?.canPaint===false),'public-book revoke removes painting but preserves public viewer sessions');
 check(connected(await connect(publicPage,'publicartist')),'public-book revoked artist may reconnect as viewer');
 const withCloudGuest=(await api('/api/sketchbooks/guest',null,{device:'cloud_guest_device',day:1})).body;
 const invalidView=await (await fetch('http://127.0.0.1:9221/api/sketchbooks/by-room/'+withCloudGuest.page.room,{headers:{Authorization:'Bearer invalid','X-Drawesome-Device-Key':'cloud_guest_device'}})).json();
 check(invalidView.isGuestOwner===false,'invalid bearer cannot fall back to device proof');
 await stop();await start(false);
 const anon=await connect('ANONOK');check(connected(anon),'cloud-unset ordinary anonymous room works');
 check((await api('/api/sheets/ordinary')).body.image===png,'ordinary anonymous coloring sheet works');
 const guest=(await api('/api/sketchbooks/guest',null,{device:'guest_fixture_device',day:1})).body;check(!!guest.page?.room,'cloud-unset guest sketchbook creates');
 if(guest.page?.room){
   const endpoint='http://127.0.0.1:9221/api/sketchbooks/by-room/'+guest.page.room;
   const headerView=await (await fetch(endpoint+'?dk=wrong_device',{headers:{'X-Drawesome-Device-Key':'guest_fixture_device'}})).json();
   check(headerView.isGuestOwner===true,'device proof header takes precedence over legacy query');
   check((await api('/api/sketchbooks/by-room/'+guest.page.room+'?dk=guest_fixture_device')).body.isGuestOwner===true,'legacy device query preserved');
   const gc=await connect(guest.page.room,null,false,'guest_fixture_device');check(connected(gc)&&gc.msgs.find(m=>m.type==='connected')?.canPaint!==false,'guest owner preserves drawing');}
} catch(e){console.error(e);failures.push(String(e));} finally {if(proc?.exitCode===null)await stop();await new Promise(r=>mock.close(r));writeFileSync(dir+'/server.log',log);writeFileSync(dir+'/results.json',JSON.stringify({count,failures},null,2));console.log(JSON.stringify({count,failures,evidence:dir}));}
if(failures.length)process.exitCode=1;