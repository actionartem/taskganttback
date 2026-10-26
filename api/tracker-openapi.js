const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ "application/json": { schema } });
const id = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
};
const security = [{ bearerAuth: [] }, { sessionCookie: [] }];
const integration = [{ agentToken: [] }];
const event = {
  type: "object",
  required: ["external_id", "type", "summary"],
  properties: {
    external_id: { type: "string", maxLength: 500 },
    type: {
      type: "string",
      enum: [
        "note",
        "task.updated",
        "document.received",
        "document.sent_for_approval",
        "document.comments_received",
        "document.approved",
        "document.current",
        "event.corrected",
        "action.scheduled",
        "action.completed",
        "task.paused",
        "task.resumed",
      ],
    },
    summary: { type: "string", maxLength: 10000 },
    actor_name: { type: "string", nullable: true },
    occurred_at: { type: "string", format: "date-time", nullable: true },
    source_url: { type: "string", format: "uri", nullable: true },
    corrects_event_id: { type: "integer", nullable: true },
  },
};
const operation = (summary, body, auth = integration) => ({
  summary,
  security: auth,
  parameters: [id],
  ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
  responses: {
    200: { description: "Прочитано или повтор идентичного запроса" },
    201: { description: "Создано" },
    400: { description: "Некорректные данные" },
    401: { description: "Нет доступа" },
    404: { description: "Задача/документ не найден" },
    409: { description: "Ключ повторён с другим содержимым" },
  },
});
export function extendTrackerSpec(definition) {
  definition.info.version = "2.0.0";
  definition.info.description +=
    "\n\nИнструкция агента: /integrations/guide. Jira передаёт агент; прямого опроса Jira нет.";
  definition.components.securitySchemes.agentToken = {
    type: "apiKey",
    in: "header",
    name: "X-Integration-Token",
    description: "AGENT_API_TOKEN; только маршруты /integrations/agent",
  };
  definition.components.securitySchemes.jiraIngestToken = {
    type: "apiKey",
    in: "header",
    name: "X-Integration-Token",
    description: "JIRA_INGEST_TOKEN; только импорт Jira",
  };
  Object.assign(definition.components.schemas, {
    ExternalEvent: event,
    TrackerChanges: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        description: { type: "string", nullable: true },
        email_thread: { type: "string", nullable: true },
        document_history: { type: "string", nullable: true },
        status: {
          type: "string",
          enum: [
            "не в работе",
            "в аналитике",
            "на согласовании",
            "оценка",
            "ревью",
            "готова к разработке",
            "разработка",
            "завершена",
          ],
        },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        assignee_user_id: { type: "integer", nullable: true },
        start_at: { type: "string", format: "date-time", nullable: true },
        due_at: { type: "string", format: "date-time", nullable: true },
        link_url: { type: "string", format: "uri", nullable: true },
        approved_hours: { type: "number", minimum: 0, nullable: true },
        tags: { type: "array", items: { type: "string" } },
        deadline_confirmed: { type: "boolean" },
        next_action_at: { type: "string", format: "date-time", nullable: true },
        next_action_text: { type: "string", nullable: true },
        reply_due_at: { type: "string", format: "date-time", nullable: true },
        waiting_for: { type: "string", nullable: true },
      },
    },
    DocumentInput: {
      type: "object",
      required: ["kind", "title", "version"],
      properties: {
        kind: { type: "string", enum: ["az", "st", "estimate", "other"] },
        title: { type: "string" },
        version: { type: "string" },
        document_date: { type: "string", format: "date", nullable: true },
        source_url: { type: "string", format: "uri", nullable: true },
        file_name: { type: "string" },
        file_base64: {
          type: "string",
          format: "byte",
          description: "Файл до 10 МиБ. Нужен файл либо source_url.",
        },
      },
    },
    JiraSnapshot: {
      type: "object",
      required: [
        "issue_id",
        "issue_key",
        "url",
        "status",
        "assignee",
        "checked_at",
      ],
      properties: {
        issue_id: { type: "string" },
        issue_key: { type: "string" },
        url: { type: "string", format: "uri" },
        status: { type: "string" },
        assignee: { type: "string", nullable: true },
        checked_at: { type: "string", format: "date-time" },
        history_complete: { type: "boolean" },
        history: {
          type: "array",
          maxItems: 1000,
          items: {
            type: "object",
            required: ["id", "occurred_at", "changes"],
            properties: {
              id: { type: "string" },
              occurred_at: { type: "string", format: "date-time" },
              actor_name: { type: "string", nullable: true },
              changes: {
                type: "object",
                description:
                  "Ключи status и assignee, каждый {old: string|null, new: string|null}",
              },
            },
          },
        },
      },
    },
  });
  const eventBody = {
    type: "object",
    required: ["event"],
    properties: { event: ref("ExternalEvent") },
  };
  Object.assign(definition.paths, {
    "/integrations/guide": {
      get: {
        summary: "Инструкция для агента без секретов",
        responses: { 200: { description: "Текст инструкции" } },
      },
    },
    "/integrations/agent/options": {
      get: {
        ...operation("Активные исполнители, теги и допустимые значения"),
        parameters: [],
      },
    },
    "/integrations/agent/tasks": {
      get: {
        ...operation("Найти задачу по ID, ключу Jira или названию"),
        parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
      },
    },
    "/integrations/agent/tasks/{id}": {
      get: operation("Прочитать задачу и Jira-снимок"),
    },
    "/integrations/agent/tasks/{id}/events": {
      get: operation("Прочитать единый журнал"),
      post: operation("Добавить событие, не изменяя поля задачи", eventBody),
    },
    "/integrations/agent/tasks/{id}/actions": {
      post: operation("Явно изменить поля и атомарно записать событие", {
        type: "object",
        required: ["event", "changes"],
        properties: {
          event: ref("ExternalEvent"),
          changes: ref("TrackerChanges"),
        },
      }),
    },
    "/integrations/agent/tasks/{id}/documents": {
      get: operation("Прочитать все версии документов"),
      post: operation("Зарегистрировать новую версию и событие", {
        type: "object",
        required: ["event", "document"],
        properties: {
          event: ref("ExternalEvent"),
          document: ref("DocumentInput"),
        },
      }),
    },
    "/integrations/agent/tasks/{id}/documents/{docId}/state": {
      post: {
        ...operation("Явно отметить актуальность или согласование версии", {
          type: "object",
          required: ["event", "state"],
          properties: {
            event: ref("ExternalEvent"),
            state: {
              type: "object",
              properties: {
                is_current: { type: "boolean" },
                approved_at: { type: "string", format: "date-time" },
                approval_evidence: { type: "string" },
              },
            },
          },
        }),
        parameters: [
          id,
          {
            name: "docId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
      },
    },
    "/integrations/agent/tasks/{id}/documents/{docId}/download": {
      get: {
        ...operation("Скачать файл версии с авторизацией"),
        parameters: [
          id,
          {
            name: "docId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
      },
    },
    "/integrations/jira/tasks/{id}/snapshot": {
      post: operation(
        "Получить Jira-снимок и порцию истории от агента",
        ref("JiraSnapshot"),
        [{ jiraIngestToken: [] }],
      ),
    },
    "/tasks/{id}/events": {
      get: operation("Единая история", null, security),
      post: operation("Добавить заметку", eventBody, security),
    },
    "/tasks/{id}/stages": {
      get: operation("Календарное время по локальным этапам", null, security),
    },
    "/attention": {
      get: {
        ...operation("Объяснимые сигналы внимания", null, security),
        parameters: [],
      },
    },
    "/documents": {
      get: {
        ...operation("Все зарегистрированные документы", null, security),
        parameters: [],
      },
    },
  });
  for (const suffix of [
    "documents",
    "documents/{docId}/state",
    "documents/{docId}/download",
  ]) {
    const ops = definition.paths[`/integrations/agent/tasks/{id}/${suffix}`];
    definition.paths[`/tasks/{id}/${suffix}`] = Object.fromEntries(
      Object.entries(ops).map(([method, op]) => [method, { ...op, security }]),
    );
  }
  definition.paths["/tasks/{id}"].get = operation(
    "Прочитать задачу с отдельным Jira-снимком",
    null,
    security,
  );
  definition.paths["/tasks/{id}"].patch.requestBody = {
    required: true,
    content: json(ref("TrackerChanges")),
  };
  definition.paths["/jira"] = {
    get: {
      ...operation("Полученные снимки Jira", null, security),
      parameters: [],
    },
  };
  definition.paths["/statistics/hours"] = {
    get: {
      ...operation("Даты для статистики часов: факт завершения по истории, план релиза из due_at; календарь Europe/Moscow", null, security),
      parameters: [],
      responses: {
        200: { description: "Отсутствующие или недостоверные даты возвращаются как null", content: json({
          type: "object", properties: {
            time_zone: { type: "string", example: "Europe/Moscow" },
            items: { type: "array", items: { type: "object", properties: {
              task_id: { type: "string" },
              completed_on: { type: "string", format: "date", nullable: true },
              planned_release_on: { type: "string", format: "date", nullable: true },
            } } },
          },
        }) },
        401: { description: "Требуется сессия пользователя" },
      },
    },
  };
  definition.paths["/tasks/{id}/jira"] = {
    put: operation(
      "Указать основную связь Jira",
      {
        type: "object",
        required: ["issue_key", "url"],
        properties: {
          issue_key: { type: "string" },
          url: { type: "string", format: "uri" },
        },
      },
      security,
    ),
  };
  definition.paths["/attention/settings"] = {
    get: {
      ...operation("Прочитать пороги внимания", null, security),
      parameters: [],
    },
    put: {
      ...operation(
        "Задать пороги активных этапов",
        {
          type: "object",
          additionalProperties: { type: "integer", minimum: 1, maximum: 3650 },
        },
        security,
      ),
      parameters: [],
    },
  };
  definition.paths["/tasks/{id}/attention/snooze"] = {
    post: operation(
      "Отложить конкретный сигнал",
      {
        type: "object",
        required: ["reason_key", "until_at"],
        properties: {
          reason_key: { type: "string" },
          until_at: { type: "string", format: "date-time" },
        },
      },
      security,
    ),
  };
  return definition;
}
