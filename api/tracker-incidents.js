import { fail, positiveId } from './tracker-domain.js';
import { handler } from './tracker-routes.js';
import { createItsmClient, incidentSyncFields, incidentSyncPreview } from './tracker-itsm.js';
import { startIncidentMonitor } from './tracker-incident-monitor.js';
import { rememberIncidentCreatedAt, startIncidentCreationLoader } from './tracker-incident-created.js';

const fields = new Set(['number', 'jira_url', 'priority', 'expires_at', 'is_deferred', 'deferred_until', 'comment', 'version']);

function timestamp(value, label) {
  // Explicit offset is mandatory; the browser sends Moscow time as +03:00.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    fail(`${label}: укажите дату и время с часовым поясом`);
  const instant = new Date(value);
  const calendarDate = value.slice(0, 10);
  const day = new Date(`${calendarDate}T00:00:00Z`);
  if (+value.slice(11, 13) > 23 || !Number.isFinite(instant.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDate)
    fail(`${label}: некорректная дата`);
  if (+calendarDate.slice(0, 4) < 2000 || +calendarDate.slice(0, 4) > 2100)
    fail(`${label}: допустимы годы с 2000 по 2100`);
  return instant.toISOString();
}

export function validateIncident(body, { updating = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Ожидается объект инцидента');
  for (const key of Object.keys(body)) if (!fields.has(key)) fail(`Неизвестное поле: ${key}`);
  if (typeof body.number !== 'string' || !body.number.trim() || body.number.trim().length > 100)
    fail('Укажите номер инцидента (до 100 символов)');
  if (typeof body.jira_url !== 'string' || body.jira_url.length > 2000) fail('Укажите ссылку на задачу Jira');
  let jira;
  try { jira = new URL(body.jira_url.trim()); } catch { fail('Некорректная ссылка Jira'); }
  if (!['http:', 'https:'].includes(jira.protocol) || jira.username || jira.password) fail('Ссылка Jira должна использовать HTTP или HTTPS без пароля');
  if (!['low', 'medium', 'high'].includes(body.priority)) fail('Приоритет: низкий, средний или высокий');
  if (typeof body.is_deferred !== 'boolean') fail('Укажите, был ли отложен инцидент');
  const expires = timestamp(body.expires_at, 'Дата сгорания');
  const deferred = body.is_deferred ? timestamp(body.deferred_until, 'Отложен до') : null;
  if (!body.is_deferred && body.deferred_until != null) fail('Для неотложенного инцидента поле «Отложен до» должно быть пустым');
  if (deferred && deferred <= expires) fail('Новый срок должен быть позже исходной даты сгорания');
  if (updating && (!Number.isInteger(body.version) || body.version < 1)) fail('Укажите версию инцидента');
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 10000)) fail('Комментарий: не более 10000 символов');
  return { number: body.number.trim(), jira_url: jira.href, priority: body.priority, expires_at: expires, is_deferred: body.is_deferred, deferred_until: deferred, comment: body.comment ?? (updating ? null : '') };
}

export function registerIncidentRoutes(app, { pool, requireUser, requireIncidentEditor, itsm = createItsmClient(), startJobs = true }) {
  app.get('/incidents', requireUser, handler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ items: (await pool.query(`SELECT * FROM incidents ORDER BY
      CASE WHEN is_deferred THEN deferred_until ELSE expires_at END, id`)).rows });
  }));
  app.post('/incidents', requireIncidentEditor, handler(async (req, res) => {
    const input = validateIncident(req.body);
    const result = await pool.query(`INSERT INTO incidents
      (number,jira_url,priority,expires_at,is_deferred,deferred_until,comment,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [...Object.values(input), req.user.id]);
    res.status(201).json(result.rows[0]);
  }));
  app.patch('/incidents/:id', requireIncidentEditor, handler(async (req, res) => {
    const id = positiveId(req.params.id);
    const input = validateIncident(req.body, { updating: true });
    const result = await pool.query(`UPDATE incidents SET
      number=$1,jira_url=$2,priority=$3,expires_at=$4,is_deferred=$5,deferred_until=$6,
      itsm_created_at=CASE WHEN number IS DISTINCT FROM $1::varchar THEN NULL ELSE itsm_created_at END,
      comment=COALESCE($7,comment),updated_by=$8,updated_at=now(),version=version+1,
      next_check_at=CASE WHEN status='active' THEN now() ELSE NULL END,itsm_deadline_at=NULL WHERE id=$9 AND version=$10 RETURNING *`,
      [...Object.values(input), req.user.id, id, req.body.version]);
    if (!result.rows.length) {
      const exists = (await pool.query('SELECT id FROM incidents WHERE id=$1', [id])).rows.length;
      fail(exists ? 'Инцидент уже изменён. Обновите список и откройте его заново.' : 'Инцидент не найден', exists ? 409 : 404);
    }
    res.json(result.rows[0]);
  }));
  const localIncident = async (id) => {
    const row = (await pool.query('SELECT * FROM incidents WHERE id=$1', [positiveId(id)])).rows[0];
    if (!row) fail('Инцидент не найден', 404);
    return row;
  };
  app.patch('/incidents/:id/comment', requireIncidentEditor, handler(async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !['comment','version'].includes(key))
      || typeof req.body.comment !== 'string' || req.body.comment.length > 10000
      || !Number.isInteger(req.body.version) || req.body.version < 1) fail('Укажите комментарий до 10000 символов и версию инцидента');
    const result = await pool.query(`UPDATE incidents SET comment=$1,updated_by=$2,updated_at=now(),version=version+1
      WHERE id=$3 AND version=$4 RETURNING *`, [req.body.comment,req.user.id,positiveId(req.params.id),req.body.version]);
    if (!result.rows.length) { await localIncident(req.params.id); fail('Инцидент уже изменён. Комментарий не сохранён', 409); }
    res.set('Cache-Control', 'private, no-store').json(result.rows[0]);
  }));
  app.patch('/incidents/:id/fields', requireIncidentEditor, handler(async (req, res) => {
    const editable = new Set(['priority','expires_at','is_deferred','deferred_until']);
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== 'version' && !editable.has(key))
      || !Number.isInteger(req.body.version) || req.body.version < 1) fail('Укажите изменяемые поля и версию инцидента');
    const keys = Object.keys(req.body).filter(key => editable.has(key));
    if (!keys.length) fail('Укажите хотя бы одно изменяемое поле');
    const current = await localIncident(req.params.id);
    if (current.version !== req.body.version) fail('Инцидент уже изменён. Повторите правку', 409);
    const base = { number: current.number, jira_url: current.jira_url, priority: current.priority,
      expires_at: new Date(current.expires_at).toISOString(), is_deferred: current.is_deferred,
      deferred_until: current.deferred_until ? new Date(current.deferred_until).toISOString() : null };
    const input = validateIncident({ ...base, ...req.body }, { updating: true });
    const timingChanged = keys.some(key => key !== 'priority' && base[key] !== input[key]);
    const values = keys.map(key => input[key]);
    const assignments = keys.map((key, index) => `${key}=$${index + 1}`);
    values.push(req.user.id, timingChanged, current.id, current.version);
    const actor = keys.length + 1, timing = actor + 1, id = timing + 1, version = id + 1;
    const result = await pool.query(`UPDATE incidents SET ${assignments.join(',')},updated_by=$${actor},updated_at=now(),version=version+1,
      next_check_at=CASE WHEN $${timing} THEN CASE WHEN status='active' THEN now() ELSE NULL END ELSE next_check_at END,
      itsm_deadline_at=CASE WHEN $${timing} THEN NULL ELSE itsm_deadline_at END
      WHERE id=$${id} AND version=$${version} RETURNING *`, values);
    if (!result.rows.length) fail('Инцидент изменён во время сохранения. Повторите правку', 409);
    res.set('Cache-Control', 'private, no-store').json(result.rows[0]);
  }));
  app.get('/incidents/:id/itsm', requireUser, handler(async (req, res) => {
    if (!req.user) fail('Нужна пользовательская сессия', 401);
    res.set('Cache-Control', 'private, no-store');
    const incident = await localIncident(req.params.id);
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const details = await itsm.details(incident.number, controller.signal);
    const created = await rememberIncidentCreatedAt(pool, incident, details.record);
    if (created) incident.itsm_created_at = created;
    res.json({ ...details, incident, incident_version: incident.version, synchronization: incident.status === 'active' ? incidentSyncPreview(details.record) : { values: null, error: 'Инцидент в архиве. Синхронизация отключена' } });
  }));
  app.post('/incidents/:id/itsm/sync', requireIncidentEditor, handler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.body || Object.keys(req.body).some(key => key !== 'version') || !Number.isInteger(req.body.version) || req.body.version < 1) fail('Для синхронизации укажите только версию инцидента');
    const current = await localIncident(req.params.id);
    if (current.status !== 'active') fail('Инцидент в архиве. Синхронизация отключена', 409);
    if (current.version !== req.body.version) fail('Инцидент уже изменён. Откройте подробности заново', 409);
    const record = await itsm.record(current.number), patch = incidentSyncFields(record);
    const changed_fields = Object.keys(patch).filter(key => key.endsWith('_at') || key === 'deferred_until'
      ? (current[key] == null ? null : new Date(current[key]).toISOString()) !== patch[key] : current[key] !== patch[key]);
    // Always check the version after the external request, including a no-change sync.
    const result = await pool.query(`UPDATE incidents SET priority=$1,expires_at=$2,is_deferred=$3,deferred_until=$4,
      updated_by=CASE WHEN $5 THEN $6 ELSE updated_by END,updated_at=CASE WHEN $5 THEN now() ELSE updated_at END,
      version=version+CASE WHEN $5 THEN 1 ELSE 0 END,next_check_at=now(),itsm_deadline_at=NULL
      WHERE id=$7 AND version=$8 AND number=$9 AND status='active' RETURNING *`,
      [patch.priority,patch.expires_at,patch.is_deferred,patch.deferred_until,changed_fields.length>0,req.user.id,current.id,current.version,current.number]);
    if (!result.rows.length) fail('Инцидент изменён во время загрузки. Откройте подробности заново', 409);
    res.json({ incident: result.rows[0], changed_fields, record, checked_at: new Date().toISOString(), synchronization: { values: patch, error: null } });
  }));
  app.post('/incidents/:id/close', requireIncidentEditor, handler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => !['status','version'].includes(key)) || !['completed','burned'].includes(req.body.status) || !Number.isInteger(req.body.version) || req.body.version<1) fail('Выберите результат и укажите версию инцидента');
    const result = await pool.query(`UPDATE incidents SET status=$1,closure_source='manual',closed_at=now(),
      closure_deadline_at=CASE WHEN is_deferred THEN deferred_until ELSE expires_at END,next_check_at=NULL,check_error=NULL,
      updated_at=now(),updated_by=$2,version=version+1 WHERE id=$3 AND version=$4 AND status='active' RETURNING *`,
      [req.body.status,req.user.id,positiveId(req.params.id),req.body.version]);
    if (!result.rows.length) { await localIncident(req.params.id); fail('Инцидент уже закрыт или изменён. Обновите список', 409); }
    res.json(result.rows[0]);
  }));
  app.delete('/incidents/:id', requireIncidentEditor, handler(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!Number.isInteger(req.body?.version) || req.body.version < 1) fail('Укажите версию инцидента');
    const result = await pool.query('DELETE FROM incidents WHERE id=$1 AND version=$2 RETURNING id', [id, req.body.version]);
    if (!result.rows.length) {
      const exists = (await pool.query('SELECT id FROM incidents WHERE id=$1', [id])).rows.length;
      fail(exists ? 'Инцидент уже изменён. Обновите список.' : 'Инцидент не найден', exists ? 409 : 404);
    }
    res.status(204).end();
  }));
  if (startJobs && itsm.configured) {
    const stopMonitor = startIncidentMonitor({ pool, itsm });
    const stopCreationLoader = startIncidentCreationLoader({ pool, itsm });
    return () => { stopMonitor(); stopCreationLoader(); };
  }
}
