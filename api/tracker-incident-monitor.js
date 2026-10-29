// Only local archives are written. This worker never changes anything in MOS ITSM.
const parsedDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
const localDeadline = incident => new Date(incident.is_deferred ? incident.deferred_until : incident.expires_at);

export function incidentClosureDecision(incident, record, now = new Date()) {
  const waiting = record.status === 'waiting_for';
  const waitingUntil = waiting ? parsedDate(record.waiting_until) : null;
  const resolution = parsedDate(record.resolution_target_at);
  if (waiting && !waitingUntil) throw new Error('В МосИТСМ установлено ожидание без даты. Нужна ручная проверка');
  // Remember an extension observed before completion: ITSM can clear waiting_until on closure.
  const remembered = parsedDate(incident.itsm_deadline_at);
  let deadline = waitingUntil || resolution || remembered || localDeadline(incident);
  if (record.status === 'completed') {
    const completed = parsedDate(record.completed_at);
    if (!completed) throw new Error('МосИТСМ не сообщил дату завершения. Нужна ручная проверка');
    // Keep an observed postponement, but also honor a newer resolution target.
    if (incident.is_deferred || remembered) deadline = new Date(Math.max(+deadline, +(remembered || 0), incident.is_deferred ? +localDeadline(incident) : 0));
    return { status: +completed <= +deadline ? 'completed' : 'burned', deadline, completed };
  }
  return { status: +now >= +deadline ? 'burned' : 'active', deadline, completed: null };
}

export async function checkIncidentClosure({ pool, itsm, incident, now = new Date() }) {
  // The row may have been manually closed after a worker claimed it.
  const fresh = (await pool.query('SELECT status,version FROM incidents WHERE id=$1', [incident.id])).rows[0];
  if (!fresh || fresh.status !== 'active' || fresh.version !== incident.version) return;
  try {
    const record = await itsm.record(incident.number);
    const decision = incidentClosureDecision(incident, record, now);
    const next = new Date(Math.max(+now + 60000, Math.min(+now + 300000, +decision.deadline - 300000)));
    if (decision.status === 'active') {
      await pool.query(`UPDATE incidents SET last_checked_at=$1,next_check_at=$2,itsm_deadline_at=$3,check_error=NULL
        WHERE id=$4 AND status='active' AND version=$5`, [now.toISOString(),next.toISOString(),decision.deadline.toISOString(),incident.id,incident.version]);
    } else {
      await pool.query(`UPDATE incidents SET status=$1,closure_source='itsm',closed_at=$2,closure_deadline_at=$3,itsm_completed_at=$4,
        itsm_deadline_at=$3,last_checked_at=$2,next_check_at=NULL,check_error=NULL,updated_at=$2,version=version+1
        WHERE id=$5 AND status='active' AND version=$6`,
        [decision.status,now.toISOString(),decision.deadline.toISOString(),decision.completed?.toISOString() || null,incident.id,incident.version]);
    }
  } catch (error) {
    // An unavailable provider is not evidence that an incident missed its deadline.
    const message = error?.status ? error.message : ['В МосИТСМ установлено ожидание без даты. Нужна ручная проверка', 'МосИТСМ не сообщил дату завершения. Нужна ручная проверка'].includes(error.message) ? error.message : 'Не удалось проверить МосИТСМ. Проверка будет повторена';
    await pool.query(`UPDATE incidents SET last_checked_at=$1,next_check_at=$2,check_error=$3
      WHERE id=$4 AND status='active' AND version=$5`, [now.toISOString(),new Date(+now+300000).toISOString(),message,incident.id,incident.version]);
  }
}

export async function runIncidentMonitor({ pool, itsm, now = new Date() }) {
  // A short lease and SKIP LOCKED also protect against overlapping API instances.
  const result = await pool.query(`UPDATE incidents SET next_check_at=$2 WHERE id IN (
    SELECT id FROM incidents WHERE status='active' AND COALESCE(next_check_at,$1::timestamptz)<=$1
      AND COALESCE(itsm_deadline_at,CASE WHEN is_deferred THEN deferred_until ELSE expires_at END)<=$1::timestamptz+interval '5 minutes'
    ORDER BY next_check_at NULLS FIRST,id FOR UPDATE SKIP LOCKED LIMIT 20
  ) RETURNING *`, [now.toISOString(),new Date(+now+120000).toISOString()]);
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < result.rows.length) await checkIncidentClosure({ pool, itsm, incident: result.rows[cursor++], now });
  }));
}

export function startIncidentMonitor({ pool, itsm }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runIncidentMonitor({ pool, itsm }); }
    catch (error) { console.error('incident monitor failed:', error.code || error.name); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 60000); timer.unref();
  const first = setTimeout(tick, 5000); first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
