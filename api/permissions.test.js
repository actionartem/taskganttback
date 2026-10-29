import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { sessionCodec } from './tracker-session.js';
import { createUserAuthenticator, permissionGuard, permissionsFor } from './tracker-permissions.js';
import { registerUserWriteRoutes } from './tracker-users.js';
import { registerIncidentRoutes } from './tracker-incidents.js';
import { registerTrackerRoutes, handler } from './tracker-routes.js';

let db, pool, server, base, codec, passwords;
const tokens = {};
const incident = { number: 'ACCESS-1', jira_url: 'https://jira.example.invalid/browse/ACCESS-1', priority: 'medium', expires_at: '2026-11-01T12:00:00+03:00', is_deferred: false, deferred_until: null };
before(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE users(id BIGSERIAL PRIMARY KEY,login text UNIQUE,name text,role_text text,
    password_hash text,telegram_id text,is_superadmin boolean DEFAULT false,is_active boolean DEFAULT true,
    session_generation integer NOT NULL DEFAULT 0,first_name text,last_name text,created_at timestamptz DEFAULT now());
    INSERT INTO users(login,name,role_text,is_superadmin) VALUES
    ('admin','Admin','viewer',true),('editor','Editor','Developer',false),
    ('support','Support','Support',false),('viewer','Viewer','viewer',false),('legacy','Legacy','только чтение',false);
    CREATE TABLE tasks(id bigint PRIMARY KEY,title text); INSERT INTO tasks VALUES(42,'Original');`);
  const migration = await fs.readFile(new URL('../migrations/20261029_user_access_roles.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  await db.exec("UPDATE users SET access_role='incident_editor' WHERE login='support'");
  await db.exec(await fs.readFile(new URL('../migrations/20261029_incidents.sql', import.meta.url), 'utf8'));
  const query = async (sql, params) => { const result = await db.query(sql, params); return { ...result, rowCount: result.affectedRows ?? result.rows.length } };
  pool = { query };
  codec = sessionCodec('synthetic-local-permissions-test-secret', 3600);
  for (const user of (await query('SELECT * FROM users')).rows) tokens[user.login] = codec.create(user);
  const source = await fs.readFile(new URL('./app.js', import.meta.url), 'utf8');
  // Exercise the same password implementation passed to the production user routes.
  const context = { crypto, safeEqual: (a, b) => a === b };
  vm.runInNewContext(source.slice(source.indexOf('function hashPassword('), source.indexOf('app.post("/auth/login",')) + '; this.passwords={hashPassword,verifyPassword};', context);
  passwords = context.passwords;
  const auth = createUserAuthenticator({ pool, verifySessionToken: codec.verify, getRequestSessionToken: req => req.get('authorization')?.replace(/^Bearer /, ''), internalToken: 'synthetic-internal', safeEqual: (a, b) => a === b });
  const requireUser = (req, res, next) => auth(req, res, () => req.user ? next() : res.status(401).end());
  const requireEditor = permissionGuard(auth, 'editTasks');
  const requireSuperadmin = permissionGuard(auth, 'manageUsers');
  const app = express(); app.use(express.json());
  app.get('/tasks', requireUser, handler(async (_req, res) => res.json((await query('SELECT * FROM tasks')).rows)));
  // Real HTTP mutations behind the same production task guard, with a deliberately minimal task table.
  app.post('/tasks', requireEditor, handler(async (req, res) => res.status(201).json((await query('INSERT INTO tasks VALUES($1,$2) RETURNING *', [req.body.id, req.body.title])).rows[0])));
  app.patch('/tasks/:id', requireEditor, handler(async (req, res) => res.json((await query('UPDATE tasks SET title=$1 WHERE id=$2 RETURNING *', [req.body.title, req.params.id])).rows[0])));
  app.delete('/tasks/:id', requireEditor, handler(async (req, res) => { await query('DELETE FROM tasks WHERE id=$1', [req.params.id]); res.status(204).end() }));
  registerIncidentRoutes(app, { pool, requireUser, requireIncidentEditor: permissionGuard(auth, 'editIncidents') });
  registerTrackerRoutes(app, { pool, requireUser, requireEditor, env: { AGENT_API_TOKEN: 'synthetic-agent', JIRA_INGEST_TOKEN: 'synthetic-jira' } });
  registerUserWriteRoutes(app, { pool, requireUser, requireSuperadmin, hashPassword: passwords.hashPassword });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server?.close(resolve)); await db?.close(); });
const call = (path, method = 'GET', body, role = 'support') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

test('role migration preserves legacy viewers and superadmin; unknown roles fail closed', async () => {
  const users = (await pool.query('SELECT * FROM users ORDER BY id')).rows;
  assert.equal(users.find(u => u.login === 'legacy').access_role, 'viewer');
  const admin = users.find(u => u.login === 'admin');
  assert.equal(admin.is_superadmin, true); assert.equal(admin.access_role, 'viewer');
  assert.deepEqual(permissionsFor(admin), { editTasks: true, editIncidents: true, manageUsers: true });
  assert.deepEqual(permissionsFor({ access_role: 'unknown' }), { editTasks: false, editIncidents: false, manageUsers: false });
  assert.deepEqual(permissionsFor(null), { editTasks: false, editIncidents: false, manageUsers: false });
  await assert.rejects(pool.query("UPDATE users SET access_role='root' WHERE login='support'"));
});
test('support reads minors and incidents but cannot write tasks, events or documents', async () => {
  assert.equal((await call('/tasks')).status, 200); assert.equal((await call('/incidents')).status, 200);
  for (const [path, method, body] of [
    ['/tasks', 'POST', { id: 43, title: 'Forbidden' }], ['/tasks/42', 'PATCH', { title: 'Forbidden' }], ['/tasks/42', 'DELETE'],
    ['/tasks/42/events', 'POST', {}], ['/tasks/42/documents', 'POST', {}], ['/tasks/42/documents/approved', 'POST', {}],
    ['/tasks/42/documents/1/state', 'POST', {}], ['/attention/settings', 'PUT', {}],
  ]) assert.equal((await call(path, method, body)).status, 403, path);
  assert.deepEqual((await pool.query('SELECT * FROM tasks')).rows.map(row => ({ ...row, id: String(row.id) })), [{ id: '42', title: 'Original' }]);
});
test('support has complete incident CRUD; viewers and unauthenticated callers cannot write', async () => {
  for (const role of ['viewer', 'missing']) assert.equal((await call('/incidents', 'POST', incident, role)).status, role === 'viewer' ? 403 : 401);
  const created = await call('/incidents', 'POST', incident); assert.equal(created.status, 201); const saved = await created.json();
  const edited = await call(`/incidents/${saved.id}`, 'PATCH', { ...incident, priority: 'high', version: 1 }); assert.equal(edited.status, 200);
  assert.equal((await call(`/incidents/${saved.id}`, 'DELETE', { version: 2 })).status, 204);
});
test('a profile change cannot grant rights, edit another user, or change superadmin', async () => {
  assert.equal((await call('/users', 'POST', { name: 'Unauthorized' })).status, 403);
  assert.equal((await call('/users/3', 'PATCH', { access_role: 'editor' })).status, 403);
  assert.equal((await call('/users/3', 'PATCH', { is_superadmin: true })).status, 403);
  assert.equal((await call('/users/2', 'PATCH', { name: 'Unauthorized' })).status, 403);
  assert.equal((await call('/users/3', 'PATCH', { role_text: 'admin', name: 'Support profile' })).status, 200);
  assert.equal((await call('/tasks/42', 'PATCH', { title: 'Still forbidden' })).status, 403);
  assert.equal((await call('/users/4', 'PATCH', { role_text: '' }, 'viewer')).status, 200);
  assert.equal((await call('/incidents', 'POST', incident, 'viewer')).status, 403);
});
test('only superadmin creates password accounts; responses never expose the hash', async () => {
  const account = { name: 'Synthetic support', login: 'test-support', password: 'synthetic-test-only-42', access_role: 'incident_editor' };
  const response = await call('/users', 'POST', account, 'admin'); assert.equal(response.status, 201);
  const saved = await response.json(); assert.equal(saved.is_superadmin, false); assert.equal(saved.access_role, 'incident_editor');
  assert.equal(saved.password_hash, undefined); assert.equal(saved.password, undefined);
  const row = (await pool.query('SELECT * FROM users WHERE id=$1', [saved.id])).rows[0];
  assert.match(row.password_hash, /^scrypt:/); assert.notEqual(row.password_hash, account.password);
  assert.ok(passwords.verifyPassword(account.password, row.password_hash));
  assert.equal((await call('/users', 'POST', account, 'admin')).status, 409);
  assert.equal((await call('/users', 'POST', { ...account, login: 'bad', access_role: 'root' }, 'admin')).status, 400);
  assert.equal((await call('/users', 'POST', { ...account, login: 'bad', password: 'short' }, 'admin')).status, 400);
});
test('role changes revoke old sessions; current role is read from DB on every request', async () => {
  const original = (await pool.query("SELECT * FROM users WHERE login='editor'")).rows[0];
  assert.equal((await call('/users/2', 'PATCH', { access_role: 'incident_editor' }, 'admin')).status, 200);
  assert.equal((await call('/tasks', 'GET', undefined, 'editor')).status, 401);
  const changed = (await pool.query('SELECT * FROM users WHERE id=2')).rows[0];
  assert.equal(changed.session_generation, original.session_generation + 1);
  tokens.editor = codec.create(changed);
  assert.equal((await call('/tasks/42', 'PATCH', { title: 'Forbidden' }, 'editor')).status, 403);
  await pool.query("UPDATE users SET access_role='viewer' WHERE id=2");
  assert.equal((await call('/incidents', 'POST', incident, 'editor')).status, 403);
  await pool.query('UPDATE users SET is_active=false WHERE id=2');
  assert.equal((await call('/tasks', 'GET', undefined, 'editor')).status, 401);
});
test('master admin retains all operations and internal integration tokens never become user roles', async () => {
  assert.equal((await call('/tasks/42', 'PATCH', { title: 'Admin edit' }, 'admin')).status, 200);
  const response = await call('/incidents', 'POST', { ...incident, number: 'ADMIN-1' }, 'admin'); assert.equal(response.status, 201);
  const internal = await fetch(`${base}/incidents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-token': 'synthetic-internal' }, body: JSON.stringify(incident) });
  assert.equal(internal.status, 401);
  assert.equal((await call('/users/1', 'PATCH', { is_superadmin: false }, 'admin')).status, 403);
});
