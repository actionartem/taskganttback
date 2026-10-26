import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ExcelJS from 'exceljs';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import {transaction,writeTask,getTask,readEvents,applyExternal,setTaskTag} from './tracker-store.js';
import {normalizePatch,normalizeStatus,externalEvent,stageDurations,attentionReasons} from './tracker-domain.js';
import {validateDocument,insertDocument} from './tracker-documents.js';
import {saveJiraSnapshot} from './tracker-jira.js';
import {registerTrackerRoutes} from './tracker-routes.js';
import {sessionCodec,sessionMatchesUser} from './tracker-session.js';
import {setupSwagger} from './swagger.js';
let db,pool,server,base;
before(async()=>{
  db=new PGlite();await db.exec(`CREATE TABLE users(id BIGSERIAL PRIMARY KEY,name text,role_text text,is_active boolean DEFAULT true);
    CREATE TABLE tasks(id BIGSERIAL PRIMARY KEY,title text NOT NULL,description text,email_thread text,document_history text,status text DEFAULT 'не в работе',priority text DEFAULT 'low',assignee_user_id bigint REFERENCES users(id),start_at timestamptz,due_at timestamptz,link_url text,approved_hours numeric,spent_hours numeric,created_by bigint,updated_by bigint,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE tags(id BIGSERIAL PRIMARY KEY,title text UNIQUE,color text);
    CREATE TABLE task_tags(task_id bigint REFERENCES tasks(id) ON DELETE CASCADE,tag_id bigint REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(task_id,tag_id));
    CREATE TABLE task_change_log(id BIGSERIAL PRIMARY KEY,task_id bigint REFERENCES tasks(id) ON DELETE CASCADE,field_name text,old_value text,new_value text,changed_at timestamptz DEFAULT now());
    INSERT INTO users(name) VALUES('Тест'); INSERT INTO tags(title,color) VALUES('API','#123456');`);
  const sql=await fs.readFile(new URL('../migrations/20261026_tracker_v2.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql); // additive, rerunnable migration
  const query=async(sql,params)=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows ?? r.rows.length};};
  pool={query,connect:async()=>({query,release(){}})};
  const app=express();app.use(express.json({limit:'15mb'}));
  const user=(req,res,next)=>{if(req.get('authorization')!=='Bearer test-user')return res.status(401).end();req.user={id:'1',name:'Тест'};next();};
  registerTrackerRoutes(app,{pool,requireUser:user,requireEditor:user,env:{AGENT_API_TOKEN:'test-agent',JIRA_INGEST_TOKEN:'test-jira'},startJobs:false});
  setupSwagger(app);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await db?.close();});
const event=(id,type='note')=>externalEvent({external_id:id,type,summary:'ДИТ согласовал документ',actor_name:'ДИТ',source_url:'https://example.test/mail/1'},'mail-agent','mail-agent');
test('task, tags, legacy journal and event commit together; failed history rolls everything back',async()=>{
  await transaction(pool,c=>writeTask(c,'10001',{title:'Исходная',status:'разработка',tags:['API']},{id:'1',name:'Тест'},{creating:true}));
  assert.equal((await getTask(pool,'10001')).tags[0].title,'API');
  const count=(await readEvents(pool,'10001')).length;
  await assert.rejects(transaction(pool,async c=>{
    await writeTask(c,'10001',{title:'Не должно сохраниться',tags:[]},{id:'1',name:'Тест'});
    await c.query("INSERT INTO task_events(task_id,source,type,summary,recorder) VALUES(99999,'test','note','bad','test')");
  }));
  assert.equal((await getTask(pool,'10001')).title,'Исходная');
  assert.equal((await getTask(pool,'10001')).tags.length,1);
  assert.equal((await readEvents(pool,'10001')).length,count);
});
test('external idempotency, conflicting retry and explicit changes only',async()=>{
  const original=await applyExternal(pool,'10001',event('mail-1'),null);
  const duplicate=await applyExternal(pool,'10001',event('mail-1'),null);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.event.id,original.event.id);
  assert.equal((await getTask(pool,'10001')).status,'разработка');
  await assert.rejects(applyExternal(pool,'10001',{...event('mail-1'),summary:'Другое'},null),e=>e.status===409);
  const changed=await applyExternal(pool,'10001',event('mail-2','task.updated'),{status:'на согласовании'});
  assert.equal(changed.task.status,'на согласовании');assert.equal(changed.event.changes.status.old,'разработка');
  assert.equal(changed.event.occurred_at,null);assert.ok(changed.event.received_at);
});
test('reject invalid enum, dates, hours, missing relations and bad IDs',async()=>{
  for(const patch of [{status:'other'},{priority:'urgent'},{start_at:'2026-02-30'},{start_at:'2026-11-01',due_at:'2026-10-01'},{spent_hours:-1},{spent_hours:true},{deadline_confirmed:true}]) assert.throws(()=>normalizePatch(patch));
  for(const patch of [{assignee_user_id:999},{tags:['missing']}]) await assert.rejects(transaction(pool,c=>writeTask(c,'10001',patch,{id:'1'})),e=>e.status===400);
});
test('document bytes and event are atomic; latest received does not inherit current/approval',async()=>{
  const doc=validateDocument({kind:'az',title:'АЗ',version:'1.3',file_name:'аз.pdf',file_base64:Buffer.from('%PDF-1.7\ntest').toString('base64')});
  const result=await applyExternal(pool,'10001',event('doc-1','document.received'),null,{sha256:doc.sha256},(c,r)=>insertDocument(c,'10001',r.event.id,doc).then(document=>({document})));
  assert.equal(result.document.is_current,false);assert.equal(result.document.approved_at,null);
  const response=await fetch(`${base}/tasks/10001/documents/${result.document.id}/download`,{headers:{Authorization:'Bearer test-user'}});
  assert.equal(response.status,200);assert.match(await response.text(),/^%PDF/);
  assert.equal((await fetch(`${base}/tasks/10001/documents/${result.document.id}/download`)).status,401);
  assert.equal((await fetch(`${base}/tasks/10002/documents/${result.document.id}/download`,{headers:{Authorization:'Bearer test-user'}})).status,404);
  assert.throws(()=>validateDocument({kind:'az',title:'АЗ',version:'1',file_name:'../x.pdf',file_base64:'dGVzdA=='}));
});
test('Jira snapshots preserve local fields; history repeat is deduplicated; old snapshots never revert current state',async()=>{
  const snapshot={issue_id:'42',issue_key:'ECHD-42',url:'https://jira.example.test/browse/ECHD-42',status:'In progress',assignee:null,checked_at:'2026-10-25T10:00:00Z',history_complete:false};
  await saveJiraSnapshot(pool,'10001',snapshot,'jira-agent');
  await saveJiraSnapshot(pool,'10001',{...snapshot,status:'Review',checked_at:'2026-10-26T10:00:00Z'},'jira-agent');
  await saveJiraSnapshot(pool,'10001',snapshot,'jira-agent');
  assert.equal((await pool.query('SELECT status FROM task_jira WHERE task_id=10001')).rows[0].status,'Review');
  assert.equal((await getTask(pool,'10001')).status,'на согласовании');
  const observed=(await readEvents(pool,'10001')).filter(e=>e.type==='jira.observed');assert.equal(observed.length,1);assert.equal(observed[0].occurred_at,null);
  const withHistory={...snapshot,checked_at:'2026-10-26T11:00:00Z',status:'Review',history:[{id:'h1',occurred_at:'2026-10-25T12:00:00Z',changes:{status:{old:'In progress',new:'Review'},assignee:{old:null,new:'Иван'}}}]};
  await saveJiraSnapshot(pool,'10001',withHistory,'jira-agent');await saveJiraSnapshot(pool,'10001',withHistory,'jira-agent');
  assert.equal((await readEvents(pool,'10001')).filter(e=>e.type==='jira.changed').length,1);
});
test('year in queue + five days in development; returning to queue preserves first start',()=>{
  const events=[{id:'1',source:'simpletracker',type:'task.created',occurred_at:'2025-10-21T00:00:00Z',changes:{status:{old:null,new:'готова к разработке'}}},
    {id:'2',source:'simpletracker',type:'task.updated',occurred_at:'2026-10-21T00:00:00Z',changes:{status:{old:'готова к разработке',new:'разработка'}}}];
  const metrics=stageDurations({status:'разработка'},events,new Date('2026-10-26T00:00:00Z'));
  assert.equal(metrics.totals.queue/86400000,365);assert.equal(metrics.totals.active/86400000,5);assert.equal(metrics.complete,true);
  events.push({id:'3',source:'simpletracker',type:'task.updated',occurred_at:'2026-10-26T00:00:00Z',changes:{status:{old:'разработка',new:'готова к разработке'}}});
  assert.equal(stageDurations({status:'готова к разработке'},events,new Date('2026-10-27T00:00:00Z')).firstActive,'2026-10-21T00:00:00.000Z');
});
test('attention requires explicit promise; unknown history and old queue do not fabricate overdue work',()=>{
  const now=new Date('2026-10-26T12:00:00Z'),m={currentSince:null};
  assert.deepEqual(attentionReasons({status:'готова к разработке',due_at:'2025-01-01'},m,{},now),[]);
  assert.equal(attentionReasons({status:'разработка',assignee_user_id:1},m,{'разработка':3},now).length,0);
  assert.equal(attentionReasons({status:'разработка',deadline_confirmed:true,due_at:'2026-10-26',assignee_user_id:1},m,{},now).length,0);
  assert.equal(attentionReasons({status:'разработка',deadline_confirmed:true,due_at:'2026-10-25',assignee_user_id:1},m,{},now)[0].code,'deadline');
});
test('HTTP integration permissions and actor provenance',async()=>{
  assert.equal((await fetch(`${base}/integrations/agent/tasks`)).status,401);
  assert.equal((await fetch(`${base}/integrations/agent/tasks`,{headers:{'x-integration-token':'test-jira'}})).status,401);
  const r=await fetch(`${base}/integrations/agent/tasks/10001/events`,{method:'POST',headers:{'Content-Type':'application/json','x-integration-token':'test-agent'},body:JSON.stringify({event:{external_id:'http-1',type:'note',summary:'Маша отправила документ',actor_name:'Маша',source:'jira',recorder:'admin'}})});
  assert.equal(r.status,201);const result=await r.json();assert.equal(result.event.source,'mail-agent');assert.equal(result.event.recorder,'mail-agent');assert.equal(result.event.actor_name,'Маша');
});
test('logout/password generation revokes every old token, new login works; tampering and expiry fail',async()=>{
  let now=100000;const codec=sessionCodec('test-only-signing-material-32-characters',60,()=>now);
  const user={id:'1',session_generation:0},oldA=codec.create(user),oldB=codec.create(user);
  assert.equal(sessionMatchesUser(codec.verify(oldA),user),true);
  await pool.query('UPDATE users SET session_generation=session_generation+1 WHERE id=1');
  const next=(await pool.query('SELECT id,session_generation FROM users WHERE id=1')).rows[0];
  assert.equal(sessionMatchesUser(codec.verify(oldA),next),false);assert.equal(sessionMatchesUser(codec.verify(oldB),next),false);
  const newToken=codec.create(next);assert.equal(sessionMatchesUser(codec.verify(newToken),next),true);
  assert.equal(codec.verify(newToken+'x'),null);now+=60000;assert.equal(codec.verify(newToken),null);
  assert.throws(()=>codec.create({id:'1'}));
});

test('explicit pauses are counted separately, completed work closes pause and unknown transition invalidates interval',()=>{
  const events=[{id:'1',source:'simpletracker',type:'task.created',occurred_at:'2026-10-01T00:00:00Z',changes:{status:{old:null,new:'разработка'}}},
    {id:'2',source:'mail-agent',type:'task.paused',occurred_at:'2026-10-03T00:00:00Z'},
    {id:'3',source:'mail-agent',type:'task.resumed',occurred_at:'2026-10-08T00:00:00Z'}];
  const m=stageDurations({status:'разработка'},events,new Date('2026-10-10T00:00:00Z'));
  assert.equal(m.totals.active/86400000,4);assert.equal(m.totals.paused/86400000,5);assert.equal(m.paused,false);
  const during=stageDurations({status:'разработка'},events.slice(0,2),new Date('2026-10-06T00:00:00Z'));
  assert.equal(during.paused,true);assert.equal(attentionReasons({status:'разработка'},during,{'разработка':1},new Date('2026-10-06T00:00:00Z')).length,0);
  const unknown=stageDurations({status:'разработка'},[...events,{id:'4',source:'mail-agent',occurred_at:null,received_at:'2026-10-09T00:00:00Z',changes:{status:{old:'на согласовании',new:'разработка'}}}],new Date('2026-10-10T00:00:00Z'));
  assert.equal(unknown.complete,false);assert.equal(unknown.currentSince,null);assert.equal(unknown.totals.active,0);
  assert.throws(()=>externalEvent({external_id:'pause',type:'task.paused',summary:'Причина'},'mail-agent','mail-agent'));
});

test('compatibility tag endpoints use the same atomic journal; untouched fields survive a narrow patch',async()=>{
  await transaction(pool,c=>writeTask(c,'10001',{description:'Обновлено агентом'},{id:'1'}));
  await transaction(pool,c=>writeTask(c,'10001',{title:'Ручное название'},{id:'1'}));
  assert.equal((await getTask(pool,'10001')).description,'Обновлено агентом');
  await transaction(pool,c=>setTaskTag(c,'10001','1',false,{id:'1',name:'Тест'}));
  assert.equal((await getTask(pool,'10001')).tags.length,0);
  assert.deepEqual((await readEvents(pool,'10001')).find(e=>e.changes.tags?.new.length===0).changes.tags.old,['API']);
});

test('HTTP document retries deduplicate; approval belongs only to its version and source metadata is recorded',async()=>{
  const post=async(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-integration-token':'test-agent'},body:JSON.stringify(body)});
  const payload={event:{external_id:'http-doc',type:'document.received',summary:'Маша передала АЗ v1'},document:{kind:'az',title:'АЗ',version:'1',source_url:'https://example.test/v1'}};
  const first=await (await post('/integrations/agent/tasks/10001/documents',payload)).json();
  const second=await (await post('/integrations/agent/tasks/10001/documents',payload)).json();
  assert.equal(first.document.id,second.document.id);assert.equal(second.duplicate,true);
  const approved=await post(`/integrations/agent/tasks/10001/documents/${first.document.id}/state`,{event:{external_id:'http-approval',type:'document.approved',summary:'ДИТ согласовал v1'},state:{approved_at:'2026-10-25T12:00:00Z',approval_evidence:'Письмо от ДИТ',is_current:true}});
  assert.equal(approved.status,200);assert.ok((await approved.json()).event.changes.approved_at);
  const newer=await (await post('/integrations/agent/tasks/10001/documents',{...payload,event:{...payload.event,external_id:'http-doc2'},document:{...payload.document,version:'2'}})).json();
  assert.equal(newer.document.approved_at,null);assert.equal(newer.document.is_current,false);
  assert.equal((await post(`/integrations/agent/tasks/10001/documents/${first.document.id}/state`,{event:{external_id:'bad-state',type:'note',summary:'x'},state:{is_current:true}})).status,400);
  assert.equal((await post('/integrations/agent/tasks/10001/events',{event:{external_id:'implicit',type:'note',summary:'x'},changes:{status:'завершена'}})).status,400);
});

test('conflicting Jira snapshot timestamp is rejected without losing current state',async()=>{
  const old=(await pool.query('SELECT * FROM task_jira WHERE task_id=10001')).rows[0];
  await assert.rejects(saveJiraSnapshot(pool,'10001',{...old,checked_at:new Date(old.checked_at).toISOString(),status:'unexpected'},'jira-agent'),e=>e.status===409);
  assert.equal((await pool.query('SELECT status FROM task_jira WHERE task_id=10001')).rows[0].status,'Review');
});

test('existing Excel export still filters, writes and reads a workbook using the current runtime dependencies',async()=>{
  const source=await fs.readFile(new URL('./app.js',import.meta.url),'utf8');
  // Execute the actual unchanged export implementation, with only isolated DB/filesystem dependencies.
  const helpers=source.slice(source.indexOf('const TASK_EXPORT_STATUSES'),source.indexOf('function safeEqual('));
  const jobs=source.slice(source.indexOf('async function fetchTasksForExport('),source.indexOf('// ================== Swagger'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'simpletracker-export-test-'));
  const job={id:'export-regression',statuses:['на согласовании'],fields:['id','title','status','approved_hours','tags'],progress:0};
  const context={pool,fs,path,ExcelJS,console,TASK_EXPORT_DIR:directory,taskExportJobs:new Map([[job.id,job]]),normalizeStatus,statusFilterValues:s=>[s],toNullableNumber:v=>v==null?null:Number(v)};
  vm.runInNewContext(helpers+jobs+'; this.exportJob=runTaskExportJob;',context);
  await context.exportJob(job.id);assert.equal(job.status,'done');assert.equal(job.progress,100);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(job.filePath);
  const sheet=workbook.getWorksheet('Задачи');assert.equal(sheet.getCell('A2').value,10001);assert.equal(sheet.getCell('C2').value,'на согласовании');assert.equal(sheet.getCell('D2').value,null);
  await fs.unlink(job.filePath);await fs.rmdir(directory);
});

test('agent guide and OpenAPI are discoverable; catalogs exclude credentials',async()=>{
  const guide=await fetch(base+'/integrations/guide');assert.equal(guide.status,200);assert.match(await guide.text(),/JIRA_INGEST_TOKEN/);
  const spec=await (await fetch(base+'/openapi.json')).json();assert.equal(spec.info.version,'2.0.0');assert.ok(spec.paths['/integrations/jira/tasks/{id}/snapshot'].post);
  assert.equal((await fetch(base+'/integrations/agent/options')).status,401);
  const options=await (await fetch(base+'/integrations/agent/options',{headers:{'x-integration-token':'test-agent'}})).json();
  assert.deepEqual(Object.keys(options.users[0]).sort(),['id','name']);assert.ok(options.statuses.includes('разработка'));
});

test('deleting a task cascades its events, corrections, versions and personal signals',async()=>{
  await transaction(pool,c=>writeTask(c,'99999',{title:'Disposable task',tags:['API']},{id:'1'},{creating:true}));
  const original=await applyExternal(pool,'99999',event('delete-original'),null);
  await applyExternal(pool,'99999',externalEvent({external_id:'delete-correction',type:'event.corrected',summary:'Уточнение',corrects_event_id:original.event.id},'mail-agent','mail-agent'),null);
  const doc=validateDocument({kind:'other',title:'Тест',version:'1',source_url:'https://example.test/file'});
  await applyExternal(pool,'99999',event('delete-doc','document.received'),null,{doc},(c,r)=>insertDocument(c,'99999',r.event.id,doc));
  await pool.query("INSERT INTO attention_snoozes(user_id,task_id,reason_key,until_at) VALUES(1,99999,'reply',now()+interval '1 day')");
  await pool.query('DELETE FROM tasks WHERE id=99999');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_events WHERE task_id=99999')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_documents WHERE task_id=99999')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM attention_snoozes WHERE task_id=99999')).rows[0].n,0);
});
