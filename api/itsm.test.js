import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { createItsmClient, incidentSyncFields, ITSM_SECTIONS } from './tracker-itsm.js';
import { registerIncidentRoutes } from './tracker-incidents.js';
import { incidentClosureDecision, runIncidentMonitor } from './tracker-incident-monitor.js';

const NOW = new Date('2026-10-29T15:00:00Z');
const remote = () => ({ id: 27787457, status: 'waiting_for', impact: 'low', resolution_target_at: '2026-10-29T14:00:00Z', waiting_until: '2026-11-02T13:21:00Z', completed_at: null });
const input = { number: '27787457', jira_url: 'https://jira.example.invalid/browse/MANUAL-42', priority: 'high', expires_at: '2026-10-29T14:59:00Z', is_deferred: false, deferred_until: null, comment: 'Наш комментарий\nВторая строка' };
let db, pool, server, base, source, recordCalls, recordHook;
const itsm = {
  async record() { recordCalls++; if (recordHook) await recordHook(); return structuredClone(source); },
  async details() { return { record: await this.record(), checked_at: NOW.toISOString(), sections: { notes: { title: 'Обсуждение', complete: true, error: null, items: [{ id: 1, text: 'Первое сообщение' }] } } }; },
};
before(async () => {
  db = new PGlite(); await db.exec('CREATE TABLE users(id BIGSERIAL PRIMARY KEY); INSERT INTO users DEFAULT VALUES;');
  for (const migration of ['20261029_incidents.sql','20261029_incident_itsm.sql']) {
    const sql = await fs.readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'); await db.exec(sql); await db.exec(sql);
  }
  pool = { query: (sql, params) => db.query(sql, params) };
  const app = express(); app.use(express.json());
  const requireUser = (req, res, next) => {
    if (!['Bearer editor','Bearer viewer'].includes(req.get('authorization'))) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: '1' }; next();
  };
  const requireIncidentEditor = (req, res, next) => requireUser(req, res, () => req.get('authorization') === 'Bearer viewer' ? res.status(403).json({ error: 'read only' }) : next());
  registerIncidentRoutes(app, { pool, requireUser, requireIncidentEditor, itsm, startJobs: false });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await pool.query('DELETE FROM incidents'); source = remote(); recordCalls = 0; recordHook = null; });
after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
const call = (path, method = 'GET', body, role = 'editor') => fetch(base+path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${role}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const create = async (patch = {}) => { const response = await call('/incidents','POST',{ ...input, ...patch }); assert.equal(response.status,201); return response.json(); };
const row = async id => (await pool.query('SELECT * FROM incidents WHERE id=$1',[id])).rows[0];

test('ITSM reads all pages, keeps partial errors separate, uses only fixed-host authenticated GETs', async () => {
  const calls = [];
  const client = createItsmClient({ token: 'fixture-token', fetchImpl: async (url, options) => {
    calls.push(url); const parsed = new URL(url);
    assert.equal(parsed.origin,'https://api.itsm.mos.ru'); assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer fixture-token'); assert.equal(options.headers['X-4me-Account'],'echd');
    if (parsed.pathname.endsWith('/27787457')) return Response.json(remote());
    if (parsed.pathname.endsWith('/notes') && !parsed.searchParams.has('page')) return Response.json([{ id: 1, text: 'first' }],{ headers: { Link: '<https://api.itsm.mos.ru/v1/requests/27787457/notes?page=2&per_page=100>; rel="next"' } });
    if (parsed.pathname.endsWith('/notes')) return Response.json([{ id: 1, text: 'duplicate' },{ id: 2, text: 'last' }]);
    if (parsed.pathname.endsWith('/affected_slas')) return Response.json({ message: 'private error text' },{ status: 401 });
    return Response.json([]);
  } });
  const details = await client.details('27787457');
  assert.deepEqual(details.sections.notes.items.map(item=>item.id),[1,2]); assert.equal(details.sections.notes.complete,true);
  assert.equal(details.sections.affected_slas.complete,false); assert.equal(details.sections.affected_slas.upstream_status,401);
  assert.equal(Object.keys(details.sections).length,Object.keys(ITSM_SECTIONS).length);
  assert.equal(calls.length,14); assert.ok(!JSON.stringify(details).includes('fixture-token')); assert.ok(!JSON.stringify(details).includes('private error text'));
});
test('pagination cannot send the token to another host, resource or a repeated page', async () => {
  for (const next of ['https://evil.example/steal','https://api.itsm.mos.ru/v1/users','https://api.itsm.mos.ru/v1/requests/27787457/notes?per_page=100']) {
    let outgoing = 0;
    const client = createItsmClient({ token:'fixture-token', fetchImpl: async url => {
      if (url.endsWith('/27787457')) return Response.json(remote());
      if (new URL(url).pathname.endsWith('/notes')) { outgoing++; return Response.json([{id:1}],{headers:{Link:`<${next}>; rel="next"`}}); }
      return Response.json([]);
    } });
    const details = await client.details('27787457'); assert.equal(details.sections.notes.complete,false); assert.equal(outgoing,1); assert.equal(details.sections.notes.items.length,1);
  }
});
test('missing integration, malformed source data and nonnumeric numbers fail without leaking credentials', async () => {
  let calls=0;
  await assert.rejects(createItsmClient({token:'',fetchImpl:async()=>{calls++;}}).record('27787457'),error=>error.status===503); assert.equal(calls,0);
  await assert.rejects(createItsmClient({token:'fixture-token'}).record('../users'),error=>error.status===400);
  await assert.rejects(createItsmClient({token:'fixture-token',fetchImpl:async()=>Response.json({id:999})}).record('27787457'),error=>error.status===502);
  await assert.rejects(createItsmClient({token:'fixture-token',fetchImpl:async()=>new Response('invalid JSON')}).record('27787457'),error=>error.status===502);
});
test('sync mapping preserves a real source deadline, maps top to high and rejects unknown or contradictory dates', () => {
  const mapped=incidentSyncFields({...remote(),impact:'top'}); assert.equal(mapped.priority,'high'); assert.equal(mapped.is_deferred,true);
  assert.equal(mapped.deferred_until,'2026-11-02T13:21:00.000Z');
  assert.equal(incidentSyncFields({...remote(),status:'in_progress'}).deferred_until,null);
  for(const patch of [{impact:null},{impact:'toString'},{resolution_target_at:'best_effort'},{resolution_target_at:'2026-02-30T10:00:00Z'},{waiting_until:null},{waiting_until:'2026-10-28T00:00:00Z'}]) assert.throws(()=>incidentSyncFields({...remote(),...patch}),error=>error.status===422);
});
test('local comments round trip, reject oversized values and survive legacy clients', async () => {
  const incident=await create(); assert.equal(incident.comment,input.comment);
  const legacy={...input,version:incident.version}; delete legacy.comment;
  assert.equal((await call(`/incidents/${incident.id}`,'PATCH',legacy)).status,200); assert.equal((await row(incident.id)).comment,input.comment);
  assert.equal((await call('/incidents','POST',{...input,number:'999',comment:'x'.repeat(10001)})).status,400);
  const cleared=await call(`/incidents/${incident.id}`,'PATCH',{...input,comment:'',version:2}); assert.equal(cleared.status,200); assert.equal((await cleared.json()).comment,'');
});
test('details are readable, sync is editor-only, fresh on every press and never changes Jira or comment', async () => {
  const incident=await create();
  assert.equal((await call(`/incidents/${incident.id}/itsm`,'GET',null,null)).status,401);
  const details=await call(`/incidents/${incident.id}/itsm`,'GET',null,'viewer'); assert.equal(details.status,200); assert.match(details.headers.get('cache-control'),/no-store/);
  assert.equal((await details.json()).sections.notes.items[0].text,'Первое сообщение');
  assert.equal((await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:1},'viewer')).status,403);
  const saved=await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:1}); assert.equal(saved.status,200); const synced=await saved.json();
  assert.equal(synced.incident.comment,input.comment); assert.equal(synced.incident.jira_url,input.jira_url); assert.equal(synced.incident.priority,'low'); assert.equal(synced.incident.is_deferred,true);
  assert.deepEqual(synced.changed_fields.sort(),['priority','expires_at','is_deferred','deferred_until'].sort());
  const again=await(await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:synced.incident.version})).json(); assert.deepEqual(again.changed_fields,[]); assert.equal(again.incident.version,synced.incident.version);
  source={...source,impact:'medium'};
  const fresh=await(await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:synced.incident.version})).json(); assert.equal(fresh.incident.priority,'medium'); assert.equal(recordCalls,4);
});
test('invalid source or concurrent editing never causes a partial sync', async () => {
  const incident=await create(); source={...source,resolution_target_at:null};
  assert.equal((await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:1})).status,422); assert.equal((await row(incident.id)).version,1);
  source=remote(); recordHook=async()=>{recordHook=null; const response=await call(`/incidents/${incident.id}`,'PATCH',{...input,comment:'Новая ручная правка',version:1}); assert.equal(response.status,200);};
  assert.equal((await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:1})).status,409);
  const after=await row(incident.id); assert.equal(after.priority,'high'); assert.equal(after.comment,'Новая ручная правка'); assert.equal(after.is_deferred,false);
});
test('manual closure is versioned, final for automation and cannot be overwritten by sync', async () => {
  const incident=await create();
  assert.equal((await call(`/incidents/${incident.id}/close`,'POST',{status:'completed',version:1},'viewer')).status,403);
  assert.equal((await call(`/incidents/${incident.id}/close`,'POST',{status:'other',version:1})).status,400);
  const response=await call(`/incidents/${incident.id}/close`,'POST',{status:'completed',version:1}); assert.equal(response.status,200);
  const archived=await response.json(); assert.equal(archived.closure_source,'manual'); assert.equal(archived.next_check_at,null);
  await runIncidentMonitor({pool,itsm,now:NOW}); assert.equal(recordCalls,0);
  assert.equal((await call(`/incidents/${incident.id}/itsm/sync`,'POST',{version:2})).status,409); assert.equal(recordCalls,0);
  assert.equal((await call(`/incidents/${incident.id}/close`,'POST',{status:'burned',version:2})).status,409);
  assert.equal((await row(incident.id)).status,'completed');
});
test('closure compares completion time, not current status alone; late completion remains burned', () => {
  const incident={...input};
  assert.equal(incidentClosureDecision(incident,{...remote(),status:'completed',waiting_until:null,completed_at:'2026-10-29T13:59:00Z'},NOW).status,'completed');
  assert.equal(incidentClosureDecision(incident,{...remote(),status:'completed',waiting_until:null,completed_at:'2026-10-29T14:01:00Z'},NOW).status,'burned');
  assert.equal(incidentClosureDecision(incident,{status:'in_progress',resolution_target_at:'2025-08-12T14:20:00+03:00',completed_at:null},NOW).status,'burned');
  assert.throws(()=>incidentClosureDecision(incident,{...remote(),status:'completed',completed_at:null},NOW));
  assert.equal(incidentClosureDecision(incident,remote(),NOW).status,'active');
  const previouslyDeferred={...incident,is_deferred:true,deferred_until:'2026-11-02T10:00:00Z',itsm_deadline_at:'2026-11-02T20:00:00Z'};
  assert.equal(incidentClosureDecision(previouslyDeferred,{...remote(),status:'completed',completed_at:'2026-11-02T19:00:00Z'},NOW).status,'completed');
  assert.equal(incidentClosureDecision({...incident,itsm_deadline_at:'2026-10-29T14:00:00Z'},{...remote(),status:'completed',resolution_target_at:'2026-10-29T16:00:00Z',completed_at:'2026-10-29T15:00:00Z'},NOW).status,'completed');
  assert.equal(incidentClosureDecision(incident,{...remote(),status:'completed',completed_at:'2026-10-29T14:00:00Z'},NOW).status,'completed');
});
test('automatic due checks archive real misses, honor extension and do not burn on provider failure', async () => {
  const incident=await create(); source={...remote(),status:'in_progress',waiting_until:null,resolution_target_at:'2026-10-29T14:59:00Z'};
  await pool.query('UPDATE incidents SET next_check_at=$1 WHERE id=$2',[NOW.toISOString(),incident.id]);
  await runIncidentMonitor({pool,itsm,now:NOW}); const burned=await row(incident.id);
  assert.equal(burned.status,'burned'); assert.equal(burned.closure_source,'itsm'); assert.equal(burned.comment,input.comment);
  await runIncidentMonitor({pool,itsm,now:new Date(+NOW+600000)}); assert.equal(recordCalls,1);
  const extended=await create({number:'27787458'}); source=remote();
  await pool.query('UPDATE incidents SET next_check_at=$1 WHERE id=$2',[NOW.toISOString(),extended.id]);
  await runIncidentMonitor({pool,itsm,now:NOW}); assert.equal((await row(extended.id)).status,'active'); assert.equal(new Date((await row(extended.id)).itsm_deadline_at).toISOString(),'2026-11-02T13:21:00.000Z');
  await runIncidentMonitor({pool,itsm,now:new Date(+NOW+600000)}); assert.equal(recordCalls,2);
  recordHook=async()=>{throw new Error('fixture failure');};
  await runIncidentMonitor({pool,itsm,now:new Date('2026-11-02T13:22:00Z')}); const failed=await row(extended.id); assert.equal(failed.status,'active'); assert.ok(failed.check_error); assert.equal(failed.closed_at,null);
});
test('a manual closure during an automatic request wins the race', async () => {
  const incident=await create(); source={...remote(),status:'in_progress',waiting_until:null,resolution_target_at:'2026-10-29T14:59:00Z'};
  recordHook=async()=>{recordHook=null; assert.equal((await call(`/incidents/${incident.id}/close`,'POST',{status:'completed',version:1})).status,200);};
  await pool.query('UPDATE incidents SET next_check_at=$1 WHERE id=$2',[NOW.toISOString(),incident.id]);
  await runIncidentMonitor({pool,itsm,now:NOW}); const result=await row(incident.id); assert.equal(result.status,'completed'); assert.equal(result.closure_source,'manual'); assert.equal(result.version,2);
});
test('not-yet-due incidents, including deferred ones, are not polled early', async () => {
  const incident=await create({is_deferred:true,deferred_until:'2026-11-02T12:00:00Z'});
  await pool.query('UPDATE incidents SET next_check_at=$1 WHERE id=$2',[NOW.toISOString(),incident.id]);
  await runIncidentMonitor({pool,itsm,now:NOW}); assert.equal(recordCalls,0);
});

test('automatic closure stores timely completion and the deadline used for comparison', async () => {
  const incident=await create(); source={...remote(),status:'completed',waiting_until:null,completed_at:'2026-10-29T14:00:00Z'};
  await pool.query('UPDATE incidents SET next_check_at=$1 WHERE id=$2',[NOW.toISOString(),incident.id]);
  await runIncidentMonitor({pool,itsm,now:NOW}); const archived=await row(incident.id);
  assert.equal(archived.status,'completed'); assert.equal(archived.closure_source,'itsm');
  assert.equal(new Date(archived.closure_deadline_at).toISOString(),'2026-10-29T14:00:00.000Z');
  assert.equal(new Date(archived.itsm_completed_at).toISOString(),'2026-10-29T14:00:00.000Z'); assert.equal(archived.next_check_at,null);
});
