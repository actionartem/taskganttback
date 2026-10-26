import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";
import { extendTrackerSpec } from './tracker-openapi.js';

const authSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }];
const internalSecurity = [{ internalToken: [] }];
const mailIntegrationSecurity = [{ mailIntegrationToken: [] }];

export function setupSwagger(app) {
  const options = {
    definition: {
      openapi: "3.0.0",
      info: {
        title: "SimpleTracker API",
        version: "1.2.0",
        description: "API таск-трекера SimpleTracker.",
      },
      servers: [
        { url: "/", description: "production" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          sessionCookie: { type: "apiKey", in: "cookie", name: "st_session" },
          internalToken: { type: "apiKey", in: "header", name: "X-Internal-Token" },
          mailIntegrationToken: {
            type: "apiKey",
            in: "header",
            name: "X-Mail-Integration-Token",
          },
        },
        schemas: {
          AuthSession: {
            type: "object",
            properties: {
              id: { type: "integer" },
              login: { type: "string" },
              name: { type: "string" },
              role_text: { type: "string", nullable: true },
              telegram_id: { type: "string", nullable: true },
              is_superadmin: { type: "boolean" },
              token: { type: "string" },
            },
          },
          User: {
            type: "object",
            properties: {
              id: { type: "integer" },
              login: { type: "string" },
              name: { type: "string" },
              role_text: { type: "string", nullable: true },
              telegram_id: { type: "string", nullable: true },
              is_superadmin: { type: "boolean" },
            },
          },
          Tag: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              color: { type: "string" },
            },
          },
          Task: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              description: { type: "string", nullable: true },
              email_thread: {
                type: "string",
                nullable: true,
                description: "Ссылка или идентификатор треда в почте",
              },
              document_history: {
                type: "string",
                nullable: true,
                description: "Ручная история отправки и получения документов",
              },
              status: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              assignee_user_id: { type: "integer", nullable: true },
              start_at: { type: "string", format: "date-time", nullable: true },
              due_at: { type: "string", format: "date-time", nullable: true },
              link_url: { type: "string", nullable: true },
              approved_hours: { type: "number", nullable: true },
              spent_hours: { type: "number", nullable: true },
              created_at: { type: "string", format: "date-time" },
              updated_at: { type: "string", format: "date-time" },
              assignee_name: { type: "string", nullable: true },
              assignee_role: { type: "string", nullable: true },
              tags: {
                type: "array",
                items: { $ref: "#/components/schemas/Tag" },
              },
            },
          },
          TaskPatch: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string", nullable: true },
              email_thread: {
                type: "string",
                nullable: true,
                description: "Ссылка или идентификатор треда в почте",
              },
              document_history: {
                type: "string",
                nullable: true,
                description: "Ручная история отправки и получения документов",
              },
              status: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              assignee_user_id: { type: "integer", nullable: true },
              start_at: { type: "string", format: "date-time", nullable: true },
              due_at: { type: "string", format: "date-time", nullable: true },
              link_url: { type: "string", nullable: true },
              approved_hours: { type: "number", nullable: true },
              spent_hours: { type: "number", nullable: true },
            },
          },
          MailEventRequest: {
            type: "object",
            additionalProperties: false,
            required: ["message_id", "task_id", "direction", "event_at"],
            properties: {
              message_id: {
                type: "string",
                description: "Устойчивый Message-ID; пробелы и окружающие угловые скобки нормализуются",
              },
              task_id: { type: "integer", minimum: 1 },
              direction: { type: "string", enum: ["incoming", "outgoing"] },
              event_at: { type: "string", format: "date-time" },
              sender_name: {
                type: "string",
                description: "Обязательно для outgoing",
              },
              assignee_user_id: {
                type: "integer",
                minimum: 1,
                description: "Допустимо только для outgoing; пользователь должен быть активным",
              },
            },
          },
          MailTaskContext: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "email_thread"],
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              email_thread: { type: "string", nullable: true },
            },
          },
          MailEventStringChange: {
            type: "object",
            required: ["old", "new"],
            properties: {
              old: { type: "string", nullable: true },
              new: { type: "string", nullable: true },
            },
          },
          MailEventAssigneeChange: {
            type: "object",
            required: ["old", "new"],
            properties: {
              old: { type: "integer", nullable: true },
              new: { type: "integer", nullable: true },
            },
          },
          MailEventResponse: {
            type: "object",
            required: ["result", "duplicate", "task_id", "changes"],
            properties: {
              result: { type: "string", enum: ["updated", "manual_review"] },
              duplicate: { type: "boolean" },
              task_id: { type: "integer" },
              changes: {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: { $ref: "#/components/schemas/MailEventStringChange" },
                  due_at: { $ref: "#/components/schemas/MailEventStringChange" },
                  assignee_user_id: { $ref: "#/components/schemas/MailEventAssigneeChange" },
                },
              },
            },
          },
          TaskExportRequest: {
            type: "object",
            required: ["statuses", "fields"],
            properties: {
              statuses: {
                type: "array",
                items: { type: "string" },
              },
              fields: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "id",
                    "title",
                    "status",
                    "priority",
                    "assignee",
                    "approved_hours",
                    "spent_hours",
                    "link_url",
                    "start_at",
                    "due_at",
                    "tags",
                    "description",
                  ],
                },
              },
            },
          },
          TaskExportJob: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["queued", "running", "done", "error"] },
              progress: { type: "integer", minimum: 0, maximum: 100 },
              fileName: { type: "string", nullable: true },
              downloadUrl: { type: "string", nullable: true },
              error: { type: "string", nullable: true },
            },
          },
          Error: {
            type: "object",
            properties: {
              error: { type: "string" },
              details: {
                type: "array",
                items: { type: "string" },
                description: "Детали ошибок строгой валидации payload",
              },
            },
          },
        },
      },
      paths: {
        "/health": {
          get: {
            summary: "Проверка живости API",
            responses: { 200: { description: "OK" } },
          },
        },
        "/integrations/mail-event": {
          post: {
            summary: "Обработать входящее или исходящее почтовое событие",
            description:
              "Использует отдельный MAIL_INTEGRATION_TOKEN, атомарно обновляет задачу и дедуплицирует события по нормализованному Message-ID.",
            security: mailIntegrationSecurity,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MailEventRequest" },
                  examples: {
                    incoming: {
                      value: {
                        message_id: "<message-id>",
                        task_id: 13990,
                        direction: "incoming",
                        event_at: "2026-08-11T09:15:00Z",
                      },
                    },
                    outgoing: {
                      value: {
                        message_id: "<message-id>",
                        task_id: 13990,
                        direction: "outgoing",
                        event_at: "2026-08-11T09:15:00Z",
                        sender_name: "Имя Фамилия Отчество",
                        assignee_user_id: 7,
                      },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "Событие обработано или распознано как дубль",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/MailEventResponse" },
                    examples: {
                      updated: {
                        value: {
                          result: "updated",
                          duplicate: false,
                          task_id: 13990,
                          changes: {
                            status: { old: "в аналитике", new: "на согласовании" },
                            due_at: {
                              old: "2026-08-15T00:00:00.000Z",
                              new: "2026-08-18T00:00:00.000Z",
                            },
                            assignee_user_id: { old: 4, new: 7 },
                          },
                        },
                      },
                      manualReview: {
                        value: {
                          result: "manual_review",
                          duplicate: false,
                          task_id: 13990,
                          changes: {},
                        },
                      },
                      duplicate: {
                        value: {
                          result: "updated",
                          duplicate: true,
                          task_id: 13990,
                          changes: {},
                        },
                      },
                    },
                  },
                },
              },
              400: {
                description: "Невалидный payload или не найден активный исполнитель",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
              },
              401: {
                description: "MAIL_INTEGRATION_TOKEN не задан или токен неверный",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
              },
              404: {
                description: "Задача не найдена",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
              },
              500: {
                description: "Ошибка БД",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
              },
            },
          },
        },
        "/integrations/mail-tasks": {
          get: {
            summary: "Получить минимальный контекст задач для сопоставления почтового треда",
            description:
              "Возвращает только id, title и email_thread. Использует отдельный MAIL_INTEGRATION_TOKEN.",
            security: mailIntegrationSecurity,
            responses: {
              200: {
                description: "Минимальный список задач",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/MailTaskContext" },
                    },
                  },
                },
              },
              401: {
                description: "Неверный или отсутствующий integration token",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
                },
              },
              500: {
                description: "Ошибка БД",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
                },
              },
            },
          },
        },
        "/auth/login-password": {
          post: {
            summary: "Войти по логину и паролю",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["login", "password"],
                    properties: {
                      login: { type: "string" },
                      password: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
              401: { description: "Неверный логин или пароль" },
              429: { description: "Слишком много попыток" },
            },
          },
        },
        "/auth/logout": {
          post: {
            summary: "Выйти и очистить session cookie",
            responses: { 200: { description: "OK" } },
          },
        },
        "/auth/change-password": {
          post: {
            summary: "Сменить пароль текущего пользователя",
            security: authSecurity,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["current_password", "new_password"],
                    properties: {
                      current_password: { type: "string" },
                      new_password: { type: "string", minLength: 8 },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
              401: { description: "Неверный текущий пароль" },
            },
          },
        },
        "/auth/register-password": {
          post: {
            summary: "Создать пользователя по логину и паролю",
            description: "Публичная регистрация выключена после создания первого пользователя, если ALLOW_PUBLIC_REGISTRATION=false.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["login", "password", "name"],
                    properties: {
                      login: { type: "string" },
                      password: { type: "string" },
                      name: { type: "string" },
                      role_text: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              201: { description: "Пользователь создан", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } } },
              403: { description: "Публичная регистрация выключена" },
            },
          },
        },
        "/auth/telegram/request": {
          post: {
            summary: "Запросить код привязки Telegram",
            security: authSecurity,
            responses: { 200: { description: "OK" } },
          },
        },
        "/auth/telegram/code-from-bot": {
          post: {
            summary: "Привязать Telegram по коду из бота",
            security: internalSecurity,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["telegram_id", "code"],
                    properties: {
                      telegram_id: { type: "string" },
                      name: { type: "string" },
                      code: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: "OK" } },
          },
        },
        "/me": {
          get: {
            summary: "Получить текущего пользователя",
            security: authSecurity,
            responses: {
              200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
            },
          },
        },
        "/users": {
          get: {
            summary: "Список пользователей",
            security: authSecurity,
            responses: {
              200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } } },
            },
          },
          post: {
            summary: "Создать исполнителя",
            description: "Только superadmin.",
            security: authSecurity,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, role_text: { type: "string" } } } } },
            },
            responses: { 201: { description: "Создано" }, 403: { description: "Недостаточно прав" } },
          },
        },
        "/users/{id}": {
          patch: {
            summary: "Обновить пользователя",
            description: "Пользователь может обновить себя; superadmin может обновить любого.",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, role_text: { type: "string" }, telegram_id: { type: "string", nullable: true } } } } },
            },
            responses: { 200: { description: "OK" }, 403: { description: "Недостаточно прав" } },
          },
          delete: {
            summary: "Удалить пользователя",
            description: "Только superadmin.",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { 200: { description: "OK" }, 403: { description: "Недостаточно прав" } },
          },
        },
        "/tags": {
          get: {
            summary: "Список тегов",
            security: authSecurity,
            responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Tag" } } } } } },
          },
          post: {
            summary: "Создать тег",
            security: authSecurity,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, color: { type: "string" } } } } },
            },
            responses: { 201: { description: "Создано" }, 403: { description: "Read-only пользователь" } },
          },
        },
        "/tags/{tagId}": {
          delete: {
            summary: "Удалить тег",
            security: authSecurity,
            parameters: [{ name: "tagId", in: "path", required: true, schema: { type: "integer" } }],
            responses: { 200: { description: "OK" } },
          },
        },
        "/exports/tasks": {
          post: {
            summary: "Запустить выгрузку задач в Excel",
            security: authSecurity,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/TaskExportRequest" },
                },
              },
            },
            responses: {
              200: {
                description: "Выгрузка запущена",
                content: { "application/json": { schema: { $ref: "#/components/schemas/TaskExportJob" } } },
              },
              400: { description: "Не выбраны статусы или поля" },
            },
          },
        },
        "/exports/tasks/{jobId}": {
          get: {
            summary: "Получить прогресс выгрузки задач",
            security: authSecurity,
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "OK",
                content: { "application/json": { schema: { $ref: "#/components/schemas/TaskExportJob" } } },
              },
              404: { description: "Выгрузка не найдена" },
            },
          },
        },
        "/exports/tasks/{jobId}/download": {
          get: {
            summary: "Скачать готовый Excel-файл задач",
            security: authSecurity,
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "Excel-файл",
                content: {
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                    schema: { type: "string", format: "binary" },
                  },
                },
              },
              404: { description: "Выгрузка или файл не найдены" },
            },
          },
        },
        "/tasks": {
          get: {
            summary: "Список задач",
            security: [...authSecurity, ...internalSecurity],
            parameters: [
              { name: "assignee_id", in: "query", schema: { type: "integer" } },
              { name: "status", in: "query", schema: { type: "string" } },
              { name: "priority", in: "query", schema: { type: "string", enum: ["low", "medium", "high"] } },
              { name: "tag_id", in: "query", schema: { type: "integer" } },
              { name: "search", in: "query", schema: { type: "string" } },
            ],
            responses: {
              200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Task" } } } } },
            },
          },
          post: {
            summary: "Создать задачу",
            security: authSecurity,
            requestBody: {
              required: true,
              content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/TaskPatch" }, { type: "object", required: ["title"], properties: { id: { type: "integer" } } }] } } },
            },
            responses: { 201: { description: "Создано" }, 403: { description: "Read-only пользователь" } },
          },
        },
        "/tasks/{id}": {
          patch: {
            summary: "Обновить задачу",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TaskPatch" } } } },
            responses: { 200: { description: "OK" }, 403: { description: "Read-only пользователь" } },
          },
          delete: {
            summary: "Удалить задачу",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { 204: { description: "Удалено" }, 403: { description: "Read-only пользователь" } },
          },
        },
        "/tasks/{id}/history": {
          get: {
            summary: "История изменений задачи",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { 200: { description: "OK" } },
          },
        },
        "/tasks/{id}/tags": {
          post: {
            summary: "Прикрепить тег к задаче",
            security: authSecurity,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tag_id"], properties: { tag_id: { type: "integer" } } } } } },
            responses: { 200: { description: "OK" } },
          },
        },
        "/tasks/{id}/tags/{tagId}": {
          delete: {
            summary: "Открепить тег от задачи",
            security: authSecurity,
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "integer" } },
              { name: "tagId", in: "path", required: true, schema: { type: "integer" } },
            ],
            responses: { 200: { description: "OK" } },
          },
        },
      },
    },
    apis: [],
  };

  extendTrackerSpec(options.definition);
  const swaggerSpec = swaggerJSDoc(options);
  app.get('/openapi.json', (req,res) => res.json(swaggerSpec));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
