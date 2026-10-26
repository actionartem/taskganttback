import { fail, text, date, url, positiveId, fingerprint, requireAutomation, automationBlock, normalizeStatus } from './tracker-domain.js';
import { transaction, getTask, insertEvent, readEvents } from './tracker-store.js';
import { validateApprovedDocument, replaceApprovedDocument } from './tracker-documents.js';
import { analysisMetrics } from './tracker-analysis-metrics.js';

const phases=['analysis','review','approval','other'];
const types=['comments_received','document_sent','approval_received'];
function past(value,label) {
  if(typeof value!=='string' || !value.includes('T'))fail(`${label}: нужна точная дата со временем и часовым поясом`);
  const result=date(value);
  if(!result || new Date(result)>new Date())fail(`${label}: нужно фактическое время, не в будущем`);
  return result;
}
async function existing(c,source,id,hash) {
  const row=(await c.query('SELECT * FROM task_analysis_events WHERE source=$1 AND external_id=$2',[source,id])).rows[0];
  if(row && row.fingerprint!==hash)fail('Этот ID события АЗ уже содержит другие данные',409);
  return row;
}
async function insertFact(c,taskId,source,id,hash,fact) {
  return (await c.query(`INSERT INTO task_analysis_events(task_id,source,external_id,fingerprint,type,cycle_id,occurred_at,actor_name,source_url,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[taskId,source,id,hash,fact.type,fact.cycle_id||null,fact.occurred_at,fact.actor_name||null,fact.source_url,JSON.stringify(fact.payload||{})])).rows[0];
}
export async function saveAnalysisMail(pool,taskId,body) {
  const e=body?.event;
  if(!e || !types.includes(e.type))fail('Тип события АЗ: comments_received, document_sent, approval_received');
  const id=text(e.external_id,500), cycle=text(e.cycle_id,300), source=url(e.source_url);
  if(!id||!cycle||!source)fail('Нужны external_id, cycle_id и ссылка на письмо');
  const event={type:e.type,cycle_id:cycle,occurred_at:past(e.occurred_at,'occurred_at'),source_url:source,actor_name:text(e.actor_name,500),payload:{}};
  if(e.type==='approval_received' && e.final!==true)fail('Финальное согласование АЗ требует final:true');
  if(body.document && e.type!=='approval_received')fail('Файл передаётся только вместе с финальным согласованием');
  const document=body.document ? validateApprovedDocument(body.document) : null;
  if(document && new Date(document.approved_at).getTime()!==new Date(event.occurred_at).getTime())fail('Дата согласования документа должна совпадать с событием');
  const hash=fingerprint({task_id:String(taskId),event,document});
  return transaction(pool,async c=>{
    const task=await getTask(c,taskId,true);
    const duplicate=await existing(c,'mail',id,hash);
    if(duplicate)return {event:duplicate,duplicate:true,automation_locked:task.automation_locked};
    requireAutomation(task);
    // One milestone per round: extra comments belong to the same initial comments event.
    if((await c.query('SELECT id FROM task_analysis_events WHERE task_id=$1 AND cycle_id=$2 AND type=$3 AND source=\'mail\'',[taskId,cycle,e.type])).rows.length)fail('Этот этап цикла уже записан. Сверьте ID письма и cycle_id',409);
    const facts=(await c.query("SELECT * FROM task_analysis_events WHERE task_id=$1 AND cycle_id=$2 AND source='mail'",[taskId,cycle])).rows;
    const before=facts.find(f=>f.type==='comments_received'), sent=facts.find(f=>f.type==='document_sent'), approved=facts.find(f=>f.type==='approval_received');
    const at=new Date(event.occurred_at).getTime();
    if((e.type==='document_sent' && before && at<new Date(before.occurred_at)) ||
       (e.type==='comments_received' && sent && at>new Date(sent.occurred_at)) ||
       (e.type==='approval_received' && ((sent && at<new Date(sent.occurred_at)) || (before && at<new Date(before.occurred_at)))) ||
       (approved && at>new Date(approved.occurred_at)))fail('Нарушен порядок событий цикла',409);
    const result=await insertFact(c,taskId,'mail',id,hash,event);
    let savedDocument=null;
    if(e.type==='approval_received') {
      const audit=await insertEvent(c,taskId,{source:'mail-agent',external_id:`analysis:${id}`,type:'task.updated',summary:'АЗ окончательно согласована; дальнейшие изменения вручную',occurred_at:event.occurred_at,actor_name:event.actor_name,source_url:source,recorder:'mail-agent'},
        {automation_locked:{old:!!task.automation_locked,new:true}});
      if(document)savedDocument=await replaceApprovedDocument(c,taskId,audit.id,document);
      await c.query('UPDATE tasks SET automation_locked=true,automation_locked_at=$2,next_action_text=NULL,next_action_at=NULL,reply_due_at=NULL,waiting_for=NULL,updated_at=now() WHERE id=$1',[taskId,event.occurred_at]);
    }
    return {event:result,document:savedDocument,duplicate:false,automation_locked:e.type==='approval_received'};
  });
}

export async function saveAzSnapshot(pool,taskId,body) {
  if(body?.issue_type!=='az')fail('Нужна дочерняя задача АЗ: issue_type=az');
  const issueId=text(body.issue_id,100), key=text(body.issue_key,100), epic=text(body.epic_key,100);
  const link=url(body.url), epicUrl=url(body.epic_url), checked=past(body.checked_at,'checked_at'), created=past(body.issue_created_at,'issue_created_at');
  const status=text(body.status,500), assignee=text(body.assignee,500), map=body.status_map;
  if(!issueId || !key || !epic || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(epic) || key===epic || !link || !epicUrl || !status || !Object.hasOwn(body,'assignee'))fail('Нужны ID, ключ и ссылка АЗ, отдельный эпик, статус и assignee');
  if(new Date(created)>new Date(checked))fail('Дата создания АЗ позже проверки');
  if(!map || typeof map!=='object' || Array.isArray(map) || Object.values(map).some(v=>!phases.includes(v)) || !Object.hasOwn(map,status))fail('status_map должен явно сопоставлять статусы с analysis/review/approval/other');
  if(!Array.isArray(body.history)||body.history.length>1000)fail('Нужен массив history, не более 1000 записей');
  const history=body.history.map(h=>{
    const id=text(h.id,200), at=past(h.occurred_at,'history.occurred_at'), old=text(h.old_status,500), next=text(h.new_status,500);
    if(!id||!old||!next||!Object.hasOwn(map,old)||!Object.hasOwn(map,next))fail('История: id, old_status, new_status и явное сопоставление каждого статуса обязательны');
    if(new Date(at)<new Date(created)||new Date(at)>new Date(checked))fail('История вне диапазона создания/проверки АЗ');
    return {id,fact:{type:'jira_status_changed',occurred_at:at,actor_name:text(h.actor_name,500),source_url:link,
      payload:{issue_id:issueId,old_status:old,new_status:next,old_phase:map[old],new_phase:map[next]}}};
  });
  return transaction(pool,async c=>{
    requireAutomation(await getTask(c,taskId,true));
    const old=(await c.query('SELECT * FROM task_az WHERE task_id=$1',[taskId])).rows[0];
    if(old?.issue_id && old.issue_id!==issueId)fail('Уже привязана другая АЗ; автоматическая подмена запрещена',409);
    if(old && new Date(old.issue_created_at).getTime()!==new Date(created).getTime())fail('Дата создания привязанной АЗ не совпадает',409);
    if(old && Object.entries(old.status_map).some(([key,value])=>map[key]!==value))fail('Сопоставление статусов изменилось; нужна проверка сохранённой истории АЗ',409);
    if(old && new Date(old.checked_at).getTime()===new Date(checked).getTime() && [old.status!==status,old.assignee!==assignee,old.issue_key!==key,old.url!==link,old.epic_key!==epic,old.epic_url!==epicUrl].some(Boolean))fail('Разные снимки с одним checked_at',409);
    for(const h of history) {
      const id=`${issueId}:${h.id}`,hash=fingerprint({task_id:String(taskId),...h.fact});
      if(!await existing(c,'jira',id,hash))await insertFact(c,taskId,'jira',id,hash,h.fact);
    }
    if(old && new Date(old.checked_at)>new Date(checked))return {stale_snapshot_ignored:true};
    const result=await c.query(`INSERT INTO task_az(task_id,issue_id,issue_key,url,epic_key,epic_url,issue_created_at,status,assignee,checked_at,history_complete,status_map)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(task_id) DO UPDATE SET issue_key=EXCLUDED.issue_key,url=EXCLUDED.url,epic_key=EXCLUDED.epic_key,epic_url=EXCLUDED.epic_url,status=EXCLUDED.status,assignee=EXCLUDED.assignee,checked_at=EXCLUDED.checked_at,history_complete=EXCLUDED.history_complete,status_map=EXCLUDED.status_map RETURNING *`,
      [positiveId(taskId),issueId,key,link,epic,epicUrl,created,status,assignee,checked,body.history_complete===true,JSON.stringify(map)]);
    return result.rows[0];
  });
}

export async function primaryJira(pool,taskId) {
  const az=(await pool.query('SELECT * FROM task_az WHERE task_id=$1',[taskId])).rows[0];
  if(az)return {...az,issue_role:'az'};
  const old=(await pool.query('SELECT * FROM task_jira WHERE task_id=$1',[taskId])).rows[0];
  return old ? {...old,issue_role:'legacy'} : null;
}
export async function readAnalysis(pool,taskId) {
  const task=await getTask(pool,taskId);
  const az=(await pool.query('SELECT * FROM task_az WHERE task_id=$1',[taskId])).rows[0]||null;
  const facts=(await pool.query('SELECT * FROM task_analysis_events WHERE task_id=$1 ORDER BY occurred_at,id',[taskId])).rows;
  const blocked=automationBlock(task);
  let cutoff=task.automation_locked_at;
  if(blocked && !cutoff) {
    const events=(await readEvents(pool,taskId)).filter(e=>e.source!=='jira' && e.changes.status && normalizeStatus(e.changes.status.new)===task.status && e.occurred_at).sort((a,b)=>new Date(b.occurred_at)-new Date(a.occurred_at));
    cutoff=events[0]?.occurred_at || facts.at(-1)?.occurred_at || az?.checked_at || new Date().toISOString();
  }
  return {az,automation_locked:task.automation_locked,blocked_reason:blocked,...analysisMetrics(az,facts,{cutoff,stopped:!!blocked})};
}
