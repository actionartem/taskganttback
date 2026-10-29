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
const latestApproved = { name: "latest", in: "query", schema: { type: "string", enum: ["approved"] }, description: "Один последний согласованный документ на задачу" };
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
  definition.info.version = "2.1.1";
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
    AnalysisMail: {
      type: "object", required: ["event"], properties: {
        event: { type: "object", required: ["external_id", "cycle_id", "type", "occurred_at", "source_url"], properties: {
          external_id: {type:"string",maxLength:500}, cycle_id: {type:"string",maxLength:300},
          type: {type:"string",enum:["comments_received","document_sent","approval_received"]},
          occurred_at: {type:"string",format:"date-time"}, source_url:{type:"string",format:"uri"}, actor_name:{type:"string",nullable:true},
          final:{type:"boolean",description:"Для approval_received обязательно true: подтверждённое финальное согласование АЗ. Атомарно отключает автоматизацию."}
        }}, document: ref("ApprovedDocumentInput")
      }
    },
    AzSnapshot: {
      type:"object", required:["issue_type","issue_id","issue_key","url","epic_key","epic_url","issue_created_at","status","assignee","checked_at","status_map","history"],
      properties: {
        issue_type:{type:"string",enum:["az"]},issue_id:{type:"string"},issue_key:{type:"string"},url:{type:"string",format:"uri"},
        epic_key:{type:"string",description:"Родительский эпик, отличается от issue_key"},epic_url:{type:"string",format:"uri"},
        issue_created_at:{type:"string",format:"date-time"},status:{type:"string"},assignee:{type:"string",nullable:true},checked_at:{type:"string",format:"date-time"},history_complete:{type:"boolean"},
        status_map:{type:"object",additionalProperties:{type:"string",enum:["analysis","review","approval","other"]}},
        history:{type:"array",maxItems:1000,items:{type:"object",required:["id","occurred_at","old_status","new_status"],properties:{id:{type:"string"},occurred_at:{type:"string",format:"date-time"},old_status:{type:"string"},new_status:{type:"string"},actor_name:{type:"string",nullable:true}}}}
      }
    },
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
    ApprovedDocumentInput: {
      type: "object",
      required: ["title"],
      oneOf: [
        { required: ["approved_at"], properties: { approved_at: { type: "string", format: "date-time" }, approval_date_unknown: { enum: [false] } } },
        { required: ["approval_date_unknown", "approval_evidence"], properties: { approved_at: { type: "string", nullable: true, enum: [null] }, approval_date_unknown: { enum: [true] }, approval_evidence: { type: "string", minLength: 1 } } },
      ],
      properties: {
        title: { type: "string" },
        approved_at: { type: "string", format: "date-time", nullable: true, description: "Подтверждённая дата согласования, не в будущем; не подставлять дату загрузки" },
        approval_date_unknown: { type: "boolean", description: "Согласование подтверждено, но дата неизвестна. Нужен approval_evidence. Для интеграций допускается только первоначальная публикация; пользователь-редактор может явно выбрать актуальный документ через replace_current." },
        approval_evidence: { type: "string" },
        version: { type: "string", description: "Необязательный идентификатор версии источника" },
        source_url: { type: "string", format: "uri", nullable: true },
        file_name: { type: "string" },
        file_base64: { type: "string", format: "byte", description: "Файл до 10 МиБ. Нужен файл либо source_url." },
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
    "/integrations/agent/tasks/{id}/analysis": {get:operation("Циклы АЗ, рабочие длительности и состояние автоматизации")},
    "/tasks/{id}/analysis": {get:operation("Статистика АЗ; 10–19 МСК, 8 часов/день, неполный день пропорционально, выходные РФ исключены",null,security)},
    "/integrations/agent/tasks/{id}/analysis/events": {post:operation("Факт из почты. Финальное согласование отключает автоматизацию",ref("AnalysisMail"))},
    "/integrations/jira/tasks/{id}/analysis": {post:operation("Привязка дочерней АЗ и импорт достоверной истории Jira",ref("AzSnapshot"),[{jiraIngestToken:[]}])},
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
      get: { ...operation("Документы; latest=approved возвращает последний согласованный"), parameters: [id, latestApproved] },
      post: operation("Зарегистрировать новую версию и событие", {
        type: "object",
        required: ["event", "document"],
        properties: {
          event: ref("ExternalEvent"),
          document: ref("DocumentInput"),
        },
      }),
    },
    "/integrations/agent/tasks/{id}/documents/approved": {
      post: operation("Последний согласованный документ; разрешён также в готовой к разработке карточке без ручной блокировки. Не разрешает прочую автоматизацию", {
        type: "object", required: ["event", "document"],
        properties: { event: ref("ExternalEvent"), document: ref("ApprovedDocumentInput") },
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
        ...operation("Документы; latest=approved возвращает один согласованный на задачу", null, security),
        parameters: [latestApproved],
      },
    },
  });
  for (const suffix of [
    "documents",
    "documents/approved",
    "documents/{docId}/state",
    "documents/{docId}/download",
  ]) {
    const ops = definition.paths[`/integrations/agent/tasks/{id}/${suffix}`];
    definition.paths[`/tasks/{id}/${suffix}`] = Object.fromEntries(
      Object.entries(ops).map(([method, op]) => [method, { ...op, security }]),
    );
  }
  const manualApproved = definition.paths["/tasks/{id}/documents/approved"].post;
  manualApproved.summary = "Явно выбрать актуальный согласованный документ без обязательной даты";
  manualApproved.requestBody = { required: true, content: json({
    type: "object", required: ["event", "document"], properties: {
      event: ref("ExternalEvent"), document: ref("ApprovedDocumentInput"),
      replace_current: { type: "boolean", description: "Только пользователь-редактор: явно заменить актуальный документ, в том числе без даты согласования. Не доступно токенам интеграций." },
    },
  }) };
  definition.paths["/tasks/{id}"].get = operation(
    "Прочитать задачу с отдельным Jira-снимком",
    null,
    security,
  );
  definition.paths["/tasks/{id}"].patch.requestBody = {
    required: true,
    content: json({ ...definition.components.schemas.TrackerChanges, properties: { ...definition.components.schemas.TrackerChanges.properties, automation_locked: {type:"boolean",description:"Только владелец: согласована, дальше вручную"} } }),
  };
  Object.assign(definition.components.schemas.Task.properties, {
    automation_locked:{type:"boolean"},automation_locked_at:{type:"string",format:"date-time",nullable:true},
    approved_document_write_allowed:{type:"boolean",description:"Отдельное разрешение только на /documents/approved, не на прочие записи"},
    approved_document_blocked_reason:{type:"string",nullable:true,enum:[null,"approved_manual","outside_analysis"]}
  });
  definition.components.schemas.TaskPatch.properties.automation_locked={type:"boolean"};
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
