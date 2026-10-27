import crypto from "node:crypto";

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (message, status = 400) => {
  throw new RequestError(status, message);
};
export const STAGES = {
  "не в работе": "queue",
  "готова к разработке": "queue",
  "в аналитике": "active",
  оценка: "active",
  разработка: "active",
  ревью: "active",
  "на согласовании": "waiting",
  завершена: "done",
};
export const normalizeStatus = (value) =>
  ({
    new: "не в работе",
    in_progress: "разработка",
    done: "завершена",
    review: "ревью",
  })[value] || value;
export const automationBlock = (task) => task.automation_locked ? "approved_manual" :
  ["оценка", "готова к разработке", "разработка", "завершена"].includes(normalizeStatus(task.status)) ? "outside_analysis" : null;
export function requireAutomation(task) {
  if (automationBlock(task)) fail("automation_disabled: задача согласована или вышла из аналитического процесса", 409);
}
// Route-specific exception: publish an approved original, not resume automation.
export const approvedDocumentBlock = (task) => task.automation_locked ? "approved_manual" :
  normalizeStatus(task.status) === "готова к разработке" ? null : automationBlock(task);
export function requireApprovedDocumentWrite(task) {
  if (approvedDocumentBlock(task)) fail("automation_disabled: запись согласованного документа заблокирована", 409);
}
export function positiveId(value) {
  if (!["string", "number"].includes(typeof value)) fail("Некорректный ID");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail("Некорректный ID");
  return String(n);
}
export function text(value, max = 2000) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max)
    fail(`Ожидается текст длиной до ${max} символов`);
  return value.trim() || null;
}
export function date(value) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    fail("Дата должна быть YYYY-MM-DD или ISO с часовым поясом");
  const d = new Date(value);
  const ymd = value.slice(0, 10);
  if (
    !Number.isFinite(d.getTime()) ||
    new Date(ymd).toISOString().slice(0, 10) !== ymd
  )
    fail("Некорректная дата");
  return d.toISOString();
}
export function url(value) {
  const s = text(value, 4000);
  if (!s) return null;
  try {
    if (!["https:", "http:"].includes(new URL(s).protocol))
      fail("Ссылка должна начинаться с https:// или http://");
  } catch {
    fail("Некорректная ссылка");
  }
  return s;
}
export function normalizePatch(body, before = {}, creating = false) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail("Ожидается объект задачи");
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (["id", "created_by", "updated_by"].includes(key)) continue;
    if (
      [
        "title",
        "description",
        "email_thread",
        "document_history",
        "next_action_text",
        "waiting_for",
      ].includes(key)
    )
      out[key] = text(value, key === "title" ? 1000 : 100000);
    else if (key === "status") {
      out.status = normalizeStatus(value);
      if (!Object.hasOwn(STAGES, out.status)) fail("Неизвестный статус");
    } else if (key === "priority") {
      if (!["low", "medium", "high"].includes(value))
        fail("Неизвестный приоритет");
      out.priority = value;
    } else if (key === "assignee_user_id")
      out[key] = value == null || value === "" ? null : positiveId(value);
    else if (
      ["start_at", "due_at", "next_action_at", "reply_due_at"].includes(key)
    )
      out[key] = date(value);
    else if (key === "link_url") out[key] = url(value);
    else if (key === "deadline_confirmed" || key === "automation_locked") {
      if (typeof value !== "boolean")
        fail(`${key}: ожидается true/false`);
      out[key] = value;
    } else if (["approved_hours", "spent_hours"].includes(key)) {
      if (value == null || value === "") out[key] = null;
      else {
        if (
          !["number", "string"].includes(typeof value) ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0 ||
          Number(value) > 1000000
        )
          fail("Часы должны быть числом от 0 до 1000000");
        out[key] = Number(value);
      }
    } else if (key === "tags") {
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some((v) => !text(v, 200))
      )
        fail("Некорректные теги");
      out.tags = [...new Set(value.map((v) => v.trim()))].sort();
    } else fail(`Неизвестное поле: ${key}`);
  }
  if ((creating || Object.hasOwn(out, "title")) && !out.title)
    fail("Введите название задачи");
  const next = { ...before, ...out };
  if (
    next.start_at &&
    next.due_at &&
    new Date(next.start_at) > new Date(next.due_at)
  )
    fail("Начало не может быть позже окончания");
  if (next.deadline_confirmed && !next.due_at)
    fail("Для подтверждённого срока нужна дата окончания");
  return out;
}
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
export const fingerprint = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
export const EVENT_TYPES = [
  "note",
  "task.updated",
  "task.paused",
  "task.resumed",
  "document.received",
  "document.sent_for_approval",
  "document.comments_received",
  "document.approved",
  "document.current",
  "event.corrected",
  "action.scheduled",
  "action.completed",
];
export function externalEvent(body, source, recorder) {
  if (!body || !EVENT_TYPES.includes(body.type))
    fail("Неизвестный тип события");
  const external_id = text(body.external_id, 500);
  const summary = text(body.summary, 10000);
  if (!external_id || !summary) fail("Нужны external_id и summary");
  const occurred_at = date(body.occurred_at);
  if (
    ["task.paused", "task.resumed"].includes(body.type) &&
    (!occurred_at || new Date(occurred_at) > Date.now())
  )
    fail("Для паузы/возобновления нужно фактическое время действия");
  if (body.type === "event.corrected" && !body.corrects_event_id)
    fail("Укажите corrects_event_id исправляемого события");
  return {
    source,
    recorder,
    external_id,
    type: body.type,
    summary,
    actor_name: text(body.actor_name, 500),
    occurred_at,
    source_url: url(body.source_url),
    corrects_event_id:
      body.corrects_event_id == null
        ? null
        : positiveId(body.corrects_event_id),
  };
}

// Calendar durations. Unknown intervals remain unknown; snapshots are not transitions.
export function stageDurations(task, events, now = new Date()) {
  const local = events.filter((e) => e.source !== "jira");
  const compare = (a, b) =>
    new Date(a.occurred_at) - new Date(b.occurred_at) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  const transitions = events
    .filter((e) => e.source !== "jira" && e.changes?.status && e.occurred_at)
    .sort(compare);
  const pauses = [];
  let pauseStart = null,
    pauseGaps = 0;
  const pauseEvents = local
    .filter(
      (e) =>
        e.occurred_at &&
        (["task.paused", "task.resumed"].includes(e.type) ||
          normalizeStatus(e.changes?.status?.new) === "завершена"),
    )
    .sort(compare);
  for (const e of pauseEvents) {
    const at = new Date(e.occurred_at).getTime();
    if (at > now.getTime()) continue;
    if (e.type === "task.paused") {
      if (pauseStart === null) pauseStart = at;
    } else if (pauseStart !== null) {
      pauses.push([pauseStart, at]);
      pauseStart = null;
    } else if (e.type === "task.resumed") pauseGaps++;
  }
  if (pauseStart !== null) pauses.push([pauseStart, now.getTime()]);
  const pausedWithin = (start, end) =>
    pauses.reduce(
      (sum, [a, b]) => sum + Math.max(0, Math.min(end, b) - Math.max(start, a)),
      0,
    );
  const totals = {
    queue: 0,
    active: 0,
    waiting: 0,
    paused: pausedWithin(0, now.getTime()),
    done: 0,
  };
  const stages = {};
  let firstActive = null,
    firstDevelopment = null,
    currentSince = null,
    observedSince = null;
  let gaps = pauseGaps;
  let currentElapsedMilliseconds = null;
  const untimed = local.filter((e) => e.changes?.status && !e.occurred_at);
  for (let i = 0; i < transitions.length; i++) {
    const event = transitions[i],
      nextEvent = transitions[i + 1];
    const status = normalizeStatus(event.changes.status.new),
      group = STAGES[status];
    const start = new Date(event.occurred_at),
      end = nextEvent ? new Date(nextEvent.occurred_at) : now;
    if (start > now) continue;
    observedSince ??= start.toISOString();
    if (group === "active") firstActive ??= start.toISOString();
    if (status === "разработка") firstDevelopment ??= start.toISOString();
    const continuity =
      (nextEvent
        ? normalizeStatus(nextEvent.changes.status.old) === status
        : normalizeStatus(task.status) === status) &&
      !untimed.some(
        (e) =>
          !e.received_at ||
          (new Date(e.received_at) >= start && new Date(e.received_at) <= end),
      );
    if (!continuity) {
      gaps++;
      continue;
    }
    const ms = Math.max(
      0,
      Math.min(end.getTime(), now.getTime()) -
        start.getTime() -
        pausedWithin(start.getTime(), Math.min(end.getTime(), now.getTime())),
    );
    if (group) totals[group] += ms;
    stages[status] ??= { milliseconds: 0, entries: 0 };
    stages[status].milliseconds += ms;
    stages[status].entries++;
    if (!nextEvent) {
      currentSince = start.toISOString();
      currentElapsedMilliseconds = ms;
    }
  }
  const complete =
    transitions[0]?.type === "task.created" && !gaps && !untimed.length;
  return {
    totals,
    stages,
    currentSince,
    observedSince,
    firstActive,
    firstDevelopment,
    complete,
    gaps,
    paused: pauseStart !== null && normalizeStatus(task.status) !== "завершена",
    pauseSince: pauseStart === null ? null : new Date(pauseStart).toISOString(),
    currentElapsedMilliseconds,
    ageMilliseconds: task.created_at
      ? Math.max(0, now - new Date(task.created_at))
      : null,
    beforeFirstActiveMilliseconds:
      complete && firstActive
        ? new Date(firstActive) - new Date(observedSince)
        : null,
  };
}
export function attentionReasons(
  task,
  metrics,
  thresholds = {},
  now = new Date(),
) {
  if (automationBlock(task)) return [];
  const reasons = [],
    active =
      STAGES[normalizeStatus(task.status)] === "active" && !metrics.paused;
  const add = (code, label, since, version) =>
    reasons.push({ code, label, since, key: `${code}:${version}` });
  if (task.deadline_confirmed && task.due_at) {
    // Plan dates are inclusive Moscow calendar days, not midnight deadlines.
    const end = new Date(
      `${new Date(task.due_at).toISOString().slice(0, 10)}T23:59:59.999+03:00`,
    );
    if (end < now)
      add(
        "deadline",
        "Прошёл подтверждённый срок",
        end.toISOString(),
        task.due_at,
      );
  }
  if (active && !task.assignee_user_id)
    add(
      "assignee",
      "В активном этапе нет ответственного",
      metrics.currentSince,
      `${task.status}:${metrics.currentSince || "unknown"}`,
    );
  const threshold = Number(thresholds[task.status]);
  if (
    active &&
    threshold > 0 &&
    metrics.currentSince &&
    (metrics.currentElapsedMilliseconds ??
      now - new Date(metrics.currentSince)) >
      threshold * 86400000
  )
    add(
      "stage",
      `В этапе больше ${threshold} дн. без пауз`,
      metrics.currentSince,
      `${task.status}:${metrics.currentSince}:${threshold}`,
    );
  for (const [field, label] of [
    ["next_action_at", "Наступил срок следующего действия"],
    ["reply_due_at", "Ждём ответ дольше срока"],
  ]) {
    if (task[field] && new Date(task[field]) < now)
      add(
        field,
        label,
        new Date(task[field]).toISOString(),
        `${task[field]}:${task.next_action_text || task.waiting_for || ""}`,
      );
  }
  return reasons;
}
