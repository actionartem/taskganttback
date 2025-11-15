// app.js — SimpleTracker API (без "досок" и без истории задач)

import express from "express";
import pkg from "pg";
import { setupSwagger } from "./swagger.js";
import crypto from "crypto";

const { Pool } = pkg;
const app = express();

app.use(express.json());

// ================== CONFIG ==================
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TG_BOT_TOKEN ||
  "8283458875:AAFLhsNJkbM4NITPOpbqFkhoGoUWEFo4lRI";

// ================== DB ==================
const pool = new Pool({
  host: process.env.DB_HOST || "db",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  user: process.env.DB_USER || "taskuser",
  password: process.env.DB_PASSWORD || "taskpass",
  database: process.env.DB_NAME || "taskdb",
});

// ===== helpers =====
const toStr = (v) => (typeof v === "string" ? v : v == null ? null : String(v));
const toInt = (v) => (v == null || v === "" ? null : Number(v));

// ================== Telegram ==================
async function sendTelegramMessage(chatId, text) {
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("telegram send error:", e.message);
  }
}

async function notifyAssignee(userId, text) {
  if (!userId) return;
  try {
    const r = await pool.query(`SELECT telegram_id FROM users WHERE id = $1`, [userId]);
    if (r.rowCount === 0) return;
    const tg = r.rows[0].telegram_id;
    if (!tg) return;
    await sendTelegramMessage(tg, text);
  } catch (e) {
    console.error("notifyAssignee error:", e);
  }
}

// ================== Swagger ==================
setupSwagger(app);

// ================== Health ==================
app.get("/health", (req, res) => res.json({ ok: true }));

// ================== Auth ==================
function hashPassword(pwd) {
  return crypto.createHash("sha256").update(pwd).digest("hex");
}

app.post("/auth/login", async (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: "login is required" });
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin FROM users WHERE login = $1`,
      [login]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "user not found" });
    const u = r.rows[0];
    res.json(u);
  } catch (e) {
    console.error("auth/login error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/register-password", async (req, res) => {
  const { login, password, name, role_text } = req.body;
  if (!login || !password || !name)
    return res.status(400).json({ error: "login, password and name are required" });

  try {
    const exists = await pool.query(`SELECT id FROM users WHERE login = $1`, [login]);
    if (exists.rowCount > 0) return res.status(400).json({ error: "login already exists" });

    const passHash = hashPassword(password);
    const ins = await pool.query(
      `
      INSERT INTO users
        (login, password_hash, name, role_text, telegram_id, is_superadmin, is_active, first_name, last_name, created_at)
      VALUES
        ($1, $2, $3, COALESCE($4,''), NULL, false, true, '', '', NOW())
      RETURNING id, login, name, role_text, telegram_id, is_superadmin
      `,
      [login, passHash, name, role_text || ""]
    );
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    console.error("auth/register-password error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/login-password", async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: "login and password are required" });
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin, password_hash FROM users WHERE login = $1`,
      [login]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "user not found" });
    const u = r.rows[0];
    if (hashPassword(password) !== u.password_hash)
      return res.status(401).json({ error: "wrong password" });
    delete u.password_hash;
    res.json(u);
  } catch (e) {
    console.error("auth/login-password error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// Telegram link/unlink — оставляем как было
app.post("/auth/telegram/request", async (req, res) => {
  const { login } = req.body;
  if (!login) return res.status(400).json({ error: "login is required" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  try {
    const ures = await pool.query(`SELECT id, name, telegram_id FROM users WHERE login = $1`, [login]);
    if (ures.rowCount === 0) return res.status(404).json({ error: "user not found" });

    const user = ures.rows[0];
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query(
      `INSERT INTO telegram_login_codes (user_id, code, created_at, expires_at) VALUES ($1,$2,NOW(),$3)`,
      [user.id, code, expiresAt]
    );

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || process.env.TG_BOT_USERNAME;
    res.json({
      ok: true,
      user_id: user.id,
      login,
      code,
      telegram_deeplink: botUsername ? `https://t.me/${botUsername}?start=st_${code}` : null,
    });
  } catch (e) {
    console.error("auth/telegram/request error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/telegram/code-from-bot", async (req, res) => {
  const { telegram_id, name, code } = req.body;
  if (!telegram_id || !code)
    return res.status(400).json({ error: "telegram_id and code are required" });
  try {
    const codeRes = await pool.query(
      `SELECT id, user_id FROM telegram_login_codes WHERE code=$1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [code]
    );
    if (codeRes.rowCount === 0) return res.status(400).json({ error: "invalid_or_expired_code" });

    const userId = codeRes.rows[0].user_id;
    const ures = await pool.query(
      `
      UPDATE users
      SET telegram_id = $1, name = COALESCE($2,name)
      WHERE id = $3
      RETURNING id, login, name, role_text, telegram_id, is_superadmin
      `,
      [telegram_id, name ? toStr(name) : null, userId]
    );
    await pool.query(`DELETE FROM telegram_login_codes WHERE user_id=$1`, [userId]);
    res.json({ ok: true, user: ures.rows[0] });
  } catch (e) {
    console.error("auth/telegram/code-from-bot error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// ================== Users ==================
app.get("/me", async (req, res) => {
  const id = Number(req.query.user_id || 0);
  if (!id) return res.status(400).json({ error: "user_id is required" });
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin FROM users WHERE id=$1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("GET /me error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.get("/users", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin FROM users ORDER BY id ASC`
    );
    res.json(r.rows);
  } catch (e) {
    console.error("GET /users error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/users", async (req, res) => {
  const { name, role_text } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const login = `user_${Date.now()}`;
  try {
    const r = await pool.query(
      `
      INSERT INTO users (login, password_hash, name, role_text, telegram_id, is_superadmin, is_active, first_name, last_name, created_at)
      VALUES ($1, NULL, $2, COALESCE($3,''), NULL, false, true, '', '', NOW())
      RETURNING id
      `,
      [login, name, role_text || ""]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error("POST /users error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.patch("/users/:id", async (req, res) => {
  const userId = Number(req.params.id);
  const { name, role_text, telegram_id } = req.body;
  try {
    const r = await pool.query(
      `
      UPDATE users
      SET name = COALESCE($1,name),
          role_text = COALESCE($2,role_text),
          telegram_id = COALESCE($3,telegram_id)
      WHERE id = $4
      RETURNING id, login, name, role_text, telegram_id, is_superadmin
      `,
      [name || null, role_text || null, telegram_id || null, userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "user not found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("PATCH /users/:id error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/users/:id", async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const check = await pool.query(`SELECT is_superadmin FROM users WHERE id=$1`, [userId]);
    if (check.rowCount > 0 && check.rows[0].is_superadmin)
      return res.status(403).json({ error: "cannot delete superadmin" });
    await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /users/:id error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// ================== Tags (global) ==================
app.get("/tags", async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, title, color FROM tags ORDER BY id ASC`);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /tags error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/tags", async (req, res) => {
  const { title, color } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  try {
    const r = await pool.query(
      `INSERT INTO tags (title, color) VALUES ($1, COALESCE($2,'#999999')) RETURNING id, title, color`,
      [title, color || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("POST /tags error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/tags/:tagId", async (req, res) => {
  const tagId = Number(req.params.tagId);
  try {
    await pool.query(`DELETE FROM task_tags WHERE tag_id=$1`, [tagId]);
    await pool.query(`DELETE FROM tags WHERE id=$1`, [tagId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /tags/:tagId error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// ================== Tasks (без досок, без истории) ==================
app.get("/tasks", async (req, res) => {
  const assigneeId = req.query.assignee_id ? Number(req.query.assignee_id) : null;
  const status     = req.query.status   ? String(req.query.status)   : null;
  const priority   = req.query.priority ? String(req.query.priority) : null;
  const tagId      = req.query.tag_id   ? Number(req.query.tag_id)   : null;
  const search     = req.query.search   ? String(req.query.search)   : null;

  try {
    const params = [];
    let where = `1=1`;
    let idx = 1;

    if (assigneeId) { where += ` AND t.assignee_user_id = $${idx++}`; params.push(assigneeId); }
    if (status)     { where += ` AND t.status = $${idx++}`;           params.push(status); }
    if (priority)   { where += ` AND t.priority = $${idx++}`;         params.push(priority); }
    if (search)     { where += ` AND (t.title ILIKE $${idx} OR t.description ILIKE $${idx})`; params.push(`%${search}%`); idx++; }
    if (tagId) {
      where += ` AND EXISTS (SELECT 1 FROM task_tags tt2 WHERE tt2.task_id = t.id AND tt2.tag_id = $${idx++})`;
      params.push(tagId);
    }

    const tasksRes = await pool.query(
      `
      SELECT
        t.id, t.title, t.description, t.status, t.priority,
        t.assignee_user_id, t.start_at, t.due_at, t.link_url,
        t.created_at, t.updated_at,
        u.name AS assignee_name, u.role_text AS assignee_role
      FROM tasks t
      LEFT JOIN users u ON t.assignee_user_id = u.id
      WHERE ${where}
      ORDER BY t.id ASC
      `,
      params
    );

    const taskIds = tasksRes.rows.map((r) => r.id);
    let tagMap = {};
    if (taskIds.length > 0) {
      const tagRows = await pool.query(
        `SELECT tt.task_id, tg.id, tg.title, tg.color
         FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
         WHERE tt.task_id = ANY($1)`,
        [taskIds]
      );
      tagMap = taskIds.reduce((acc, id) => (acc[id] = [], acc), {});
      tagRows.rows.forEach((row) => {
        tagMap[row.task_id].push({ id: row.id, title: row.title, color: row.color });
      });
    }

    const result = tasksRes.rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignee_user_id: row.assignee_user_id,
      start_at: row.start_at,
      due_at: row.due_at,
      link_url: row.link_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
      assignee_name: row.assignee_name,
      assignee_role: row.assignee_role,
      tags: tagMap[row.id] || [],
    }));

    res.json(result);
  } catch (e) {
    console.error("GET /tasks error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/tasks", async (req, res) => {
  const {
    id: clientId,            // пользовательский ID (необязателен, но можно передать)
    title,
    description,
    assignee_user_id,
    start_at,
    due_at,
    link_url,
    created_by,
    priority,
    status,
  } = req.body;

  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    // Если ID передан — проверим уникальность
    const idProvided = toInt(clientId);
    if (idProvided != null) {
      const exists = await pool.query(`SELECT 1 FROM tasks WHERE id = $1`, [idProvided]);
      if (exists.rowCount > 0) return res.status(409).json({ error: "id_already_exists" });
    }

    let sql, params;
    if (idProvided != null) {
      sql = `
        INSERT INTO tasks
          (id, title, description, assignee_user_id, start_at, due_at, link_url,
           created_by, updated_by, priority, status)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7,
           $8, $8, COALESCE($9,'low'), COALESCE($10,'new'))
        RETURNING id
      `;
      params = [
        idProvided,
        title,
        description || null,
        toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        link_url || null,
        toInt(created_by),
        priority || null,
        status || null,
      ];
    } else {
      sql = `
        INSERT INTO tasks
          (title, description, assignee_user_id, start_at, due_at, link_url,
           created_by, updated_by, priority, status)
        VALUES
          ($1, $2, $3, $4, $5, $6,
           $7, $7, COALESCE($8,'low'), COALESCE($9,'new'))
        RETURNING id
      `;
      params = [
        title,
        description || null,
        toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        link_url || null,
        toInt(created_by),
        priority || null,
        status || null,
      ];
    }

    const insert = await pool.query(sql, params);
    const taskId = insert.rows[0].id;

    if (assignee_user_id) {
      await notifyAssignee(assignee_user_id, `🆕 Новая задача #${taskId}: ${title}`);
    }

    res.status(201).json({ id: taskId });
  } catch (e) {
    console.error("POST /tasks error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.patch("/tasks/:id", async (req, res) => {
  const taskId = Number(req.params.id);
  const {
    title,
    description,
    status,
    assignee_user_id,
    start_at,
    due_at,
    link_url,
    priority,
    updated_by,
  } = req.body;

  try {
    const current = await pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [taskId]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: "task not found" });
    const before = current.rows[0];

    const upd = await pool.query(
      `
      UPDATE tasks
      SET
        title = COALESCE($1,title),
        description = COALESCE($2,description),
        status = COALESCE($3,status),
        assignee_user_id = $4,
        start_at = COALESCE($5,start_at),
        due_at = COALESCE($6,due_at),
        link_url = COALESCE($7,link_url),
        priority = COALESCE($8,priority),
        updated_by = COALESCE($9,updated_by),
        updated_at = NOW()
      WHERE id = $10
      RETURNING *
      `,
      [
        title || null,
        description || null,
        status || null,
        assignee_user_id === undefined ? before.assignee_user_id : toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        link_url || null,
        priority || null,
        toInt(updated_by),
        taskId,
      ]
    );

    const after = upd.rows[0];

    if (assignee_user_id && assignee_user_id !== before.assignee_user_id) {
      await notifyAssignee(assignee_user_id, `📌 Вам назначена задача #${taskId}: ${after.title}`);
    }

    res.json(after);
  } catch (e) {
    console.error("PATCH /tasks/:id error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/tasks/:id", async (req, res) => {
  const taskId = Number(req.params.id);
  try {
    const del = await pool.query(`DELETE FROM tasks WHERE id=$1`, [taskId]);
    if (del.rowCount === 0) return res.status(404).json({ error: "task not found" });
    return res.status(204).end();
  } catch (e) {
    console.error("DELETE /tasks/:id error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/tasks/:id/tags", async (req, res) => {
  const taskId = Number(req.params.id);
  const { tag_id } = req.body;
  if (!tag_id) return res.status(400).json({ error: "tag_id is required" });
  try {
    await pool.query(
      `INSERT INTO task_tags (task_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [taskId, tag_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /tasks/:id/tags error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/tasks/:id/tags/:tagId", async (req, res) => {
  const taskId = Number(req.params.id);
  const tagId = Number(req.params.tagId);
  try {
    await pool.query(`DELETE FROM task_tags WHERE task_id=$1 AND tag_id=$2`, [taskId, tagId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /tasks/:id/tags/:tagId error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API listening on port", PORT));
