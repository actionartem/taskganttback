import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { allowedItsmUrl, createItsmRelay, registerItsmRelayRoutes, RELAY_MAX_BYTES } from './tracker-itsm-relay.js';
import { createItsmClient } from './tracker-itsm.js';
const token='dedicated-test-worker-credential-32-chars', url='https://api.itsm.mos.ru/v1/requests/27787457';
const headers={'X-ITSM-Relay-Token':token,'Content-Type':'application/json'}, resources=[];
after(async()=>{for(const {relay,server} of resources){relay.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}});
async function setup(options={}){
 const relay=createItsmRelay({token,pollMs:20,...options}),app=express();registerItsmRelayRoutes(app,{relay});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/integrations/itsm-relay`;resources.push({relay,server});
 const poll=async(capacity=4)=>(await fetch(base+'/jobs?capacity='+capacity,{headers})).json();
 const post=async(job,patch={})=>fetch(base+'/jobs/'+job.id+'/result',{method:'POST',headers,body:JSON.stringify({nonce:job.nonce,status:200,body:Buffer.from('{"id":27787457}').toString('base64'),...patch})});
 return {relay,app,base,poll,post};
}
test('allowlist accepts only official incident resources and bounded pagination',()=>{
 for(const suffix of ['','/notes?per_page=100&page=2','/audit','/cis','/note_attachments'])assert.equal(allowedItsmUrl(url+suffix),true);
 for(const u of [url.replace('https:','http:'),url.replace('api.itsm.mos.ru','evil.invalid'),url+'/users',url+'/notes/../../users',url+'#x',url+'?page=0',url+'?page=1&page=2',url+'?per_page=101',url+'?url=https://evil.invalid',url.replace('https://','https://x@'),url.replace('https://','https://x:y@'),url+'/%6eotes',url+'?page=-1',url+'?page=1000000',url+'?page=1\n'])assert.equal(allowedItsmUrl(u),false,u);
});
test('worker auth is separate and precedes parsing; offline calls fail safely',async()=>{
 const s=await setup();
 for(const h of [{},{Authorization:'Bearer '+token},{'X-ITSM-Relay-Token':'bad'}]){
  assert.equal((await fetch(s.base+'/jobs',{headers:h})).status,401);
  assert.equal((await fetch(s.base+'/jobs/x/result',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:'invalid'})).status,401);
 }
 assert.equal((await fetch(s.base+'/jobs?capacity=5',{headers})).status,400);
 assert.equal((await fetch(s.base+'/jobs/x/result',{method:'POST',headers,body:'invalid'})).status,400);
 assert.equal((await fetch(s.base+'/status',{headers})).status,200);
 await assert.rejects(s.relay.fetch(url),e=>e.status===503&&/ноутбук/i.test(e.message));
});
test('raw JSON, upstream HTTP status and Link survive relay; replay is rejected',async()=>{
 const s=await setup();await s.poll();
 const pending=s.relay.fetch(url+'/notes?per_page=100'),[job]=(await s.poll()).jobs;
 assert.equal(job.url,url+'/notes?per_page=100');assert.equal(job.max_bytes,RELAY_MAX_BYTES);assert.equal('token' in job,false);
 const link=`<${url}/notes?page=2&per_page=100>; rel="next"`,raw='[ {"id":1,"text":"Заметка"} ]';
 assert.equal((await s.post(job,{status:401,link,body:Buffer.from(raw).toString('base64')})).status,204);
 const response=await pending;assert.equal(response.status,401);assert.equal(await response.text(),raw);assert.equal(response.headers.get('link'),link);
 assert.equal((await s.post(job)).status,409);
});
test('wrong nonce, expired, cancelled and unknown jobs cannot deliver results',async()=>{
 const s=await setup({timeoutMs:80});await s.poll();
 const controller=new AbortController(),request=s.relay.fetch(url,{signal:controller.signal}),[job]=(await s.poll()).jobs;
 assert.equal((await s.post(job,{nonce:'incorrect'})).status,409);
 controller.abort();await assert.rejects(request,e=>e.status===504);assert.equal((await s.post(job)).status,409);
 const expired=s.relay.fetch(url),check=assert.rejects(expired,e=>e.status===504),[late]=(await s.poll()).jobs;
 await check;assert.equal((await s.post(late)).status,409);assert.equal(s.relay.stats().pending,0);
});
test('queue, reply size, base64 and Link are bounded; invalid result does not consume job',async()=>{
 const s=await setup({maxPending:1});await s.poll();const pending=s.relay.fetch(url),[job]=(await s.poll()).jobs;
 await assert.rejects(s.relay.fetch(url),e=>e.status===503);
 for(const patch of [{status:199},{status:600},{status:'200'},{body:'???'},{body:'a==='},{body:'x'.repeat(4*Math.ceil(RELAY_MAX_BYTES/3)+4)},{link:'x\r\ny'},{link:'x'.repeat(16385)},{error:'private error'}])assert.equal((await s.post(job,patch)).status,400);
 assert.equal((await s.post(job)).status,204);assert.equal((await pending).status,200);
 await assert.rejects(s.relay.fetch('https://evil.invalid'),e=>e.status===400);
});
test('provider failures and worker disconnect fail closed; polling recovers without restart',async()=>{
 const s=await setup({onlineMs:20});await s.poll();const pending=s.relay.fetch(url),check=assert.rejects(pending,e=>e.status===504),[job]=(await s.poll()).jobs;
 assert.equal((await s.post(job,{error:'network'})).status,204);await check;
 await new Promise(r=>setTimeout(r,30));await assert.rejects(s.relay.fetch(url),e=>e.status===503);
 await s.poll();const again=s.relay.fetch(url),[fresh]=(await s.poll()).jobs;await s.post(fresh);assert.equal((await again).status,200);
});
test('shared client relays all sections, pagination, separate 401, concurrency and repeated fresh reads',async()=>{
 const s=await setup();await s.poll();let stop=false,cardReads=0,maxConcurrent=0;
 const worker=(async()=>{while(!stop){const {jobs}=await s.poll();maxConcurrent=Math.max(maxConcurrent,jobs.length);for(const job of jobs){
  const u=new URL(job.url);let body,status=200,link;
  if(u.pathname.endsWith('/27787457')){cardReads++;body={id:27787457,impact:'low',status:'in_progress',resolution_target_at:'2026-11-02T10:50:00Z'};}
  else if(u.pathname.endsWith('/affected_slas')){status=401;body={message:'provider-private-error'};}
  else if(u.pathname.endsWith('/notes')&&!u.searchParams.has('page')){body=[{id:1,text:'first'}];link=`<${url}/notes?page=2&per_page=100>; rel="next"`;}
  else if(u.pathname.endsWith('/notes'))body=[{id:2,text:'second'}];else body=[];
  assert.equal((await s.post(job,{status,link,body:Buffer.from(JSON.stringify(body)).toString('base64')})).status,204);
 }}})();
 await new Promise(r=>setTimeout(r,5));const client=createItsmClient({token:'',transport:'relay',relay:s.relay});assert.equal(client.configured,true);
 const details=await client.details('27787457');assert.equal(details.record.id,27787457);assert.equal(details.sections.notes.items.length,2);
 assert.equal(details.sections.affected_slas.upstream_status,401);assert.equal(details.sections.affected_slas.complete,false);
 assert.equal(Object.keys(details.sections).length,12);assert.ok(maxConcurrent>=2);assert.equal(JSON.stringify(details).includes('provider-private-error'),false);
 await client.record('27787457');assert.equal(cardReads,2);stop=true;await worker;
});

test('isolated database: relayed synchronization changes only four fields; monitor archives correctly and never closes on offline/API errors',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const fs=await import('node:fs/promises');
 const {registerIncidentRoutes}=await import('./tracker-incidents.js');const {runIncidentMonitor}=await import('./tracker-incident-monitor.js');
 const db=new PGlite();await db.exec('CREATE TABLE users(id BIGSERIAL PRIMARY KEY);INSERT INTO users DEFAULT VALUES;');
 for(const name of ['20261029_incidents.sql','20261029_incident_itsm.sql'])await db.exec(await fs.readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const pool={query:(q,p)=>db.query(q,p)},s=await setup();await s.poll();
 const itsm=createItsmClient({token:'',transport:'relay',relay:s.relay});
 const user=(req,_res,next)=>{req.user={id:'1'};next();};s.app.use(express.json());
 registerIncidentRoutes(s.app,{pool,requireUser:user,requireIncidentEditor:user,itsm,startJobs:false});
 let stop=false,upstreamStatus=200,source={id:27787457,status:'waiting_for',impact:'low',resolution_target_at:'2026-10-29T10:00:00Z',waiting_until:'2026-11-02T10:00:00Z'};
 const worker=(async()=>{while(!stop){const {jobs}=await s.poll();for(const job of jobs)await s.post(job,{status:upstreamStatus,body:Buffer.from(JSON.stringify(source)).toString('base64')});}})();
 await new Promise(r=>setTimeout(r,5));
 const api=s.base.replace('/integrations/itsm-relay','');
 const create=async(number)=>{const response=await fetch(api+'/incidents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number,jira_url:'https://jira.invalid/browse/FIXTURE-1',priority:'high',expires_at:'2026-10-29T10:00:00Z',is_deferred:false,deferred_until:null,comment:'local comment'})});assert.equal(response.status,201);return response.json();};
 try{
  const local=await create('27787457');
  const synced=await fetch(api+`/incidents/${local.id}/itsm/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:local.version})});
  assert.equal(synced.status,200);const saved=(await synced.json()).incident;
  assert.equal(saved.number,local.number);assert.equal(saved.jira_url,local.jira_url);assert.equal(saved.comment,local.comment);
  assert.equal(saved.priority,'low');assert.equal(saved.is_deferred,true);assert.equal(new Date(saved.deferred_until).toISOString(),'2026-11-02T10:00:00.000Z');
  const now=new Date('2026-11-03T10:00:00Z');upstreamStatus=401;await runIncidentMonitor({pool,itsm,now});
  const failed=(await pool.query('SELECT * FROM incidents WHERE id=$1',[local.id])).rows[0];assert.equal(failed.status,'active');assert.equal(failed.closed_at,null);assert.ok(failed.check_error);
  stop=true;await worker;s.relay.stop();
  const offlineRow=await create('999999');
  const offline=await fetch(api+`/incidents/${offlineRow.id}/itsm/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1})});
  assert.equal(offline.status,503);const unchanged=(await pool.query('SELECT * FROM incidents WHERE id=$1',[offlineRow.id])).rows[0];assert.equal(unchanged.version,1);assert.equal(unchanged.priority,'high');
  await runIncidentMonitor({pool,itsm,now:new Date('2026-11-04T10:00:00Z')});
  assert.equal((await pool.query('SELECT status FROM incidents WHERE id=$1',[offlineRow.id])).rows[0].status,'active');
 }finally{stop=true;await worker;await db.close();}
});
