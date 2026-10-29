import crypto from 'node:crypto';
import { ACCESS_ROLES } from './tracker-permissions.js';
import { fail, positiveId } from './tracker-domain.js';
import { handler } from './tracker-routes.js';

const publicColumns = 'id,login,name,role_text,telegram_id,is_superadmin,access_role';
function profileText(value, label, max, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Некорректное поле «${label}»`);
  return value.trim();
}
function accessRole(value) {
  if (!ACCESS_ROLES.includes(value)) fail('Неизвестная роль доступа');
  return value;
}
function checkFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Ожидается объект пользователя');
  if (Object.hasOwn(body, 'is_superadmin')) fail('Главный администратор не меняется через этот маршрут', 403);
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`Неизвестное поле: ${key}`);
}

export function registerUserWriteRoutes(app, { pool, requireUser, requireSuperadmin, hashPassword }) {
  app.post('/users', requireSuperadmin, handler(async (req, res) => {
    checkFields(req.body, ['name', 'role_text', 'login', 'password', 'access_role']);
    const name = profileText(req.body.name, 'Имя', 200, true);
    const description = profileText(req.body.role_text, 'Должность', 500) || '';
    const role = accessRole(req.body.access_role ?? 'editor');
    const account = Object.hasOwn(req.body, 'login') || Object.hasOwn(req.body, 'password');
    let login = `user_${crypto.randomUUID()}`, passwordHash = null;
    if (account) {
      if (typeof req.body.login !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(req.body.login)) fail('Логин: от 3 до 64 латинских букв, цифр, точек, дефисов или подчёркиваний');
      if (typeof req.body.password !== 'string' || req.body.password.length < 8 || req.body.password.length > 256) fail('Пароль: от 8 до 256 символов');
      login = req.body.login;
      passwordHash = hashPassword(req.body.password);
    }
    const result = await pool.query(`INSERT INTO users
      (login,password_hash,name,role_text,access_role,telegram_id,is_superadmin,is_active,first_name,last_name,created_at)
      VALUES($1,$2,$3,$4,$5,NULL,false,true,'','',now()) RETURNING ${publicColumns}`,
      [login, passwordHash, name, description, role]);
    res.status(201).json(result.rows[0]);
  }));
  app.patch('/users/:id', requireUser, handler(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!req.user.is_superadmin && String(req.user.id) !== id) fail('Недостаточно прав', 403);
    checkFields(req.body, ['name', 'role_text', 'telegram_id', 'access_role']);
    if (Object.hasOwn(req.body, 'access_role') && !req.user.is_superadmin) fail('Роль доступа меняет только главный администратор', 403);
    const name = profileText(req.body.name, 'Имя', 200, Object.hasOwn(req.body, 'name'));
    const description = profileText(req.body.role_text, 'Должность', 500);
    const telegram = profileText(req.body.telegram_id, 'Telegram', 100);
    const role = Object.hasOwn(req.body, 'access_role') ? accessRole(req.body.access_role) : null;
    const result = await pool.query(`UPDATE users SET
      name=COALESCE($1,name),role_text=COALESCE($2,role_text),telegram_id=COALESCE($3,telegram_id),
      session_generation=session_generation+CASE WHEN $5::text IS NOT NULL AND access_role IS DISTINCT FROM $5 THEN 1 ELSE 0 END,
      access_role=COALESCE($5,access_role) WHERE id=$4 RETURNING ${publicColumns}`,
      [name, description, telegram, id, role]);
    if (!result.rows.length) fail('Пользователь не найден', 404);
    res.json(result.rows[0]);
  }));
}
