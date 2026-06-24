import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";

const authSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }];
const internalSecurity = [{ internalToken: [] }];

export function setupSwagger(app) {
  const options = {
    definition: {
      openapi: "3.0.0",
      info: {
        title: "SimpleTracker API",
        version: "1.1.0",
        description: "API таск-трекера SimpleTracker.",
      },
      servers: [
        { url: "https://api.simpletracker.ru", description: "production" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          sessionCookie: { type: "apiKey", in: "cookie", name: "st_session" },
          internalToken: { type: "apiKey", in: "header", name: "X-Internal-Token" },
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
              status: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              assignee_user_id: { type: "integer", nullable: true },
              start_at: { type: "string", format: "date-time", nullable: true },
              due_at: { type: "string", format: "date-time", nullable: true },
              link_url: { type: "string", nullable: true },
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
              status: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              assignee_user_id: { type: "integer", nullable: true },
              start_at: { type: "string", format: "date-time", nullable: true },
              due_at: { type: "string", format: "date-time", nullable: true },
              link_url: { type: "string", nullable: true },
            },
          },
          Error: {
            type: "object",
            properties: {
              error: { type: "string" },
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

  const swaggerSpec = swaggerJSDoc(options);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
