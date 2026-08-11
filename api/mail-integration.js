import crypto from "crypto";

const MAIL_EVENT_FIELDS = new Set([
  "message_id",
  "task_id",
  "direction",
  "event_at",
  "sender_name",
  "assignee_user_id",
]);

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i;
const MOSCOW_TIME_ZONE = "Europe/Moscow";

class MailIntegrationRequestError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function secureTokenMatches(expectedToken, receivedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length === 0) return false;
  if (typeof receivedToken !== "string" || receivedToken.length === 0) return false;

  const expectedDigest = crypto.createHash("sha256").update(expectedToken).digest();
  const receivedDigest = crypto.createHash("sha256").update(receivedToken).digest();
  return crypto.timingSafeEqual(expectedDigest, receivedDigest);
}

export function normalizeMessageId(value) {
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.toLowerCase();
  return normalized || null;
}

function isValidIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const match = value.match(ISO_DATE_TIME_PATTERN);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8].toUpperCase() === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8].toUpperCase() === "Z" ? 0 : Number(match[11]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function moscowDateTimeParts(eventDate) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(eventDate)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function buildMailEventDates(eventAt) {
  const eventDate = new Date(eventAt);
  const parts = moscowDateTimeParts(eventDate);
  const dueDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 7));

  return {
    eventDateTimeText: `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year} ${parts.hour}:${parts.minute}`,
    dueAt: `${dueDate.getUTCFullYear()}-${pad2(dueDate.getUTCMonth() + 1)}-${pad2(
      dueDate.getUTCDate()
    )}T00:00:00.000Z`,
  };
}

export function validateMailEventPayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { errors: ["body must be a JSON object"] };
  }

  const unknownFields = Object.keys(body).filter((field) => !MAIL_EVENT_FIELDS.has(field));
  if (unknownFields.length > 0) {
    errors.push(`unknown fields: ${unknownFields.sort().join(", ")}`);
  }

  const normalizedMessageId = normalizeMessageId(body.message_id);
  if (!normalizedMessageId) errors.push("message_id is required");
  if (!Number.isInteger(body.task_id) || body.task_id <= 0) {
    errors.push("task_id must be a positive integer");
  }
  if (body.direction !== "incoming" && body.direction !== "outgoing") {
    errors.push("direction must be incoming or outgoing");
  }
  if (!isValidIsoDateTime(body.event_at)) {
    errors.push("event_at must be a valid ISO date-time with timezone");
  }

  const hasSenderName = Object.prototype.hasOwnProperty.call(body, "sender_name");
  const senderName = typeof body.sender_name === "string" ? body.sender_name.trim() : "";
  if (body.direction === "outgoing" && !senderName) {
    errors.push("sender_name is required for outgoing events");
  } else if (hasSenderName && !senderName) {
    errors.push("sender_name must be a non-empty string when provided");
  }

  const hasAssigneeUserId = Object.prototype.hasOwnProperty.call(body, "assignee_user_id");
  if (hasAssigneeUserId && body.direction !== "outgoing") {
    errors.push("assignee_user_id is allowed only for outgoing events");
  } else if (
    hasAssigneeUserId &&
    (!Number.isInteger(body.assignee_user_id) || body.assignee_user_id <= 0)
  ) {
    errors.push("assignee_user_id must be a positive integer when provided");
  }

  if (errors.length > 0) return { errors };

  return {
    value: {
      originalMessageId: body.message_id,
      normalizedMessageId,
      taskId: body.task_id,
      direction: body.direction,
      eventAt: new Date(body.event_at).toISOString(),
      senderName: senderName || null,
      assigneeUserId: hasAssigneeUserId ? body.assignee_user_id : null,
      hasAssigneeUserId,
    },
  };
}

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function dateTimeJsonValue(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is more useful than a rollback error.
  }
}

export function createMailIntegrationHandler({ pool, mailIntegrationToken }) {
  return async function mailIntegrationHandler(req, res) {
    if (!secureTokenMatches(mailIntegrationToken, req.get("x-mail-integration-token"))) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const validation = validateMailEventPayload(req.body);
    if (validation.errors) {
      return res.status(400).json({ error: "invalid_payload", details: validation.errors });
    }

    const event = validation.value;
    const { eventDateTimeText, dueAt } = buildMailEventDates(event.eventAt);
    const historyLine =
      event.direction === "incoming"
        ? `${eventDateTimeText} - документ получен с комментариями от заказчика`
        : `${eventDateTimeText} - документ отправлен ${event.senderName}`;

    let client;
    let transactionStarted = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;

      const insertedEvent = await client.query(
        `INSERT INTO processed_mail_events
           (normalized_message_id, original_message_id, task_id, direction, event_at, result)
         VALUES ($1, $2, $3, $4, $5, 'manual_review')
         ON CONFLICT (normalized_message_id) DO NOTHING
         RETURNING id`,
        [
          event.normalizedMessageId,
          event.originalMessageId,
          event.taskId,
          event.direction,
          event.eventAt,
        ]
      );

      if (insertedEvent.rowCount === 0) {
        const duplicateEvent = await client.query(
          `SELECT task_id, result
           FROM processed_mail_events
           WHERE normalized_message_id = $1`,
          [event.normalizedMessageId]
        );
        if (duplicateEvent.rowCount !== 1) {
          throw new Error("processed mail event disappeared during deduplication");
        }
        await client.query("COMMIT");
        transactionStarted = false;

        const savedEvent = duplicateEvent.rows[0];
        return res.json({
          result: savedEvent.result,
          duplicate: true,
          task_id: Number(savedEvent.task_id),
          changes: {},
        });
      }

      const processedEventId = insertedEvent.rows[0].id;
      if (event.hasAssigneeUserId) {
        const assigneeResult = await client.query(
          `SELECT id
           FROM users
           WHERE id = $1 AND COALESCE(is_active, true) = true
           FOR SHARE`,
          [event.assigneeUserId]
        );
        if (assigneeResult.rowCount === 0) {
          throw new MailIntegrationRequestError(400, "active_assignee_not_found");
        }
      }

      const taskResult = await client.query(
        `SELECT id, status, due_at, assignee_user_id
         FROM tasks
         WHERE id = $1
         FOR UPDATE`,
        [event.taskId]
      );
      if (taskResult.rowCount === 0) {
        throw new MailIntegrationRequestError(404, "task_not_found");
      }

      const task = taskResult.rows[0];
      const oldStatus = normalizedStatus(task.status);
      const oldDueAt = dateTimeJsonValue(task.due_at);
      const oldAssigneeUserId = task.assignee_user_id == null ? null : Number(task.assignee_user_id);

      if (event.direction === "incoming" && oldStatus !== "на согласовании") {
        await client.query(
          `UPDATE processed_mail_events
           SET result = 'manual_review'
           WHERE id = $1`,
          [processedEventId]
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return res.json({
          result: "manual_review",
          duplicate: false,
          task_id: event.taskId,
          changes: {},
        });
      }

      const nextStatus = event.direction === "incoming" ? "в аналитике" : "на согласовании";
      const updateValues = [nextStatus, dueAt, historyLine];
      let assigneeSet = "";
      if (event.hasAssigneeUserId) {
        updateValues.push(event.assigneeUserId);
        assigneeSet = `,\n             assignee_user_id = $${updateValues.length}`;
      }
      updateValues.push(event.taskId);

      await client.query(
        `UPDATE tasks
         SET status = $1,
             due_at = $2,
             document_history = CASE
               WHEN document_history IS NULL OR BTRIM(document_history) = '' THEN $3
               ELSE document_history || E'\\n' || $3
             END${assigneeSet},
             updated_at = NOW()
         WHERE id = $${updateValues.length}`,
        updateValues
      );

      await client.query(
        `UPDATE processed_mail_events
         SET result = 'updated'
         WHERE id = $1`,
        [processedEventId]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      const changes = {
        status: { old: oldStatus, new: nextStatus },
        due_at: { old: oldDueAt, new: dueAt },
      };
      if (event.hasAssigneeUserId) {
        changes.assignee_user_id = { old: oldAssigneeUserId, new: event.assigneeUserId };
      }

      return res.json({
        result: "updated",
        duplicate: false,
        task_id: event.taskId,
        changes,
      });
    } catch (error) {
      if (transactionStarted && client) await rollbackQuietly(client);
      if (error instanceof MailIntegrationRequestError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error("mail integration error:", error);
      return res.status(500).json({ error: "db error" });
    } finally {
      if (client) client.release();
    }
  };
}
