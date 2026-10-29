import { fail, positiveId } from './tracker-domain.js';
import { handler } from './tracker-routes.js';

const fields = new Set(['number', 'jira_url', 'priority', 'expires_at', 'is_deferred', 'deferred_until', 'version']);

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
  return { number: body.number.trim(), jira_url: jira.href, priority: body.priority, expires_at: expires, is_deferred: body.is_deferred, deferred_until: deferred };
}

export function registerIncidentRoutes(app, { pool, requireUser, requireIncidentEditor }) {
  app.get('/incidents', requireUser, handler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ items: (await pool.query(`SELECT * FROM incidents ORDER BY
      CASE WHEN is_deferred THEN deferred_until ELSE expires_at END, id`)).rows });
  }));
  app.post('/incidents', requireIncidentEditor, handler(async (req, res) => {
    const input = validateIncident(req.body);
    const result = await pool.query(`INSERT INTO incidents
      (number,jira_url,priority,expires_at,is_deferred,deferred_until,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [...Object.values(input), req.user.id]);
    res.status(201).json(result.rows[0]);
  }));
  app.patch('/incidents/:id', requireIncidentEditor, handler(async (req, res) => {
    const id = positiveId(req.params.id);
    const input = validateIncident(req.body, { updating: true });
    const result = await pool.query(`UPDATE incidents SET
      number=$1,jira_url=$2,priority=$3,expires_at=$4,is_deferred=$5,deferred_until=$6,
      updated_by=$7,updated_at=now(),version=version+1 WHERE id=$8 AND version=$9 RETURNING *`,
      [...Object.values(input), req.user.id, id, req.body.version]);
    if (!result.rows.length) {
      const exists = (await pool.query('SELECT id FROM incidents WHERE id=$1', [id])).rows.length;
      fail(exists ? 'Инцидент уже изменён. Обновите список и откройте его заново.' : 'Инцидент не найден', exists ? 409 : 404);
    }
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
}
