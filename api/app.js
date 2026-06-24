// app.js — SimpleTracker API (без "досок" и без истории задач)

import express from "express";
import pkg from "pg";
import { setupSwagger } from "./swagger.js";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";

const { Pool } = pkg;
const app = express();

app.use(express.json());

// ================== CONFIG ==================
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TG_BOT_TOKEN;
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  process.env.AUTH_SECRET ||
  process.env.DB_PASSWORD ||
  TELEGRAM_BOT_TOKEN;
const INTERNAL_API_TOKEN =
  process.env.INTERNAL_API_TOKEN ||
  process.env.BOT_API_TOKEN ||
  TELEGRAM_BOT_TOKEN;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30);
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "st_session";
const SESSION_COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN || ".simpletracker.ru";
const ALLOW_PASSWORDLESS_LOGIN = process.env.ALLOW_PASSWORDLESS_LOGIN === "true";
const ALLOW_PUBLIC_REGISTRATION = process.env.ALLOW_PUBLIC_REGISTRATION === "true";
const AUTH_RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 10);
const TASK_EXPORT_DIR = process.env.TASK_EXPORT_DIR || path.join(process.cwd(), "exports");
const authRateBuckets = new Map();
const taskExportJobs = new Map();

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

function parseOptionalHours(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

function toNullableNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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

const TASK_EXPORT_STATUSES = [
  "не в работе",
  "в аналитике",
  "на согласовании",
  "оценка",
  "ревью",
  "готова к разработке",
  "разработка",
  "завершена",
];

const PRIORITY_EXPORT_LABELS = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
};

const TASK_EXPORT_FIELDS = [
  { key: "id", label: "ID", width: 10, type: "number" },
  { key: "title", label: "Название", width: 34, type: "text" },
  { key: "status", label: "Статус", width: 22, type: "text" },
  { key: "priority", label: "Приоритет", width: 14, type: "text" },
  { key: "assignee", label: "Исполнитель", width: 22, type: "text" },
  { key: "approved_hours", label: "Согласовано часов", width: 18, type: "number" },
  { key: "spent_hours", label: "Затрачено часов", width: 18, type: "number" },
  { key: "link_url", label: "Ссылка на задачу в JIRA", width: 42, type: "link" },
  { key: "start_at", label: "Дата начала", width: 14, type: "date" },
  { key: "due_at", label: "Дата окончания", width: 16, type: "date" },
  { key: "tags", label: "Теги", width: 26, type: "text" },
  { key: "description", label: "Описание", width: 48, type: "text" },
];

const TASK_EXPORT_FIELD_MAP = new Map(TASK_EXPORT_FIELDS.map((field) => [field.key, field]));
const TASK_EXPORT_STATUS_SET = new Set(TASK_EXPORT_STATUSES);

function normalizeExportStatuses(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses
    .map((status) => normalizeStatus(status))
    .filter((status) => status && TASK_EXPORT_STATUS_SET.has(status));
}

function normalizeExportFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .map((field) => String(field || "").trim())
    .filter((field, index, array) => TASK_EXPORT_FIELD_MAP.has(field) && array.indexOf(field) === index);
}

function serializeTaskExportJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    fileName: job.fileName || null,
    downloadUrl: job.status === "done" ? `/exports/tasks/${job.id}/download` : null,
    error: job.error || null,
  };
}

function setTaskExportProgress(job, progress) {
  job.progress = Math.max(job.progress || 0, Math.min(100, Math.round(progress)));
  job.updatedAt = new Date();
}

function asExportDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getTaskExportValue(row, fieldKey, tagMap) {
  if (fieldKey === "id") return Number(row.id);
  if (fieldKey === "title") return row.title || "";
  if (fieldKey === "description") return row.description || "";
  if (fieldKey === "status") return normalizeStatus(row.status) || "";
  if (fieldKey === "priority") return PRIORITY_EXPORT_LABELS[row.priority] || row.priority || "";
  if (fieldKey === "assignee") return row.assignee_name || "";
  if (fieldKey === "approved_hours") return toNullableNumber(row.approved_hours);
  if (fieldKey === "spent_hours") return toNullableNumber(row.spent_hours);
  if (fieldKey === "link_url") return row.link_url || "";
  if (fieldKey === "start_at") return asExportDate(row.start_at);
  if (fieldKey === "due_at") return asExportDate(row.due_at);
  if (fieldKey === "tags") return (tagMap[row.id] || []).map((tag) => tag.title).join(", ");
  return "";
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function signSessionPayload(payloadBase64) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");
}

function createSessionToken(user) {
  const payload = base64UrlJson({
    sub: user.id,
    login: user.login,
    is_superadmin: !!user.is_superadmin,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  return `${payload}.${signSessionPayload(payload)}`;
}

function verifySessionToken(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [payloadBase64, signature] = parts;
  if (!safeEqual(signSessionPayload(payloadBase64), signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    if (!payload.sub || !payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function getCookie(req, name) {
  const header = req.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function getRequestSessionToken(req) {
  return getBearerToken(req) || getCookie(req, SESSION_COOKIE_NAME);
}

function withSession(user) {
  return { ...user, token: createSessionToken(user) };
}

function sendSession(res, user, status = 200) {
  const payload = withSession(user);
  res.cookie(SESSION_COOKIE_NAME, payload.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: SESSION_COOKIE_DOMAIN || undefined,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
  return res.status(status).json(payload);
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: SESSION_COOKIE_DOMAIN || undefined,
    path: "/",
  });
}

function rateLimitAuth(req, res, next) {
  const key = `${req.ip || req.socket?.remoteAddress || "unknown"}:${req.body?.login || ""}`;
  const now = Date.now();
  const bucket = authRateBuckets.get(key) || { count: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + AUTH_RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  authRateBuckets.set(key, bucket);

  if (bucket.count > AUTH_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "too many auth attempts" });
  }

  return next();
}

async function authenticateRequest(req, res, next) {
  try {
    const internalToken = req.get("x-internal-token");
    if (INTERNAL_API_TOKEN && safeEqual(internalToken, INTERNAL_API_TOKEN)) {
      req.isInternal = true;
      return next();
    }

    const payload = verifySessionToken(getRequestSessionToken(req));
    if (!payload) return res.status(401).json({ error: "unauthorized" });

    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin
       FROM users
       WHERE id=$1 AND COALESCE(is_active, true) = true`,
      [payload.sub]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "unauthorized" });

    req.user = r.rows[0];
    req.isInternal = false;
    return next();
  } catch (e) {
    console.error("auth middleware error:", e);
    return res.status(500).json({ error: "auth error" });
  }
}

function requireAuth(req, res, next) {
  return authenticateRequest(req, res, next);
}

function requireUser(req, res, next) {
  return authenticateRequest(req, res, () => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    return next();
  });
}

function requireSuperadmin(req, res, next) {
  return authenticateRequest(req, res, () => {
    if (!req.user?.is_superadmin) return res.status(403).json({ error: "forbidden" });
    return next();
  });
}

function getRoleText(user) {
  return String(user?.role_text || "").toLowerCase();
}

function isReadOnlyUser(user) {
  if (!user || user.is_superadmin) return false;
  const role = getRoleText(user);
  return [
    "viewer",
    "read-only",
    "readonly",
    "только чтение",
    "просмотр",
    "наблюдатель",
  ].some((marker) => role.includes(marker));
}

function requireEditor(req, res, next) {
  return authenticateRequest(req, res, () => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (isReadOnlyUser(req.user)) return res.status(403).json({ error: "read only user" });
    return next();
  });
}

function requireInternal(req, res, next) {
  const internalToken = req.get("x-internal-token");
  if (!INTERNAL_API_TOKEN || !safeEqual(internalToken, INTERNAL_API_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.isInternal = true;
  return next();
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

async function fetchTasksForExport(statuses) {
  const statusValues = Array.from(new Set(statuses.flatMap((status) => statusFilterValues(status))));

  const tasksRes = await pool.query(
    `
    SELECT
      t.id, t.title, t.description, t.status, t.priority,
      t.assignee_user_id, t.start_at, t.due_at, t.link_url,
      t.approved_hours, t.spent_hours,
      t.created_at, t.updated_at,
      u.name AS assignee_name, u.role_text AS assignee_role
    FROM tasks t
    LEFT JOIN users u ON t.assignee_user_id = u.id
    WHERE t.status = ANY($1)
    ORDER BY t.id ASC
    `,
    [statusValues]
  );

  const taskIds = tasksRes.rows.map((row) => row.id);
  const tagMap = {};
  if (taskIds.length > 0) {
    const tagRows = await pool.query(
      `SELECT tt.task_id, tg.id, tg.title, tg.color
       FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
       WHERE tt.task_id = ANY($1)
       ORDER BY tg.title ASC`,
      [taskIds]
    );

    taskIds.forEach((id) => {
      tagMap[id] = [];
    });
    tagRows.rows.forEach((row) => {
      tagMap[row.task_id].push({ id: row.id, title: row.title, color: row.color });
    });
  }

  return { rows: tasksRes.rows, tagMap };
}

function applyTaskExportWorksheetStyle(worksheet, selectedFields, rowsCount) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: selectedFields.length },
  };

  selectedFields.forEach((field, index) => {
    const column = worksheet.getColumn(index + 1);
    column.width = field.width;
    if (field.type === "date") column.numFmt = "yyyy-mm-dd";
    if (field.type === "number" && field.key !== "id") column.numFmt = "0.##";
  });

  const header = worksheet.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F766E" },
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFCBD5E1" } },
      left: { style: "thin", color: { argb: "FFCBD5E1" } },
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
      right: { style: "thin", color: { argb: "FFCBD5E1" } },
    };
  });

  for (let rowNumber = 2; rowNumber <= rowsCount + 1; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } },
      };
      if (rowNumber % 2 === 0) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" },
        };
      }
    });
  }
}

async function runTaskExportJob(jobId) {
  const job = taskExportJobs.get(jobId);
  if (!job) return;

  try {
    job.status = "running";
    setTaskExportProgress(job, 5);
    await fs.mkdir(TASK_EXPORT_DIR, { recursive: true });

    setTaskExportProgress(job, 18);
    const { rows, tagMap } = await fetchTasksForExport(job.statuses);
    setTaskExportProgress(job, 35);

    const selectedFields = job.fields.map((fieldKey) => TASK_EXPORT_FIELD_MAP.get(fieldKey));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "SimpleTracker";
    workbook.created = new Date();
    workbook.modified = new Date();

    const worksheet = workbook.addWorksheet("Задачи", {
      properties: { defaultRowHeight: 20 },
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    });
    worksheet.addRow(selectedFields.map((field) => field.label));

    const linkColumnIndex = selectedFields.findIndex((field) => field.key === "link_url") + 1;
    rows.forEach((task, index) => {
      const values = selectedFields.map((field) => getTaskExportValue(task, field.key, tagMap));
      const row = worksheet.addRow(values);
      if (linkColumnIndex > 0 && task.link_url) {
        const cell = row.getCell(linkColumnIndex);
        cell.value = { text: task.link_url, hyperlink: task.link_url };
        cell.font = { color: { argb: "FF2563EB" }, underline: true };
      }

      const progressStep = rows.length > 0 ? ((index + 1) / rows.length) * 45 : 45;
      setTaskExportProgress(job, 35 + progressStep);
    });

    applyTaskExportWorksheetStyle(worksheet, selectedFields, rows.length);
    setTaskExportProgress(job, 88);

    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `simpletracker-tasks-${safeTimestamp}-${job.id.slice(0, 8)}.xlsx`;
    const filePath = path.join(TASK_EXPORT_DIR, fileName);

    await workbook.xlsx.writeFile(filePath);

    job.status = "done";
    job.fileName = fileName;
    job.filePath = filePath;
    setTaskExportProgress(job, 100);
  } catch (e) {
    console.error("task export error:", e);
    job.status = "error";
    job.error = "Произошла ошибка выгрузки, повторите еще раз";
    setTaskExportProgress(job, 100);
  }
}

// ================== Swagger ==================
setupSwagger(app);

// ================== Health ==================
app.get("/health", (req, res) => res.json({ ok: true }));

// ================== Auth ==================
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function legacyHashPassword(pwd) {
  return crypto.createHash("sha256").update(String(pwd)).digest("hex");
}

function verifyPassword(pwd, storedHash) {
  if (!storedHash) return false;

  if (storedHash.startsWith("scrypt:")) {
    const [, salt, expected] = storedHash.split(":");
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(pwd), salt, 64).toString("hex");
    return safeEqual(actual, expected);
  }

  return safeEqual(legacyHashPassword(pwd), storedHash);
}

function needsPasswordRehash(storedHash) {
  return !storedHash || !storedHash.startsWith("scrypt:");
}

app.post("/auth/login", rateLimitAuth, async (req, res) => {
  if (!ALLOW_PASSWORDLESS_LOGIN) {
    return res.status(403).json({ error: "passwordless login is disabled" });
  }

  const { login } = req.body;
  if (!login) return res.status(400).json({ error: "login is required" });
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin FROM users WHERE login = $1`,
      [login]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "user not found" });
    const u = r.rows[0];
    return sendSession(res, u);
  } catch (e) {
    console.error("auth/login error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/register-password", rateLimitAuth, async (req, res) => {
  const { login, password, name, role_text } = req.body;
  if (!login || !password || !name)
    return res.status(400).json({ error: "login, password and name are required" });

  try {
    const userCount = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
    const isFirstUser = Number(userCount.rows[0]?.count || 0) === 0;
    if (!ALLOW_PUBLIC_REGISTRATION && !isFirstUser) {
      return res.status(403).json({ error: "public registration is disabled" });
    }

    const exists = await pool.query(`SELECT id FROM users WHERE login = $1`, [login]);
    if (exists.rowCount > 0) return res.status(400).json({ error: "login already exists" });

    const passHash = hashPassword(password);
    const ins = await pool.query(
      `
      INSERT INTO users
        (login, password_hash, name, role_text, telegram_id, is_superadmin, is_active, first_name, last_name, created_at)
      VALUES
        ($1, $2, $3, COALESCE($4,''), NULL, $5, true, '', '', NOW())
      RETURNING id, login, name, role_text, telegram_id, is_superadmin
      `,
      [login, passHash, name, role_text || "", isFirstUser]
    );
    return sendSession(res, ins.rows[0], 201);
  } catch (e) {
    console.error("auth/register-password error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/login-password", rateLimitAuth, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: "login and password are required" });
  try {
    const r = await pool.query(
      `SELECT id, login, name, role_text, telegram_id, is_superadmin, password_hash FROM users WHERE login = $1`,
      [login]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "user not found" });
    const u = r.rows[0];
    if (!verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: "wrong password" });
    }
    if (needsPasswordRehash(u.password_hash)) {
      await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(password), u.id]);
    }
    delete u.password_hash;
    return sendSession(res, u);
  } catch (e) {
    console.error("auth/login-password error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/auth/change-password", requireUser, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required" });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: "new password must be at least 8 characters" });
  }

  try {
    const r = await pool.query(`SELECT id, password_hash FROM users WHERE id=$1`, [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "user not found" });
    const user = r.rows[0];
    if (!verifyPassword(current_password, user.password_hash)) {
      return res.status(401).json({ error: "wrong password" });
    }

    await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(new_password), req.user.id]);
    return sendSession(res, req.user);
  } catch (e) {
    console.error("auth/change-password error:", e);
    res.status(500).json({ error: "db error" });
  }
});

// Telegram link/unlink
app.post("/auth/telegram/request", requireUser, async (req, res) => {
  const login = req.user.login;
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

app.post("/auth/telegram/code-from-bot", requireInternal, async (req, res) => {
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
app.get("/me", requireUser, async (req, res) => {
  const requestedId = Number(req.query.user_id || req.user.id);
  const id = req.user.is_superadmin ? requestedId : req.user.id;
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

app.get("/users", requireUser, async (req, res) => {
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

app.post("/users", requireSuperadmin, async (req, res) => {
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

app.patch("/users/:id", requireUser, async (req, res) => {
  const userId = Number(req.params.id);
  const { name, role_text, telegram_id } = req.body;
  if (!req.user.is_superadmin && req.user.id !== userId) {
    return res.status(403).json({ error: "forbidden" });
  }
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

app.delete("/users/:id", requireSuperadmin, async (req, res) => {
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
app.get("/tags", requireUser, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, title, color FROM tags ORDER BY id ASC`);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /tags error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/tags", requireEditor, async (req, res) => {
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

app.delete("/tags/:tagId", requireEditor, async (req, res) => {
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
app.get("/tasks", requireAuth, async (req, res) => {
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
        t.approved_hours, t.spent_hours,
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
      approved_hours: toNullableNumber(row.approved_hours),
      spent_hours: toNullableNumber(row.spent_hours),
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

// ================== Task exports ==================
app.post("/exports/tasks", requireUser, async (req, res) => {
  const statuses = normalizeExportStatuses(req.body?.statuses);
  const fields = normalizeExportFields(req.body?.fields);

  if (statuses.length === 0) {
    return res.status(400).json({ error: "select at least one status" });
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: "select at least one field" });
  }

  const job = {
    id: crypto.randomUUID(),
    ownerId: req.user.id,
    statuses,
    fields,
    status: "queued",
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    fileName: null,
    filePath: null,
    error: null,
  };

  taskExportJobs.set(job.id, job);
  setImmediate(() => runTaskExportJob(job.id));

  res.json(serializeTaskExportJob(job));
});

app.get("/exports/tasks/:jobId", requireUser, async (req, res) => {
  const job = taskExportJobs.get(req.params.jobId);
  if (!job || job.ownerId !== req.user.id) {
    return res.status(404).json({ error: "export not found" });
  }

  res.json(serializeTaskExportJob(job));
});

app.get("/exports/tasks/:jobId/download", requireUser, async (req, res) => {
  const job = taskExportJobs.get(req.params.jobId);
  if (!job || job.ownerId !== req.user.id || job.status !== "done" || !job.filePath) {
    return res.status(404).json({ error: "export not found" });
  }

  try {
    await fs.access(job.filePath);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    return res.download(job.filePath, job.fileName || "simpletracker-tasks.xlsx");
  } catch (e) {
    console.error("task export download error:", e);
    return res.status(404).json({ error: "export file not found" });
  }
});

app.post("/tasks", requireEditor, async (req, res) => {
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
    approved_hours,
    spent_hours,
  } = req.body;

  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const approvedHours = parseOptionalHours(approved_hours);
    const spentHours = parseOptionalHours(spent_hours);
    if (Number.isNaN(approvedHours) || Number.isNaN(spentHours)) {
      return res.status(400).json({ error: "hours must be non-negative numbers" });
    }

    const actorId = req.user?.id || toInt(created_by);
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
           created_by, updated_by, priority, status, approved_hours, spent_hours)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7,
           $8, $8, COALESCE($9,'low'), COALESCE($10,'не в работе'), $11, $12)
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
        actorId,
        priority || null,
        normalizeStatus(status) || "не в работе",
        approvedHours,
        spentHours,
      ];
    } else {
      sql = `
        INSERT INTO tasks
          (title, description, assignee_user_id, start_at, due_at, link_url,
           created_by, updated_by, priority, status, approved_hours, spent_hours)
        VALUES
          ($1, $2, $3, $4, $5, $6,
           $7, $7, COALESCE($8,'low'), COALESCE($9,'не в работе'), $10, $11)
        RETURNING id
      `;
      params = [
        title,
        cleanNullableText(description),
        toInt(assignee_user_id),
        start_at || null,
        due_at || null,
        cleanNullableText(link_url),
        actorId,
        priority || null,
        normalizeStatus(status) || "не в работе",
        approvedHours,
        spentHours,
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
app.get("/tasks/:id/history", requireUser, async (req, res) => {
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


app.patch("/tasks/:id", requireEditor, async (req, res) => {
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
    approved_hours,
    spent_hours,
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
    if (hasOwn(body, "approved_hours")) {
      const approvedHours = parseOptionalHours(approved_hours);
      if (Number.isNaN(approvedHours)) {
        return res.status(400).json({ error: "approved_hours must be a non-negative number" });
      }
      addSet("approved_hours", approvedHours);
    }
    if (hasOwn(body, "spent_hours")) {
      const spentHours = parseOptionalHours(spent_hours);
      if (Number.isNaN(spentHours)) {
        return res.status(400).json({ error: "spent_hours must be a non-negative number" });
      }
      addSet("spent_hours", spentHours);
    }

    if (setParts.length === 0) {
      return res.json({
        ...before,
        status: normalizeStatus(before.status),
        approved_hours: toNullableNumber(before.approved_hours),
        spent_hours: toNullableNumber(before.spent_hours),
      });
    }

    addSet("updated_by", req.user.id || toInt(updated_by));
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

    res.json({
      ...after,
      status: normalizeStatus(after.status),
      approved_hours: toNullableNumber(after.approved_hours),
      spent_hours: toNullableNumber(after.spent_hours),
    });
  } catch (e) {
    console.error("PATCH /tasks/:id error:", e);
    res.status(500).json({ error: "db error" });
  }
});

app.delete("/tasks/:id", requireEditor, async (req, res) => {
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

app.post("/tasks/:id/tags", requireEditor, async (req, res) => {
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

app.delete("/tasks/:id/tags/:tagId", requireEditor, async (req, res) => {
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
