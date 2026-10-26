import {
  fail,
  normalizePatch,
  positiveId,
  fingerprint,
  normalizeStatus,
  requireAutomation,
} from "./tracker-domain.js";

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}
export async function getTask(client, id, lock = false) {
  const result = await client.query(
    `SELECT * FROM tasks WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [positiveId(id)],
  );
  if (!result.rows.length) fail("Задача не найдена", 404);
  const task = result.rows[0];
  const tags = await client.query(
    "SELECT tg.id,tg.title,tg.color FROM task_tags tt JOIN tags tg ON tg.id=tt.tag_id WHERE tt.task_id=$1 ORDER BY tg.title",
    [id],
  );
  return { ...task, status: normalizeStatus(task.status), tags: tags.rows };
}
export async function insertEvent(client, taskId, event, changes = {}) {
  if (event.corrects_event_id) {
    const original = await client.query(
      "SELECT id FROM task_events WHERE id=$1 AND task_id=$2",
      [event.corrects_event_id, taskId],
    );
    if (!original.rows.length)
      fail("Исправляемое событие не принадлежит задаче");
  }
  const result = await client.query(
    `INSERT INTO task_events
    (task_id,source,external_id,fingerprint,type,summary,changes,actor_name,recorder,occurred_at,source_url,corrects_event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      taskId,
      event.source,
      event.external_id || null,
      event.fingerprint || null,
      event.type,
      event.summary,
      JSON.stringify(changes),
      event.actor_name || null,
      event.recorder,
      event.occurred_at || null,
      event.source_url || null,
      event.corrects_event_id || null,
    ],
  );
  return result.rows[0];
}
export async function checkDuplicate(client, source, externalId, hash) {
  // Serializes equal idempotency keys across tasks without holding a global lock.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${source}:${externalId}`,
  ]);
  const r = await client.query(
    "SELECT * FROM task_events WHERE source=$1 AND external_id=$2",
    [source, externalId],
  );
  if (!r.rows.length) return null;
  if (r.rows[0].fingerprint !== hash)
    fail("Этот external_id уже использован с другим содержимым", 409);
  return r.rows[0];
}
const comparable = (value) =>
  value instanceof Date
    ? value.toISOString()
    : value == null
      ? null
      : String(value);
export async function writeTask(
  client,
  id,
  body,
  actor,
  { creating = false, event: external = null } = {},
) {
  const before = creating ? {} : await getTask(client, id, true);
  if (external && external.source !== "simpletracker") {
    requireAutomation(before);
    if (Object.hasOwn(body, "automation_locked")) fail("Агент не может менять ручной флаг; финальное согласование передаётся через analysis/events", 400);
  }
  const patch = normalizePatch(body, before, creating);
  if (Object.hasOwn(patch, "automation_locked")) patch.automation_locked_at = patch.automation_locked ? (before.automation_locked_at || new Date().toISOString()) : null;
  if (patch.assignee_user_id) {
    const u = await client.query(
      "SELECT id FROM users WHERE id=$1 AND COALESCE(is_active,true)=true FOR SHARE",
      [patch.assignee_user_id],
    );
    if (!u.rows.length) fail("Исполнитель не найден или неактивен");
  }
  let tags;
  if (patch.tags) {
    tags = (
      await client.query(
        "SELECT id,title FROM tags WHERE title=ANY($1::text[]) ORDER BY title",
        [patch.tags],
      )
    ).rows;
    if (tags.length !== patch.tags.length) fail("Один из тегов не найден");
  }
  const fields = Object.entries(patch).filter(([k]) => k !== "tags");
  if (creating) {
    if (id != null) fields.unshift(["id", positiveId(id)]);
    if (!Object.hasOwn(patch, "status")) fields.push(["status", "не в работе"]);
    if (!Object.hasOwn(patch, "priority")) fields.push(["priority", "low"]);
    fields.push(
      ["created_by", actor?.id || null],
      ["updated_by", actor?.id || null],
    );
    const r = await client.query(
      `INSERT INTO tasks (${fields.map(([k]) => k).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
      fields.map(([, v]) => v),
    );
    id = r.rows[0].id;
  } else if (fields.length || tags) {
    fields.push(["updated_by", actor?.id || null]);
    await client.query(
      `UPDATE tasks SET ${fields.map(([k], i) => `${k}=$${i + 1}`).join(",")},updated_at=now() WHERE id=$${fields.length + 1}`,
      [...fields.map(([, v]) => v), id],
    );
  }
  if (tags) {
    await client.query("DELETE FROM task_tags WHERE task_id=$1", [id]);
    for (const tag of tags)
      await client.query(
        "INSERT INTO task_tags(task_id,tag_id) VALUES($1,$2)",
        [id, tag.id],
      );
  }
  const after = await getTask(client, id);
  const changes = {};
  for (const [key] of fields) {
    if (["id", "created_by", "updated_by"].includes(key)) continue;
    if (comparable(before[key]) !== comparable(after[key]))
      changes[key] = { old: before[key] ?? null, new: after[key] ?? null };
  }
  const oldTags = (before.tags || []).map((t) => t.title).sort(),
    newTags = after.tags.map((t) => t.title).sort();
  if (JSON.stringify(oldTags) !== JSON.stringify(newTags))
    changes.tags = { old: oldTags, new: newTags };
  let event = null;
  if (creating || Object.keys(changes).length || external) {
    event = await insertEvent(
      client,
      id,
      external || {
        source: "simpletracker",
        type: creating ? "task.created" : "task.updated",
        summary: creating ? "Задача создана" : "Поля задачи изменены",
        recorder: `user:${actor.id}`,
        actor_name: actor.name,
        occurred_at: new Date().toISOString(),
      },
      changes,
    );
    // Preserve the existing API and mail journal; unified history excludes these duplicates.
    for (const field of ["status", "start_at", "due_at"])
      if (changes[field]) {
        await client.query(
          "INSERT INTO task_change_log(task_id,field_name,old_value,new_value,event_id) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            field,
            comparable(changes[field].old),
            comparable(changes[field].new),
            event.id,
          ],
        );
      }
  }
  return { task: after, event };
}
export async function setTaskTag(client, taskId, tagId, adding, actor) {
  const task = await getTask(client, taskId, true);
  const tag = (
    await client.query("SELECT title FROM tags WHERE id=$1", [
      positiveId(tagId),
    ])
  ).rows[0];
  if (!tag) fail("Тег не найден", 404);
  const tags = task.tags.map((t) => t.title).filter((t) => t !== tag.title);
  if (adding) tags.push(tag.title);
  return writeTask(client, taskId, { tags }, actor);
}
export async function readEvents(client, taskId) {
  const result = await client.query(
    `SELECT id::text,source,type,summary,changes,actor_name,recorder,occurred_at,received_at,source_url,corrects_event_id
    FROM task_events WHERE task_id=$1
    UNION ALL
    SELECT 'legacy:'||id,'legacy','task.updated','Изменение в прежнем журнале',
      jsonb_build_object(field_name,jsonb_build_object('old',old_value,'new',new_value)),
      NULL,'legacy',changed_at,changed_at,NULL,NULL
    FROM task_change_log WHERE task_id=$1 AND event_id IS NULL
    ORDER BY received_at DESC,id DESC`,
    [taskId],
  );
  return result.rows;
}
export async function applyExternal(pool, taskId, event, changes, extra, work) {
  const hash = fingerprint({
    task_id: String(taskId),
    event,
    changes: changes || null,
    extra: extra || null,
  });
  return transaction(pool, async (client) => {
    const duplicate = await checkDuplicate(
      client,
      event.source,
      event.external_id,
      hash,
    );
    if (duplicate) return { event: duplicate, duplicate: true };
    const before = await getTask(client, taskId, true);
    if (event.source !== "simpletracker") requireAutomation(before);
    if (event.type === "task.paused" && before.status === "завершена")
      fail("Завершённую задачу нельзя поставить на паузу");
    const result = changes
      ? await writeTask(client, taskId, changes, null, {
          event: { ...event, fingerprint: hash },
        })
      : {
          task: before,
          event: await insertEvent(client, taskId, {
            ...event,
            fingerprint: hash,
          }),
        };
    const additional = work ? await work(client, result) : {};
    return { ...result, ...additional, duplicate: false };
  });
}
