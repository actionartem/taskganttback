import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { registerIncidentRoutes, validateIncident } from './tracker-incidents.js';
import { setupSwagger } from './swagger.js';

let db, pool, server, base;
const input = { number: 'INC-42', jira_url: 'https://jira.example.invalid/browse/INC-42', priority: 'high', expires_at: '2026-10-29T23:50:00+03:00', is_deferred: false, deferred_until: null };
before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE users(id BIGSERIAL PRIMARY KEY); INSERT INTO users DEFAULT VALUES; CREATE TABLE tasks(id bigint PRIMARY KEY); INSERT INTO tasks VALUES(42);');
  const migration = await fs.readFile(new URL('../migrations/20261029_incidents.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  const comments = await fs.readFile(new URL('../migrations/20261029_incident_itsm.sql', import.meta.url), 'utf8');
  await db.exec(comments); await db.exec(comments);
  await db.exec(await fs.readFile(new URL('../migrations/20261029_incidents_created_at.sql', import.meta.url), 'utf8'));
  pool = { query: async (sql, params) => db.query(sql, params) };
  const app = express(); app.use(express.json());
  const requireUser = (req, res, next) => {
    if (!['Bearer editor', 'Bearer viewer'].includes(req.get('authorization'))) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: '1' }; next();
  };
  const requireEditor = (req, res, next) => requireUser(req, res, () => req.get('authorization') === 'Bearer viewer' ? res.status(403).json({ error: 'read only user' }) : next());
  registerIncidentRoutes(app, { pool, requireUser, requireIncidentEditor: requireEditor }); setupSwagger(app);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server?.close(resolve)); await db?.close(); });
const call = (path, method = 'GET', body, role = 'editor') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${role}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('all incident routes require a session; viewers only read', async () => {
  for (const [path, method, body] of [['/incidents', 'GET'], ['/incidents', 'POST', input], ['/incidents/1', 'PATCH', input], ['/incidents/1', 'DELETE', { version: 1 }]]) {
    assert.equal((await call(path, method, body, null)).status, 401);
    assert.equal((await call(path, method, body, 'viewer')).status, method === 'GET' ? 200 : 403);
  }
  assert.equal((await call('/incidents', 'GET', undefined, 'internal')).status, 401);
});
test('invalid dates, URLs, priorities and contradictory deferral never persist', async () => {
  for (const patch of [
    { number: ' ' }, { number: 'x'.repeat(101) }, { jira_url: 'javascript:alert(1)' }, { jira_url: 'https://user:pass@example.invalid' },
    { priority: 'urgent' }, { expires_at: '2026-02-30T12:00:00+03:00' }, { expires_at: '2026-10-29T12:00' },
    { expires_at: '1999-10-29T12:00:00Z' }, { expires_at: '2026-10-29T24:00:00Z' }, { is_deferred: 'true' }, { is_deferred: true },
    { is_deferred: true, deferred_until: input.expires_at }, { deferred_until: '2026-11-01T12:00:00Z' }, { task_id: 42 },
  ]) assert.equal((await call('/incidents', 'POST', { ...input, ...patch })).status, 400, JSON.stringify(patch));
  assert.deepEqual((await (await call('/incidents')).json()).items, []);
});
test('CRUD keeps original expiry, orders by deferred deadline and protects concurrent edits', async () => {
  const created = await call('/incidents', 'POST', input); assert.equal(created.status, 201);
  const first = await created.json(); assert.equal(first.version, 1);
  assert.equal(first.expires_at, '2026-10-29T20:50:00.000Z');
  assert.equal((await call('/incidents', 'POST', { ...input, number: 'inc-42' })).status, 409);
  const second = await (await call('/incidents', 'POST', { ...input, number: 'INC-43', expires_at: '2026-10-30T12:00:00+03:00' })).json();
  const deferred = { ...input, version: first.version, is_deferred: true, deferred_until: '2026-11-01T00:15:00+03:00' };
  const updatedResponse = await call(`/incidents/${first.id}`, 'PATCH', deferred); assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.expires_at, first.expires_at); assert.equal(updated.deferred_until, '2026-10-31T21:15:00.000Z'); assert.equal(updated.version, 2);
  const list = await (await call('/incidents')).json(); assert.deepEqual(list.items.map(i => i.id), [second.id, first.id]);
  assert.equal((await call(`/incidents/${first.id}`, 'PATCH', deferred)).status, 409);
  assert.equal((await call(`/incidents/${first.id}`, 'DELETE', { version: 1 })).status, 409);
  const reset = await call(`/incidents/${first.id}`, 'PATCH', { ...input, version: 2 }); assert.equal(reset.status, 200);
  assert.equal((await reset.json()).deferred_until, null);
  assert.equal((await call(`/incidents/${first.id}`, 'DELETE', { version: 3 })).status, 204);
  assert.equal((await call(`/incidents/${second.id}`, 'DELETE', { version: 1 })).status, 204);
  assert.equal((await call(`/incidents/${first.id}`, 'DELETE', { version: 3 })).status, 404);
  assert.equal((await call('/incidents/nope', 'PATCH', { ...input, version: 1 })).status, 400);
  assert.equal((await call('/incidents/9999', 'PATCH', { ...input, version: 1 })).status, 404);
  assert.equal((await pool.query('SELECT * FROM tasks')).rows.length, 1);
});
test('database constraints protect direct writes and there is no task foreign key', async () => {
  await assert.rejects(pool.query("INSERT INTO incidents(number,jira_url,priority,expires_at,is_deferred) VALUES('BAD','https://example.invalid','high',now(),true)"));
  await assert.rejects(pool.query("INSERT INTO incidents(number,jira_url,priority,expires_at) VALUES('BAD','https://example.invalid','urgent',now())"));
  const fk = await pool.query("SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='incidents'::regclass AND contype='f'");
  assert.ok(fk.rows.every(row => row.target === 'users'));
});
test('OpenAPI describes authenticated incident operations, deferral and version conflicts', async () => {
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.ok(spec.paths['/incidents'].get.security.length);
  assert.ok(spec.paths['/incidents/{id}'].patch.responses['409']);
  assert.ok(spec.paths['/incidents/{id}'].patch.requestBody.content['application/json'].schema.required.includes('version'));
  assert.equal(spec.components.schemas.IncidentInput.properties.deferred_until.nullable, true);
  assert.throws(() => validateIncident(null));
});
