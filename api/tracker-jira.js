import {
  fail,
  positiveId,
  text,
  url,
  date,
  fingerprint,
} from "./tracker-domain.js";
import {
  transaction,
  getTask,
  checkDuplicate,
  insertEvent,
} from "./tracker-store.js";

export function jiraSnapshot(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail("Ожидается объект снимка Jira");
  const issue_key = text(body.issue_key, 100);
  if (!issue_key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issue_key))
    fail("Некорректный ключ Jira");
  const checked_at = date(body.checked_at);
  if (!checked_at || new Date(checked_at) > Date.now() + 60000)
    fail("Нужно время успешного получения снимка Jira");
  const issue_id = text(body.issue_id, 100),
    status = text(body.status, 500);
  if (!issue_id || !status || !Object.hasOwn(body, "assignee"))
    fail(
      "Снимок должен содержать issue_id, status и assignee (может быть null)",
    );
  const issueUrl = url(body.url);
  if (!issueUrl) fail("Нужна ссылка Jira");
  const history = body.history || [];
  if (!Array.isArray(history) || history.length > 1000)
    fail("Не более 1000 событий Jira за запрос");
  return {
    issue_key,
    issue_id,
    url: issueUrl,
    status,
    assignee: text(body.assignee, 500),
    checked_at,
    history_complete: body.history_complete === true,
    history: history.map((h) => {
      const id = text(h.id, 200),
        occurred_at = date(h.occurred_at),
        changes = {};
      if (!id || !occurred_at) fail("Событие Jira требует ID и времени");
      for (const key of ["status", "assignee"])
        if (h.changes?.[key])
          changes[key] = {
            old: text(h.changes[key].old, 500),
            new: text(h.changes[key].new, 500),
          };
      if (!Object.keys(changes).length)
        fail("В истории Jira нет изменений статуса/исполнителя");
      return { id, occurred_at, changes, actor_name: text(h.actor_name, 500) };
    }),
  };
}
export async function saveJiraSnapshot(pool, taskId, body, recorder) {
  const snapshot = jiraSnapshot(body);
  return transaction(pool, async (c) => {
    await getTask(c, taskId, true);
    const old = (
      await c.query("SELECT * FROM task_jira WHERE task_id=$1", [taskId])
    ).rows[0];
    if (old?.issue_id && old.issue_id !== snapshot.issue_id)
      fail("К задаче уже привязана другая Jira-задача", 409);
    if (
      old?.checked_at &&
      new Date(old.checked_at).getTime() ===
        new Date(snapshot.checked_at).getTime() &&
      ["status", "assignee", "issue_key", "url"].some(
        (k) => old[k] !== snapshot[k],
      )
    )
      fail("Снимок с этим checked_at уже содержит другие данные", 409);
    for (const h of snapshot.history) {
      const key = `${snapshot.issue_id}:history:${h.id}`,
        hash = fingerprint(h);
      if (!(await checkDuplicate(c, "jira", key, hash)))
        await insertEvent(
          c,
          taskId,
          {
            source: "jira",
            external_id: key,
            fingerprint: hash,
            type: "jira.changed",
            summary: "Изменение в Jira",
            actor_name: h.actor_name,
            recorder,
            occurred_at: h.occurred_at,
            source_url: snapshot.url,
          },
          h.changes,
        );
    }
    if (
      old?.checked_at &&
      new Date(old.checked_at) > new Date(snapshot.checked_at)
    )
      return { stale_snapshot_ignored: true };
    // A snapshot is an observation, never an invented transition time.
    const changes = {};
    if (old?.checked_at)
      for (const k of ["status", "assignee"])
        if (old[k] !== snapshot[k])
          changes[k] = { old: old[k], new: snapshot[k] };
    if (Object.keys(changes).length && !snapshot.history_complete) {
      const key = `${snapshot.issue_id}:snapshot:${snapshot.checked_at}`,
        hash = fingerprint({ taskId, changes });
      if (!(await checkDuplicate(c, "jira", key, hash)))
        await insertEvent(
          c,
          taskId,
          {
            source: "jira",
            external_id: key,
            fingerprint: hash,
            type: "jira.observed",
            summary: "Изменение обнаружено при сверке",
            recorder,
            source_url: snapshot.url,
          },
          changes,
        );
    }
    const r = await c.query(
      `INSERT INTO task_jira(task_id,issue_id,issue_key,url,status,assignee,checked_at,attempted_at,history_complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8) ON CONFLICT(task_id) DO UPDATE SET issue_id=EXCLUDED.issue_id,issue_key=EXCLUDED.issue_key,url=EXCLUDED.url,status=EXCLUDED.status,assignee=EXCLUDED.assignee,checked_at=EXCLUDED.checked_at,attempted_at=now(),error=NULL,history_complete=EXCLUDED.history_complete RETURNING *`,
      [
        positiveId(taskId),
        snapshot.issue_id,
        snapshot.issue_key,
        snapshot.url,
        snapshot.status,
        snapshot.assignee,
        snapshot.checked_at,
        snapshot.history_complete,
      ],
    );
    return r.rows[0];
  });
}
