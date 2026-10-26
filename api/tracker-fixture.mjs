// Local-only synthetic UI harness. Not included in the Docker image.
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import {transaction,writeTask,getTask,applyExternal} from './tracker-store.js';
import {externalEvent} from './tracker-domain.js';
import {saveJiraSnapshot} from './tracker-jira.js';
import {saveAzSnapshot,saveAnalysisMail} from './tracker-analysis.js';
import {validateDocument,insertDocument,validateApprovedDocument,replaceApprovedDocument} from './tracker-documents.js';
import {registerTrackerRoutes,handler} from './tracker-routes.js';
import {setupSwagger} from './swagger.js';
const db=new PGlite();
const source=await fs.readFile(new URL('./tracker.test.js',import.meta.url),'utf8');
const sql=source.match(/await db.exec\(`([\s\S]*?)`\);/)[1];
await db.exec(sql);await db.exec(await fs.readFile(new URL('../migrations/20261026_tracker_v2.sql',import.meta.url),'utf8'));
await db.exec(await fs.readFile(new URL('../migrations/20261027_analysis_cycles.sql',import.meta.url),'utf8'));
const query=async(sql,params)=>{const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length}};
const pool={query,connect:async()=>({query,release(){}})};
const user={id:'1',name:'Тестовый руководитель',login:'test',is_superadmin:true,token:'local-fixture-only'};
const names=['Согласовать описание интеграции с заказчиком','Добавить проверку данных перед выгрузкой отчёта','Разобрать замечания к техническому заданию по обмену данными','Проверить отображение длинных названий на телефоне','Выгрузить сводный перечень задач','Уточнить объём работ по следующему этапу','Сопровождение интеграции и ежемесячная сверка данных с заказчиком'];
const statuses=['на согласовании','разработка','в аналитике','ревью','завершена','оценка','готова к разработке'];
for(let i=0;i<21;i++)await transaction(pool,c=>writeTask(c,String(10001+i),{title:names[i%7],status:statuses[i%7],priority:i%3===0?'high':'medium',assignee_user_id:i%4===2?null:'1',start_at:`2026-10-${String(19+i%9).padStart(2,'0')}`,due_at:`2026-${i%3===0?'11':'10'}-${i%3===0?'06':'29'}`,approved_hours:i%3===0?null:(i+1)*8,spent_hours:i%2===0?null:8,tags:i%2?['API']:[]},user,{creating:true}));
await pool.query("UPDATE task_events SET occurred_at='2026-04-15T09:00:00Z' WHERE task_id=10005 AND type='task.created'");
await pool.query("UPDATE task_events SET occurred_at='2025-12-31T20:00:00Z' WHERE task_id=10012 AND type='task.created'");
await pool.query("UPDATE task_events SET occurred_at=NULL WHERE task_id=10019 AND type='task.created'");
await pool.query("UPDATE tasks SET start_at=NULL,due_at=NULL WHERE id=10003");
await pool.query("UPDATE tasks SET due_at='2027-01-20' WHERE id=10002");
await pool.query("UPDATE tasks SET link_url='https://jira.example.invalid/browse/ECHD-43' WHERE id=10002");
await saveJiraSnapshot(pool,'10001',{issue_id:'synthetic-42',issue_key:'ECHD-42',url:'https://jira.example.invalid/browse/ECHD-42',status:'В работе',assignee:'Иван Петров',checked_at:'2026-10-26T18:00:00Z',history_complete:false,history:[{id:'synthetic-history-1',occurred_at:'2026-10-25T09:00:00Z',actor_name:'Иван Петров',changes:{status:{old:'Готова к разработке',new:'В работе'}}}]},'jira-agent');
const doc=validateDocument({kind:'az',title:'Описание интеграции',version:'1.3',source_url:'https://example.invalid/docs/v1.3'});
await applyExternal(pool,'10001',externalEvent({external_id:'synthetic-doc-13',type:'document.received',summary:'Маша прислала новую АЗ v1.3',actor_name:'Аналитик Маша',occurred_at:'2026-10-26T08:00:00Z'},'mail-agent','mail-agent'),null,{doc},(c,r)=>insertDocument(c,'10001',r.event.id,doc));
await transaction(pool,c=>writeTask(c,'10001',{reply_due_at:'2026-10-25T15:00:00Z',waiting_for:'ДИТ',next_action_text:'Уточнить срок ответа по АЗ'},user));
for (const [id,title,at] of [['synthetic-approved-1','Предыдущий согласованный','2026-10-24T10:00:00Z'],['synthetic-approved-2','Последний согласованный документ','2026-10-25T10:00:00Z']]) {
  const approved=validateApprovedDocument({title,approved_at:at,file_name:'approved.txt',file_base64:Buffer.from(title).toString('base64')});
  await applyExternal(pool,'10001',externalEvent({external_id:id,type:'document.approved',summary:title,occurred_at:at},'mail-agent','mail-agent'),null,{approved},(c,r)=>replaceApprovedDocument(c,'10001',r.event.id,approved));
}
await saveAzSnapshot(pool,'10001',{issue_type:'az',issue_id:'synthetic-az-142',issue_key:'ECHD-142',url:'https://jira.example.invalid/browse/ECHD-142',epic_key:'ECHD-42',epic_url:'https://jira.example.invalid/browse/ECHD-42',issue_created_at:'2026-10-19T10:00:00+03:00',checked_at:'2026-10-26T18:00:00+03:00',status:'На согласовании в ДИТ',assignee:'Маша',history_complete:true,status_map:{'Открыта':'other','В работе':'analysis','Ревью':'review','На согласовании в ДИТ':'approval'},history:[
  ['1','20T11:00','Открыта','В работе'],['2','21T17:00','В работе','Ревью'],['3','22T16:00','Ревью','На согласовании в ДИТ'],['4','26T11:00','На согласовании в ДИТ','В работе'],['5','26T13:00','В работе','Ревью'],['6','26T15:00','Ревью','На согласовании в ДИТ']
].map(([id,t,old_status,new_status])=>({id,occurred_at:`2026-10-${t}:00+03:00`,old_status,new_status,actor_name:'Маша'}))});
for(const [id,cycle_id,type,t] of [
  ['c1','first','comments_received','19T14:00'],['s1','first','document_sent','22T15:00'],['c2','second','comments_received','23T18:00'],['s2','second','document_sent','26T14:00'],['a2','second','approval_received','26T17:00']
]) await saveAnalysisMail(pool,'10001',{event:{external_id:`synthetic-mail-${id}`,cycle_id,type,occurred_at:`2026-10-${t}:00+03:00`,source_url:`https://mail.example.invalid/${id}`,actor_name:type==='document_sent'?'Маша':'ДИТ',...(type==='approval_received'?{final:true}:{})}});
if (process.env.FIXTURE_LARGE === '1') {
  for(let i=21;i<77;i++) await transaction(pool,c=>writeTask(c,String(10001+i),{title:`Проверка производительности ${i}`,status:statuses[i%7],start_at:`${2025+i%4}-01-05`,due_at:`${2025+i%4}-12-20`,approved_hours:80},user,{creating:true}));
}
const app=express();app.use(cors({origin:'http://localhost:3015',credentials:true}));app.use(express.json({limit:'15mb'}));
const auth=(req,res,next)=>{if(req.get('authorization')!=='Bearer local-fixture-only')return res.status(401).json({error:'test session required'});req.user=user;next()};
app.post('/auth/login-password',(req,res)=>res.json(user));app.post('/auth/logout',auth,(req,res)=>res.json({ok:true}));
app.get('/users',auth,(req,res)=>res.json([user]));app.get('/tags',auth,handler(async(req,res)=>res.json((await pool.query('SELECT * FROM tags')).rows)));
app.get('/tasks',auth,handler(async(req,res)=>{const result=[];for(const t of (await pool.query('SELECT id FROM tasks ORDER BY id')).rows)result.push(await getTask(pool,t.id));res.json(result)}));
app.post('/tasks',auth,handler(async(req,res)=>res.status(201).json((await transaction(pool,c=>writeTask(c,req.body.id,req.body,user,{creating:true}))).task)));
app.patch('/tasks/:id',auth,handler(async(req,res)=>{
  if(req.body.title==='TEST_SAVE_ERROR')return res.status(500).json({error:'Тестовая ошибка сохранения'});
  if(req.body.title==='TEST_EXPIRED_SESSION')return res.status(401).json({error:'Тест: сессия истекла'});
  const task=(await transaction(pool,c=>writeTask(c,req.params.id,req.body,user))).task;
  if(req.body.title==='TEST_UNCERTAIN_SAVED')return res.status(500).json({error:'Тест: ответ потерян после commit'});
  res.json(task);
}));
registerTrackerRoutes(app,{pool,requireUser:auth,requireEditor:auth,env:{AGENT_API_TOKEN:'local-agent-only',JIRA_INGEST_TOKEN:'local-jira-only'},startJobs:false});
setupSwagger(app);
app.listen(3891,'127.0.0.1',()=>console.log('Synthetic fixture API on 127.0.0.1:3891'));
