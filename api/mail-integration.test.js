import assert from "node:assert/strict";
import test from "node:test";

import { createMailIntegrationHandler } from "./mail-integration.js";

const VALID_TOKEN = "test-mail-integration-token-placeholder";

function clone(value) {
  return structuredClone(value);
}

class FakePool {
  constructor({ tasks = [], users = [] } = {}) {
    this.tasks = new Map(tasks.map((task) => [Number(task.id), clone(task)]));
    this.users = new Map(users.map((user) => [Number(user.id), clone(user)]));
    this.processedEvents = new Map();
    this.nextProcessedEventId = 1;
    this.connectCount = 0;
  }

  snapshot() {
    return {
      tasks: clone(Array.from(this.tasks.entries())),
      users: clone(Array.from(this.users.entries())),
      processedEvents: clone(Array.from(this.processedEvents.entries())),
      nextProcessedEventId: this.nextProcessedEventId,
    };
  }

  restore(snapshot) {
    this.tasks = new Map(snapshot.tasks);
    this.users = new Map(snapshot.users);
    this.processedEvents = new Map(snapshot.processedEvents);
    this.nextProcessedEventId = snapshot.nextProcessedEventId;
  }

  async connect() {
    this.connectCount += 1;
    return new FakeClient(this);
  }
}

class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.transactionSnapshot = null;
  }

  async query(text, params = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (sql === "BEGIN") {
      this.transactionSnapshot = this.pool.snapshot();
      return { rowCount: null, rows: [] };
    }
    if (sql === "COMMIT") {
      this.transactionSnapshot = null;
      return { rowCount: null, rows: [] };
    }
    if (sql === "ROLLBACK") {
      if (this.transactionSnapshot) this.pool.restore(this.transactionSnapshot);
      this.transactionSnapshot = null;
      return { rowCount: null, rows: [] };
    }

    if (sql.startsWith("INSERT INTO processed_mail_events")) {
      const [normalizedMessageId, originalMessageId, taskId, direction, eventAt] = params;
      if (this.pool.processedEvents.has(normalizedMessageId)) {
        return { rowCount: 0, rows: [] };
      }
      const row = {
        id: this.pool.nextProcessedEventId++,
        normalized_message_id: normalizedMessageId,
        original_message_id: originalMessageId,
        task_id: taskId,
        direction,
        event_at: eventAt,
        result: "manual_review",
      };
      this.pool.processedEvents.set(normalizedMessageId, row);
      return { rowCount: 1, rows: [{ id: row.id }] };
    }

    if (sql.startsWith("SELECT task_id, result FROM processed_mail_events")) {
      const row = this.pool.processedEvents.get(params[0]);
      return row
        ? { rowCount: 1, rows: [{ task_id: row.task_id, result: row.result }] }
        : { rowCount: 0, rows: [] };
    }

    if (sql.startsWith("SELECT id, status, due_at, assignee_user_id FROM tasks")) {
      const row = this.pool.tasks.get(Number(params[0]));
      return row ? { rowCount: 1, rows: [clone(row)] } : { rowCount: 0, rows: [] };
    }

    if (sql.startsWith("SELECT id FROM users")) {
      const user = this.pool.users.get(Number(params[0]));
      const active = user && user.is_active !== false;
      return active ? { rowCount: 1, rows: [{ id: user.id }] } : { rowCount: 0, rows: [] };
    }

    if (sql.startsWith("UPDATE tasks SET")) {
      const taskId = Number(params.at(-1));
      const task = this.pool.tasks.get(taskId);
      assert.ok(task, `fake task ${taskId} must exist before UPDATE`);
      const [status, dueAt, historyLine] = params;
      task.status = status;
      task.due_at = dueAt;
      task.document_history =
        task.document_history == null || String(task.document_history).trim() === ""
          ? historyLine
          : `${task.document_history}\n${historyLine}`;
      if (sql.includes("assignee_user_id = $4")) task.assignee_user_id = params[3];
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith("UPDATE processed_mail_events SET result")) {
      const eventId = Number(params[0]);
      const row = Array.from(this.pool.processedEvents.values()).find((item) => item.id === eventId);
      assert.ok(row, `fake processed event ${eventId} must exist before UPDATE`);
      row.result = sql.includes("'updated'") ? "updated" : "manual_review";
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in fake client: ${sql}`);
  }

  release() {}
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke({ pool, body, token = VALID_TOKEN, configuredToken = VALID_TOKEN }) {
  const handler = createMailIntegrationHandler({ pool, mailIntegrationToken: configuredToken });
  const req = {
    body,
    get(name) {
      return name.toLowerCase() === "x-mail-integration-token" ? token : undefined;
    },
  };
  const res = responseRecorder();
  await handler(req, res);
  return res;
}

function validIncoming(overrides = {}) {
  return {
    message_id: "<incoming@example.test>",
    task_id: 13990,
    direction: "incoming",
    event_at: "2026-08-11T09:15:00Z",
    ...overrides,
  };
}

function validOutgoing(overrides = {}) {
  return {
    message_id: "<outgoing@example.test>",
    task_id: 13990,
    direction: "outgoing",
    event_at: "2026-08-11T09:15:00Z",
    sender_name: "Имя Фамилия Отчество",
    ...overrides,
  };
}

test("rejects a wrong token and a missing configured token", async () => {
  const pool = new FakePool();
  const wrong = await invoke({ pool, body: validIncoming(), token: "wrong-token" });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.body, { error: "unauthorized" });

  const missingConfig = await invoke({
    pool,
    body: validIncoming(),
    configuredToken: "",
  });
  assert.equal(missingConfig.statusCode, 401);
  assert.equal(pool.connectCount, 0);
});

test("rejects invalid payloads and unknown task fields", async () => {
  const pool = new FakePool();
  const invalidDate = await invoke({
    pool,
    body: validIncoming({ event_at: "2026-08-11" }),
  });
  assert.equal(invalidDate.statusCode, 400);
  assert.equal(invalidDate.body.error, "invalid_payload");

  const unknownField = await invoke({
    pool,
    body: validOutgoing({ approved_hours: 100 }),
  });
  assert.equal(unknownField.statusCode, 400);
  assert.match(unknownField.body.details.join(" "), /approved_hours/);

  const incomingAssignee = await invoke({
    pool,
    body: validIncoming({ assignee_user_id: 7 }),
  });
  assert.equal(incomingAssignee.statusCode, 400);

  const missingOutgoingSender = await invoke({
    pool,
    body: validOutgoing({ sender_name: "" }),
  });
  assert.equal(missingOutgoingSender.statusCode, 400);
  assert.match(missingOutgoingSender.body.details.join(" "), /sender_name/);
  assert.equal(pool.connectCount, 0);
});

test("returns 404 and rolls back deduplication when the task does not exist", async () => {
  const pool = new FakePool();
  const res = await invoke({ pool, body: validIncoming() });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "task_not_found" });
  assert.equal(pool.processedEvents.size, 0);
});

test("processes incoming from approval atomically with Moscow time and +7 calendar days", async () => {
  const pool = new FakePool({
    tasks: [
      {
        id: 13990,
        status: "на согласовании",
        due_at: "2026-08-14T00:00:00.000Z",
        assignee_user_id: 4,
        document_history: "Предыдущая запись",
        approved_hours: 12,
        spent_hours: 5.5,
      },
    ],
  });

  const res = await invoke({
    pool,
    body: validIncoming({ event_at: "2026-08-11T21:15:00Z" }),
  });
  const task = pool.tasks.get(13990);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, "updated");
  assert.equal(res.body.duplicate, false);
  assert.equal(task.status, "в аналитике");
  assert.equal(task.due_at, "2026-08-19T00:00:00.000Z");
  assert.equal(
    task.document_history,
    "Предыдущая запись\n12.08.2026 00:15 - документ получен с комментариями от заказчика"
  );
  assert.equal(task.assignee_user_id, 4);
  assert.equal(task.approved_hours, 12);
  assert.equal(task.spent_hours, 5.5);
  assert.deepEqual(res.body.changes.status, { old: "на согласовании", new: "в аналитике" });
  assert.deepEqual(res.body.changes.due_at, {
    old: "2026-08-14T00:00:00.000Z",
    new: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(Object.hasOwn(res.body.changes, "assignee_user_id"), false);
});

test("returns manual_review for incoming in another status without changing the task", async () => {
  const originalTask = {
    id: 13990,
    status: "в аналитике",
    due_at: "2026-08-14T00:00:00.000Z",
    assignee_user_id: 4,
    document_history: "История",
    approved_hours: 10,
    spent_hours: 2,
  };
  const pool = new FakePool({ tasks: [originalTask] });

  const res = await invoke({ pool, body: validIncoming() });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    result: "manual_review",
    duplicate: false,
    task_id: 13990,
    changes: {},
  });
  assert.deepEqual(pool.tasks.get(13990), originalTask);
});

test("processes outgoing with an active assignee", async () => {
  const pool = new FakePool({
    tasks: [
      {
        id: 13990,
        status: "в аналитике",
        due_at: null,
        assignee_user_id: 4,
        document_history: null,
        approved_hours: 8,
        spent_hours: 3,
      },
    ],
    users: [{ id: 7, is_active: true }],
  });

  const res = await invoke({
    pool,
    body: validOutgoing({ assignee_user_id: 7 }),
  });
  const task = pool.tasks.get(13990);

  assert.equal(res.statusCode, 200);
  assert.equal(task.status, "на согласовании");
  assert.equal(task.due_at, "2026-08-18T00:00:00.000Z");
  assert.equal(
    task.document_history,
    "11.08.2026 12:15 - документ отправлен Имя Фамилия Отчество"
  );
  assert.equal(task.assignee_user_id, 7);
  assert.equal(task.approved_hours, 8);
  assert.equal(task.spent_hours, 3);
  assert.deepEqual(res.body.changes.assignee_user_id, { old: 4, new: 7 });
});

test("processes outgoing without changing the assignee when it is omitted", async () => {
  const pool = new FakePool({
    tasks: [
      {
        id: 13990,
        status: "ревью",
        due_at: null,
        assignee_user_id: 4,
        document_history: "   ",
        approved_hours: null,
        spent_hours: null,
      },
    ],
  });

  const res = await invoke({ pool, body: validOutgoing() });
  const task = pool.tasks.get(13990);

  assert.equal(res.statusCode, 200);
  assert.equal(task.assignee_user_id, 4);
  assert.equal(
    task.document_history,
    "11.08.2026 12:15 - документ отправлен Имя Фамилия Отчество"
  );
  assert.equal(Object.hasOwn(res.body.changes, "assignee_user_id"), false);
});

test("rejects an inactive or missing outgoing assignee and rolls back", async () => {
  const originalTask = {
    id: 13990,
    status: "в аналитике",
    due_at: null,
    assignee_user_id: 4,
    document_history: null,
  };
  const pool = new FakePool({
    tasks: [originalTask],
    users: [{ id: 7, is_active: false }],
  });

  const res = await invoke({
    pool,
    body: validOutgoing({ assignee_user_id: 7 }),
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "active_assignee_not_found" });
  assert.deepEqual(pool.tasks.get(13990), originalTask);
  assert.equal(pool.processedEvents.size, 0);
});

test("deduplicates normalized Message-ID and does not append history twice", async () => {
  const pool = new FakePool({
    tasks: [
      {
        id: 13990,
        status: "на согласовании",
        due_at: null,
        assignee_user_id: 4,
        document_history: null,
        approved_hours: 6,
        spent_hours: 1,
      },
    ],
  });

  const first = await invoke({
    pool,
    body: validIncoming({ message_id: "  <Case-Sensitive@Example.Test>  " }),
  });
  const historyAfterFirst = pool.tasks.get(13990).document_history;

  const duplicate = await invoke({
    pool,
    body: validIncoming({ message_id: "case-sensitive@example.test" }),
  });

  assert.equal(first.body.result, "updated");
  assert.deepEqual(duplicate.body, {
    result: "updated",
    duplicate: true,
    task_id: 13990,
    changes: {},
  });
  assert.equal(pool.tasks.get(13990).document_history, historyAfterFirst);
  assert.equal(pool.processedEvents.size, 1);
  assert.equal(pool.tasks.get(13990).approved_hours, 6);
  assert.equal(pool.tasks.get(13990).spent_hours, 1);
});
