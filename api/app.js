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
  process.env.TG_BOT_TOKEN;

// ================== DB ==================
const pool = new Pool({
  host: process.env.DB_HOST || "db",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  user: process.env.DB_USER || "taskuser",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "taskdb",
});

// ===== helpers =====
const toStr = (v) => (typeof v === "string" ? v : v == null ? null : String(v));
const toInt = (v) => (v == null || v === "" ? null : Number(v));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const STATUS_API_TO_UI = {
  new: "не в работе",
  in_progress: "разработка",
  done: "завершена",
  review: "ревью",
};

const STATUS_UI_TO_API_LEGACY = {
  "не в работе": "new",
  разработка: "in_progress",
  завершена: "done",
  ревью: "review",
};

function cleanNullableText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function normalizeStatus(value) {
  const text = cleanNullableText(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  return STATUS_API_TO_UI[lower] || lower;
}

function statusFilterValues(value) {
  const normalized = normalizeStatus(value);
  if (!normalized) return [];
  const values = new Set([normalized, value]);
  if (STATUS_UI_TO_API_LEGACY[normalized]) values.add(STATUS_UI_TO_API_LEGACY[normalized]);
  return Array.from(values);
}

// ================== Telegram ==================
async function sendTelegramMessage(chatId, text) {
  if (!chatId || !TELEGRAM_BOT_TOKEN) return;
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const check = await client.query(`SELECT is_superadmin FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (check.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "user not found" });
    }

    if (check.rows[0].is_superadmin) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "cannot delete superadmin" });
    }

    await client.query(`UPDATE tasks SET created_by = NULL WHERE created_by = $1`, [userId]);
    await client.query(`UPDATE tasks SET updated_by = NULL WHERE updated_by = $1`, [userId]);
    await client.query(`DELETE FROM users WHERE id=$1`, [userId]);
    await client.query("COMMIT");

    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("DELETE /users/:id error:", e);
    res.status(500).json({ error: "db error" });
  } finally {
    client.release();
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
    if (status)     { where += ` AND t.status = ANY($${idx++})`;      params.push(statusFilterValues(status)); }
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
      status: normalizeStatus(row.status),
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
           $8, $8, COALESCE($9,'low'), COALESCE($10,'не в работе'))
        RETURNING id
      `;
      params = [
        idProvided,
        title,
        cleanNullableText(description),
        toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        cleanNullableText(link_url),
        toInt(created_by),
        priority || null,
        normalizeStatus(status) || "не в работе",
      ];
    } else {
      sql = `
        INSERT INTO tasks
          (title, description, assignee_user_id, start_at, due_at, link_url,
           created_by, updated_by, priority, status)
        VALUES
          ($1, $2, $3, $4, $5, $6,
           $7, $7, COALESCE($8,'low'), COALESCE($9,'не в работе'))
        RETURNING id
      `;
      params = [
        title,
        cleanNullableText(description),
        toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        cleanNullableText(link_url),
        toInt(created_by),
        priority || null,
        normalizeStatus(status) || "не в работе",
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

// ================== Task history ==================
app.get("/tasks/:id/history", async (req, res) => {
  const taskId = Number(req.params.id);
  if (!taskId) return res.status(400).json({ error: "invalid task id" });

  try {
    const r = await pool.query(
      `SELECT field_name, old_value, new_value, changed_at
       FROM task_change_log
       WHERE task_id = $1
       ORDER BY changed_at DESC, id DESC`,
      [taskId]
    );

    res.json(r.rows);
  } catch (e) {
    console.error("GET /tasks/:id/history error:", e);
    res.status(500).json({ error: "db error" });
  }
});


app.patch("/tasks/:id", async (req, res) => {
  const taskId = Number(req.params.id);
  const body = req.body || {};
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
  } = body;

  try {
    const current = await pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [taskId]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: "task not found" });
    const before = current.rows[0];

    const setParts = [];
    const values = [];
    const addSet = (field, value) => {
      values.push(value);
      setParts.push(`${field} = $${values.length}`);
    };

    if (hasOwn(body, "title")) {
      const cleanTitle = cleanNullableText(title);
      if (!cleanTitle) return res.status(400).json({ error: "title is required" });
      addSet("title", cleanTitle);
    }
    if (hasOwn(body, "description")) addSet("description", cleanNullableText(description));
    if (hasOwn(body, "status")) addSet("status", normalizeStatus(status) || before.status);
    if (hasOwn(body, "assignee_user_id")) addSet("assignee_user_id", toInt(assignee_user_id));
    if (hasOwn(body, "start_at")) addSet("start_at", start_at || null);
    if (hasOwn(body, "due_at")) addSet("due_at", due_at || null);
    if (hasOwn(body, "link_url")) addSet("link_url", cleanNullableText(link_url));
    if (hasOwn(body, "priority")) addSet("priority", cleanNullableText(priority) || before.priority);
    if (hasOwn(body, "updated_by")) addSet("updated_by", toInt(updated_by));

    if (setParts.length === 0) {
      return res.json({ ...before, status: normalizeStatus(before.status) });
    }

    values.push(taskId);
    const upd = await pool.query(
      `
      UPDATE tasks
      SET
        ${setParts.join(",\n        ")},
        updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
      `,
      values
    );

    const after = upd.rows[0];
    // ==== log changes: status / start_at / due_at ====
    const asIso = (v) => {
      if (v == null) return null;
      const d = v instanceof Date ? v : new Date(v);
      return d.toISOString();
    };

    const beforeStart = asIso(before.start_at);
    const afterStart = asIso(after.start_at);
    const beforeDue = asIso(before.due_at);
    const afterDue = asIso(after.due_at);
    const beforeStatus = normalizeStatus(before.status);
    const afterStatus = normalizeStatus(after.status);

    const changes = [];
    if (beforeStatus !== afterStatus) {
      changes.push(["status", toStr(beforeStatus), toStr(afterStatus)]);
    }
    if (beforeStart !== afterStart) {
      changes.push(["start_at", beforeStart, afterStart]);
    }
    if (beforeDue !== afterDue) {
      changes.push(["due_at", beforeDue, afterDue]);
    }

    for (const [field, oldVal, newVal] of changes) {
      await pool.query(
        `INSERT INTO task_change_log (task_id, field_name, old_value, new_value)
         VALUES ($1, $2, $3, $4)`,
        [taskId, field, oldVal, newVal]
      );
    }


    const nextAssigneeId = toInt(assignee_user_id);
    if (hasOwn(body, "assignee_user_id") && nextAssigneeId && nextAssigneeId !== before.assignee_user_id) {
      await notifyAssignee(nextAssigneeId, `📌 Вам назначена задача #${taskId}: ${after.title}`);
    }

    res.json({ ...after, status: normalizeStatus(after.status) });
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
