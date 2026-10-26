import { normalizeStatus } from './tracker-domain.js';

const moscowDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });
export function calendarDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? moscowDate.format(date) : null;
}

// A current snapshot is not evidence of when completion happened.
export function completedOn(task, events, now = new Date()) {
  if (normalizeStatus(task.status) !== 'завершена') return null;
  const changes = events.filter(e => e.source !== 'jira' && e.changes?.status &&
    normalizeStatus(e.changes.status.old) !== normalizeStatus(e.changes.status.new));
  const timed = changes.filter(e => e.occurred_at && new Date(e.occurred_at) <= now)
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at) ||
      String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
  const latest = timed[0];
  if (!latest || normalizeStatus(latest.changes.status.new) !== 'завершена') return null;
  // An undated later update can conceal reopening and another completion.
  if (changes.some(e => !e.occurred_at && (!e.received_at || new Date(e.received_at) >= new Date(latest.occurred_at)))) return null;
  return calendarDate(latest.occurred_at);
}

export async function readHoursFacts(pool) {
  // One statement gives tasks and their journals a consistent snapshot. Jira is separate.
  const result = await pool.query(`WITH transitions AS (
    SELECT task_id,id::text,source,changes,occurred_at,received_at FROM task_events
      WHERE source <> 'jira' AND changes ? 'status'
    UNION ALL
    SELECT task_id,'legacy:'||id,'legacy',jsonb_build_object('status',jsonb_build_object('old',old_value,'new',new_value)),changed_at,changed_at
      FROM task_change_log WHERE field_name='status' AND event_id IS NULL
  ), journals AS (
    SELECT task_id,jsonb_agg(to_jsonb(transitions)) AS events FROM transitions GROUP BY task_id
  ) SELECT t.id,t.status,t.due_at,j.events FROM tasks t LEFT JOIN journals j ON j.task_id=t.id`);
  const now = new Date();
  return result.rows.map(t => ({
    task_id: String(t.id),
    completed_on: completedOn(t, t.events || [], now),
    planned_release_on: calendarDate(t.due_at),
  }));
}
