import { workingMilliseconds } from './tracker-working-calendar.js';

const time = value => value == null ? null : new Date(value).getTime();
const iso = value => value == null ? null : new Date(value).toISOString();
const order = (a,b) => time(a.occurred_at)-time(b.occurred_at) || String(a.id).localeCompare(String(b.id),undefined,{numeric:true});
const duration = (from,to) => from == null || to == null ? null : workingMilliseconds(from,to);

// Only AZ changelog may describe analyst work. Epic and local task logs are excluded.
export function analysisMetrics(az, events, { now = new Date(), cutoff = null, stopped = false } = {}) {
  const end = Math.min(time(now), time(cutoff) ?? time(now));
  const observedEnd = Math.min(end, time(az?.checked_at) ?? end);
  const transitions = events.filter(e=>e.source==='jira' && e.type==='jira_status_changed').sort(order);
  const segments = [];
  let complete = Boolean(az?.history_complete), phase = transitions[0]?.payload.old_phase ?? az?.status_map?.[az?.status];
  let cursor = time(az?.issue_created_at), rawStatus = transitions[0]?.payload.old_status ?? az?.status;
  for (const e of transitions) {
    const at=time(e.occurred_at);
    if (cursor == null || at < cursor || e.payload.old_phase !== phase || e.payload.old_status !== rawStatus || at > time(az?.checked_at)) complete=false;
    if (cursor != null && phase && at>=cursor) segments.push({from:cursor,to:Math.min(at,observedEnd),phase});
    cursor=at; phase=e.payload.new_phase; rawStatus=e.payload.new_status;
  }
  if (phase !== az?.status_map?.[az?.status] || rawStatus !== az?.status) complete=false;
  if (cursor != null && cursor<=observedEnd && phase) segments.push({from:cursor,to:observedEnd,phase});
  const phaseAt = at => segments.find(s=>s.from<=at && s.to>at)?.phase;
  const phaseTotal = (kind,from,to) => {
    if (!complete || from==null || from<time(az?.issue_created_at) || to<from || to>observedEnd) return null;
    let sum=0;
    for (const s of segments.filter(s=>s.phase===kind && s.to>from && s.from<to)) {
      const ms=duration(Math.max(from,s.from),Math.min(to,s.to));
      if(ms==null)return null; sum+=ms;
    }
    return sum;
  };
  const rounds = new Map();
  for (const e of events.filter(e=>e.source==='mail' && time(e.occurred_at)<=end).sort(order)) {
    if (!rounds.has(e.cycle_id)) rounds.set(e.cycle_id,[]);
    rounds.get(e.cycle_id).push(e);
  }
  const groups=[...rounds].map(([id,facts])=>({id,facts,start:time(facts.find(e=>e.type==='comments_received')?.occurred_at) ?? time(facts[0].occurred_at)})).sort((a,b)=>a.start-b.start);
  const cycles=groups.map((g,index)=>{
    const comments=g.facts.find(e=>e.type==='comments_received');
    const sent=g.facts.find(e=>e.type==='document_sent');
    const approved=g.facts.find(e=>e.type==='approval_received');
    const nextComments=groups.slice(index+1).flatMap(n=>n.facts).find(e=>e.type==='comments_received');
    const from=time(comments?.occurred_at), sentAt=time(sent?.occurred_at), approvedAt=time(approved?.occurred_at);
    const nextAt=time(nextComments?.occurred_at);
    const roundEnd=Math.min(end,approvedAt??Infinity,nextAt??Infinity);
    const workEnd=Math.min(sentAt??roundEnd,roundEnd,observedEnd);
    const starts=transitions.filter(e=>time(e.occurred_at)>=from && time(e.occurred_at)<=workEnd && e.payload.new_phase==='analysis');
    const started=from!=null && complete && phaseAt(from)==='analysis' ? from : from!=null && complete ? time(starts[0]?.occurred_at) : null;
    const startKnown=from!=null && complete && Boolean(phaseAt(from));
    const waitingUntil=started ?? (startKnown && !sent ? Math.min(roundEnd,observedEnd) : null);
    const approvalTransition=sentAt!=null && complete ? transitions.find(e=>time(e.occurred_at)>=sentAt && time(e.occurred_at)<=roundEnd && e.payload.new_phase==='approval') : null;
    const statusAt=sentAt!=null && complete && phaseAt(sentAt)==='approval' ? sentAt : time(approvalTransition?.occurred_at);
    const chronological=(!sentAt || from==null || sentAt>=from) && (!approvedAt || !sentAt || approvedAt>=sentAt) && (from==null || roundEnd>=from);
    return {
      id:g.id, comments_at:iso(from), started_at:iso(started), sent_at:iso(sentAt), approved_at:iso(approvedAt),
      response_at:iso(approvedAt ?? nextAt), ended_at:iso(approvedAt ?? nextAt ?? (stopped?roundEnd:null)),
      state:approved?'approved':nextComments?'returned':stopped?'stopped':sent?'customer':started!=null?'working':'waiting',
      started_by:started===from ? null : starts[0]?.actor_name || null,
      waiting_ms:chronological ? duration(from,waitingUntil) : null,
      analysis_ms:chronological ? phaseTotal('analysis',from,workEnd) : null,
      review_ms:chronological ? phaseTotal('review',from,workEnd) : null,
      approval_ms:chronological && sentAt!=null && roundEnd>=sentAt ? duration(sentAt,roundEnd) : null,
      jira_approval_at:iso(statusAt), jira_approval_delay_ms:chronological ? duration(sentAt,statusAt) : null,
      incomplete:!complete || from==null || !chronological,
      facts:g.facts.map(e=>({type:e.type,at:e.occurred_at,actor:e.actor_name,url:e.source_url})),
    };
  });
  const finishedWaits=cycles.filter(c=>c.started_at && c.waiting_ms!=null).map(c=>c.waiting_ms);
  const sum=key=>{const values=cycles.map(c=>c[key]);return values.length && values.every(v=>v!=null)?values.reduce((a,b)=>a+b,0):null;};
  return { cycles:cycles.reverse(), history_complete:complete, observed_until:iso(observedEnd),
    summary:{cycles:cycles.length, measured_waits:finishedWaits.length, average_wait_ms:finishedWaits.length?finishedWaits.reduce((a,b)=>a+b,0)/finishedWaits.length:null,
      analysis_ms:sum('analysis_ms'),review_ms:sum('review_ms'),approval_ms:sum('approval_ms')},
    schedule:{time_zone:'Europe/Moscow',from:'10:00',to:'19:00',hours_per_day:8,partial_day:'proportional',calendar_years:[2024,2025,2026,2027]},
  };
}
