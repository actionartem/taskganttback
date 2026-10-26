import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  RequestError,
  fail,
  positiveId,
  text,
  url,
  date,
  externalEvent,
  STAGES,
  stageDurations,
  attentionReasons,
} from "./tracker-domain.js";
import {
  transaction,
  getTask,
  readEvents,
  applyExternal,
  insertEvent,
} from "./tracker-store.js";
import {
  DOCUMENT_COLUMNS,
  validateDocument,
  insertDocument,
  validateApprovedDocument,
  replaceApprovedDocument,
} from "./tracker-documents.js";
import { saveJiraSnapshot } from "./tracker-jira.js";
import { readHoursFacts } from "./tracker-hours.js";

const safeEqual = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length > 0 &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof RequestError)
      return res.status(e.status).json({ error: e.message });
    if (e.code === "23505")
      return res.status(409).json({ error: "Запись уже существует" });
    console.error("tracker request failed:", e.code || e.name);
    res.status(500).json({ error: "Не удалось выполнить действие" });
  }
};
export function registerTrackerRoutes(
  app,
  { pool, requireUser, requireEditor, env = process.env },
) {
  app.get("/statistics/hours", requireUser, handler(async (_req, res) => {
    res.json({ items: await readHoursFacts(pool), time_zone: "Europe/Moscow" });
  }));
  app.get("/integrations/guide", (req, res) =>
    res
      .type("text/plain; charset=utf-8")
      .sendFile(fileURLToPath(new URL("./agent-guide.txt", import.meta.url))),
  );
  const integration = (kind) => (req, res, next) => {
    const token = kind === "jira" ? env.JIRA_INGEST_TOKEN : env.AGENT_API_TOKEN;
    if (!safeEqual(req.get("x-integration-token"), token))
      return res.status(401).json({ error: "unauthorized" });
    req.integration = kind === "jira" ? "jira-agent" : "mail-agent";
    next();
  };
  const agent = integration("mail"),
    jiraAgent = integration("jira");
  app.get(
    "/integrations/agent/options",
    agent,
    handler(async (req, res) => {
      const [users, tags] = await Promise.all([
        pool.query(
          "SELECT id,name FROM users WHERE COALESCE(is_active,true)=true ORDER BY name",
        ),
        pool.query("SELECT id,title,color FROM tags ORDER BY title"),
      ]);
      res.json({
        users: users.rows,
        tags: tags.rows,
        statuses: Object.keys(STAGES),
        priorities: ["low", "medium", "high"],
      });
    }),
  );
  const eventFor = (req) =>
    externalEvent(
      req.integration
        ? req.body.event
        : { ...req.body.event, actor_name: req.user.name },
      req.integration || "simpletracker",
      req.integration || `user:${req.user.id}`,
    );
  const taskRead = handler(async (req, res) => {
    const task = await getTask(pool, req.params.id);
    const snapshot =
      (await pool.query("SELECT * FROM task_jira WHERE task_id=$1", [task.id]))
        .rows[0] || null;
    res.json({ ...task, jira: snapshot });
  });
  app.get("/tasks/:id", requireUser, taskRead);
  app.get("/integrations/agent/tasks/:id", agent, taskRead);
  app.get(
    "/integrations/agent/tasks",
    agent,
    handler(async (req, res) => {
      const q = text(req.query.q, 200) || "";
      res.json(
        (
          await pool.query(
            `SELECT t.id,t.title,t.email_thread,j.issue_key FROM tasks t LEFT JOIN task_jira j ON j.task_id=t.id
      WHERE $1='' OR t.id::text=$1 OR j.issue_key=$1 OR t.title ILIKE '%'||$1||'%' ORDER BY t.id LIMIT 200`,
            [q],
          )
        ).rows,
      );
    }),
  );
  const eventsRead = handler(async (req, res) => {
    await getTask(pool, req.params.id);
    res.json(await readEvents(pool, req.params.id));
  });
  app.get("/tasks/:id/events", requireUser, eventsRead);
  app.get("/integrations/agent/tasks/:id/events", agent, eventsRead);
  const eventWrite = handler(async (req, res) => {
    if (req.body.changes !== undefined)
      fail("Для изменения полей используйте /actions");
    const result = await applyExternal(
      pool,
      positiveId(req.params.id),
      eventFor(req),
      null,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  const actionWrite = handler(async (req, res) => {
    if (!req.body.changes || typeof req.body.changes !== "object")
      fail("Нужен явный объект changes");
    const result = await applyExternal(
      pool,
      positiveId(req.params.id),
      eventFor(req),
      req.body.changes,
    );
    res.json(result);
  });
  app.post("/integrations/agent/tasks/:id/events", agent, eventWrite);
  app.post("/integrations/agent/tasks/:id/actions", agent, actionWrite);
  app.post("/tasks/:id/events", requireEditor, eventWrite);

  app.get(
    "/jira",
    requireUser,
    handler(async (req, res) =>
      res.json({
        delivery: "agent",
        items: (await pool.query("SELECT * FROM task_jira ORDER BY task_id"))
          .rows,
      }),
    ),
  );
  app.put(
    "/tasks/:id/jira",
    requireEditor,
    handler(async (req, res) => {
      const taskId = positiveId(req.params.id),
        key = text(req.body.issue_key, 100),
        link = url(req.body.url);
      if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !link)
        fail("Нужны ключ Jira и ссылка");
      const result = await transaction(pool, async (c) => {
        await getTask(c, taskId, true);
        const old = (
          await c.query("SELECT * FROM task_jira WHERE task_id=$1", [taskId])
        ).rows[0];
        if (old?.issue_id && old.issue_key !== key)
          fail(
            "Связь уже содержит данные. Для смены основной задачи нужна проверка истории.",
            409,
          );
        if (old?.issue_key !== key || old?.url !== link)
          await insertEvent(
            c,
            taskId,
            {
              source: "simpletracker",
              type: "task.updated",
              summary: "Связь с Jira изменена",
              actor_name: req.user.name,
              recorder: `user:${req.user.id}`,
              occurred_at: new Date().toISOString(),
            },
            { jira_link: { old: old?.url || null, new: link } },
          );
        return (
          await c.query(
            `INSERT INTO task_jira(task_id,issue_key,url) VALUES($1,$2,$3) ON CONFLICT(task_id) DO UPDATE SET issue_key=$2,url=$3 RETURNING *`,
            [taskId, key, link],
          )
        ).rows[0];
      });
      res.json(result);
    }),
  );
  app.post(
    "/integrations/jira/tasks/:id/snapshot",
    jiraAgent,
    handler(async (req, res) =>
      res.json(
        await saveJiraSnapshot(
          pool,
          positiveId(req.params.id),
          req.body,
          req.integration,
        ),
      ),
    ),
  );

  const documentRead = handler(async (req, res) => {
    const taskId = req.params.id ? positiveId(req.params.id) : null;
    if (taskId) await getTask(pool, taskId);
    res.json(
      (
        await pool.query(
          req.query.latest === "approved"
            ? `SELECT DISTINCT ON (task_id) ${DOCUMENT_COLUMNS} FROM task_documents WHERE ($1::bigint IS NULL OR task_id=$1) AND approved_at IS NOT NULL ORDER BY task_id,approved_at DESC,received_at DESC,id DESC`
            : `SELECT ${DOCUMENT_COLUMNS} FROM task_documents WHERE ($1::bigint IS NULL OR task_id=$1) ORDER BY received_at DESC,id DESC`,
          [taskId],
        )
      ).rows,
    );
  });
  app.get("/documents", requireUser, documentRead);
  app.get("/tasks/:id/documents", requireUser, documentRead);
  app.get("/integrations/agent/tasks/:id/documents", agent, documentRead);
  const approvedDocumentWrite = handler(async (req, res) => {
    const event = eventFor(req), taskId = positiveId(req.params.id);
    if (event.type !== "document.approved") fail("Ожидается событие document.approved");
    const doc = validateApprovedDocument(req.body.document);
    const result = await applyExternal(pool, taskId, event, null, { ...doc, file_bytes: undefined }, async (client, r) => ({ document: await replaceApprovedDocument(client, taskId, r.event.id, doc) }));
    if (result.duplicate) result.document = (await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM task_documents WHERE event_id=$1`, [result.event.id])).rows[0];
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.post("/tasks/:id/documents/approved", requireEditor, approvedDocumentWrite);
  app.post("/integrations/agent/tasks/:id/documents/approved", agent, approvedDocumentWrite);
  const documentWrite = handler(async (req, res) => {
    const doc = validateDocument(req.body.document),
      event = eventFor(req),
      taskId = positiveId(req.params.id);
    if (event.type !== "document.received")
      fail("Для регистрации версии нужен тип document.received");
    const extra = { ...doc, file_bytes: undefined };
    const result = await applyExternal(
      pool,
      taskId,
      event,
      null,
      extra,
      (c, r) =>
        insertDocument(c, taskId, r.event.id, doc).then((document) => ({
          document,
        })),
    );
    if (result.duplicate)
      result.document = (
        await pool.query(
          `SELECT ${DOCUMENT_COLUMNS} FROM task_documents WHERE event_id=$1`,
          [result.event.id],
        )
      ).rows[0];
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.post("/tasks/:id/documents", requireEditor, documentWrite);
  app.post("/integrations/agent/tasks/:id/documents", agent, documentWrite);
  const documentMark = handler(async (req, res) => {
    const taskId = positiveId(req.params.id),
      docId = positiveId(req.params.docId),
      event = eventFor(req);
    const state = req.body.state;
    if (
      !state ||
      typeof state !== "object" ||
      Object.keys(state).some(
        (k) => !["is_current", "approved_at", "approval_evidence"].includes(k),
      )
    )
      fail("Некорректное состояние документа");
    if (state.is_current !== undefined && typeof state.is_current !== "boolean")
      fail("is_current: ожидается true/false");
    const evidence = text(state.approval_evidence, 4000),
      approvedAt = date(state.approved_at);
    if (Object.hasOwn(state, "approved_at") && (!approvedAt || !evidence))
      fail("Согласованию нужны время и основание");
    if (!Object.hasOwn(state, "is_current") && !approvedAt)
      fail("Нужно указать актуальность или согласование");
    if (event.type !== (approvedAt ? "document.approved" : "document.current"))
      fail("Тип события должен соответствовать изменению документа");
    if (approvedAt && new Date(approvedAt) > Date.now())
      fail("Согласование не может быть в будущем");
    const result = await applyExternal(
      pool,
      taskId,
      event,
      null,
      { docId, state },
      async (c, r) => {
        const found = await c.query(
          "SELECT id,title,version,is_current,approved_at,approval_evidence FROM task_documents WHERE id=$1 AND task_id=$2 FOR UPDATE",
          [docId, taskId],
        );
        if (!found.rows.length) fail("Документ не найден в этой задаче", 404);
        if (state.is_current)
          await c.query(
            "UPDATE task_documents SET is_current=false WHERE task_id=$1 AND kind=(SELECT kind FROM task_documents WHERE id=$2)",
            [taskId, docId],
          );
        const sets = [],
          values = [docId];
        const add = (k, v) => {
          values.push(v);
          sets.push(`${k}=$${values.length}`);
        };
        if (state.is_current !== undefined) add("is_current", state.is_current);
        if (approvedAt) {
          add("approved_at", approvedAt);
          add("approval_evidence", evidence);
        }
        const changes = {
          document: {
            old: null,
            new: `#${docId} · ${found.rows[0].title} v${found.rows[0].version}`,
          },
        };
        for (const key of ["is_current", "approved_at", "approval_evidence"])
          if (Object.hasOwn(state, key))
            changes[key] = { old: found.rows[0][key], new: state[key] };
        await c.query("UPDATE task_events SET changes=$1 WHERE id=$2", [
          JSON.stringify(changes),
          r.event.id,
        ]);
        r.event.changes = changes;
        return {
          document: (
            await c.query(
              `UPDATE task_documents SET ${sets.join(",")} WHERE id=$1 RETURNING ${DOCUMENT_COLUMNS}`,
              values,
            )
          ).rows[0],
        };
      },
    );
    if (result.duplicate)
      result.document = (
        await pool.query(
          `SELECT ${DOCUMENT_COLUMNS} FROM task_documents WHERE id=$1 AND task_id=$2`,
          [docId, taskId],
        )
      ).rows[0];
    res.json(result);
  });
  app.post("/tasks/:id/documents/:docId/state", requireEditor, documentMark);
  app.post(
    "/integrations/agent/tasks/:id/documents/:docId/state",
    agent,
    documentMark,
  );
  const download = handler(async (req, res) => {
    const doc = (
      await pool.query(
        "SELECT file_bytes,file_name,mime_type FROM task_documents WHERE id=$1 AND task_id=$2",
        [positiveId(req.params.docId), positiveId(req.params.id)],
      )
    ).rows[0];
    if (!doc?.file_bytes)
      fail("Локальный файл не найден; используйте ссылку на источник", 404);
    res.set({
      "Content-Type": doc.mime_type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
    });
    res.send(Buffer.from(doc.file_bytes));
  });
  app.get("/tasks/:id/documents/:docId/download", requireUser, download);
  app.get(
    "/integrations/agent/tasks/:id/documents/:docId/download",
    agent,
    download,
  );

  app.get(
    "/tasks/:id/stages",
    requireUser,
    handler(async (req, res) => {
      const task = await getTask(pool, req.params.id);
      res.json(stageDurations(task, await readEvents(pool, task.id)));
    }),
  );
  app.get(
    "/attention/settings",
    requireUser,
    handler(async (req, res) =>
      res.json(
        (
          await pool.query(
            "SELECT stage_threshold_days FROM tracker_preferences WHERE user_id=$1",
            [req.user.id],
          )
        ).rows[0]?.stage_threshold_days || {},
      ),
    ),
  );
  app.put(
    "/attention/settings",
    requireEditor,
    handler(async (req, res) => {
      const values = req.body;
      if (!values || typeof values !== "object" || Array.isArray(values))
        fail("Ожидается объект порогов");
      for (const [k, v] of Object.entries(values))
        if (STAGES[k] !== "active" || !Number.isInteger(v) || v < 1 || v > 3650)
          fail("Порог активного этапа: от 1 до 3650 дней");
      await pool.query(
        "INSERT INTO tracker_preferences(user_id,stage_threshold_days) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET stage_threshold_days=$2",
        [req.user.id, JSON.stringify(values)],
      );
      res.json(values);
    }),
  );
  app.get(
    "/attention",
    requireUser,
    handler(async (req, res) => {
      const tasks = (await pool.query("SELECT * FROM tasks ORDER BY id")).rows;
      const thresholds =
        (
          await pool.query(
            "SELECT stage_threshold_days FROM tracker_preferences WHERE user_id=$1",
            [req.user.id],
          )
        ).rows[0]?.stage_threshold_days || {};
      const snoozes = (
        await pool.query(
          "SELECT * FROM attention_snoozes WHERE user_id=$1 AND until_at>now()",
          [req.user.id],
        )
      ).rows;
      const items = [];
      for (const task of tasks) {
        const metrics = stageDurations(task, await readEvents(pool, task.id));
        const reasons = attentionReasons(task, metrics, thresholds).map(
          (reason) => ({
            ...reason,
            snoozed_until:
              snoozes.find(
                (s) =>
                  String(s.task_id) === String(task.id) &&
                  s.reason_key === reason.key,
              )?.until_at || null,
          }),
        );
        if (reasons.length)
          items.push({
            task_id: task.id,
            title: task.title,
            status: task.status,
            assignee_user_id: task.assignee_user_id,
            waiting_for: task.waiting_for,
            next_action_text: task.next_action_text,
            reasons,
          });
      }
      res.json(items);
    }),
  );
  app.post(
    "/tasks/:id/attention/snooze",
    requireUser,
    handler(async (req, res) => {
      const id = positiveId(req.params.id),
        key = text(req.body.reason_key, 1000),
        until = date(req.body.until_at);
      if (!key || !until || new Date(until) <= Date.now())
        fail("Укажите причину и будущую дату");
      await getTask(pool, id);
      await pool.query(
        "INSERT INTO attention_snoozes(user_id,task_id,reason_key,until_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,task_id,reason_key) DO UPDATE SET until_at=$4",
        [req.user.id, id, key, until],
      );
      res.json({ ok: true });
    }),
  );
}
