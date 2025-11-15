// swagger.js
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";

export function setupSwagger(app) {
  const options = {
    definition: {
      openapi: "3.0.0",
      info: {
        title: "SimpleTracker API",
        version: "1.0.0",
        description: "Твой личный API для таск-трекера",
      },
      servers: [
        { url: "http://simpletracker.ru", description: "prod" },
        { url: "http://185.107.74.198:3000", description: "raw ip" },
      ],
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "integer" },
              login: { type: "string" },
              name: { type: "string" },
              role_text: { type: "string" },
              telegram_id: { type: "integer", nullable: true },
              is_superadmin: { type: "boolean" },
            },
          },
          Task: {
            type: "object",
            properties: {
              id: { type: "integer" },
              board_id: { type: "integer" },
              title: { type: "string" },
              description: { type: "string", nullable: true },
              status: { type: "string" },
              priority: { type: "string" },
              assignee_user_id: { type: "integer", nullable: true },
              due_at: { type: "string", format: "date-time", nullable: true },
              assignee_name: { type: "string", nullable: true },
              assignee_role: { type: "string", nullable: true },
              tags: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    title: { type: "string" },
                    color: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      paths: {
        "/health": {
          get: {
            summary: "Проверка живости API",
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        "/auth/login": {
          post: {
            summary: "Логин по логину (старый способ)",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      login: { type: "string" },
                    },
                    required: ["login"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },

        "/auth/register-password": {
          post: {
            summary: "Регистрация по логину/паролю",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      login: { type: "string" },
                      password: { type: "string" },
                      name: { type: "string" },
                      role_text: { type: "string" },
                    },
                    required: ["login", "password", "name"],
                  },
                },
              },
            },
            responses: {
              201: {
                description: "Пользователь создан",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },

        "/auth/login-password": {
          post: {
            summary: "Логин по логину и паролю",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      login: { type: "string" },
                      password: { type: "string" },
                    },
                    required: ["login", "password"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
              401: { description: "user not found / wrong password" },
            },
          },
        },

        "/auth/telegram/request": {
          post: {
            summary: "Запросить код для привязки телеграма",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { login: { type: "string" } },
                    required: ["login"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "OK (код вернули в ответ)",
              },
            },
          },
        },

        "/auth/telegram/code-from-bot": {
          post: {
            summary: "Бот прислал код и telegram_id",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      telegram_id: { type: "integer" },
                      name: { type: "string" },
                      code: { type: "string" },
                    },
                    required: ["telegram_id", "code"],
                  },
                },
              },
            },
            responses: {
              200: {
                description: "OK",
              },
            },
          },
        },

        "/me": {
          get: {
            summary: "Получить свои данные",
            parameters: [
              {
                name: "user_id",
                in: "query",
                schema: { type: "integer" },
                required: true,
              },
            ],
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },

        "/boards": {
          get: {
            summary: "Список досок",
            parameters: [
              {
                name: "user_id",
                in: "query",
                schema: { type: "integer" },
              },
            ],
            responses: {
              200: { description: "OK" },
            },
          },
        },

        "/boards/{boardId}/tasks": {
          get: {
            summary: "Список задач доски",
            parameters: [
              {
                name: "boardId",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
              {
                name: "assignee_id",
                in: "query",
                schema: { type: "integer" },
              },
              {
                name: "status",
                in: "query",
                schema: { type: "string" },
              },
              {
                name: "priority",
                in: "query",
                schema: { type: "string", enum: ["low", "medium", "high"] },
              },
              {
                name: "tag_id",
                in: "query",
                schema: { type: "integer" },
              },
            ],
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Task" },
                    },
                  },
                },
              },
            },
          },
          post: {
            summary: "Создать задачу",
            parameters: [
              {
                name: "boardId",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      assignee_user_id: { type: "integer" },
                      due_at: { type: "string" },
                      created_by: { type: "integer" },
                      priority: {
                        type: "string",
                        enum: ["low", "medium", "high"],
                      },
                    },
                    required: ["title"],
                  },
                },
              },
            },
            responses: {
              201: { description: "created" },
            },
          },
        },

        "/tasks/{taskId}": {
          patch: {
            summary: "Обновить задачу",
            parameters: [
              {
                name: "taskId",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      status: { type: "string" },
                      assignee_user_id: { type: "integer" },
                      due_at: { type: "string" },
                      priority: {
                        type: "string",
                        enum: ["low", "medium", "high"],
                      },
                      updated_by: { type: "integer" },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "OK" },
            },
          },
        },

        "/tasks/{taskId}/history": {
          get: {
            summary: "История задачи (10 последних)",
            parameters: [
              {
                name: "taskId",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: {
              200: { description: "OK" },
            },
          },
        },
      },
    },
    apis: [], // мы описали всё руками
  };

  const swaggerSpec = swaggerJSDoc(options);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
