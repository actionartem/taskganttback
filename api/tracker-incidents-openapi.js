export function extendIncidentsSpec(spec) {
  const security = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const input = {
    type: 'object', additionalProperties: false,
    required: ['number', 'jira_url', 'priority', 'expires_at', 'is_deferred'],
    properties: {
      number: { type: 'string', maxLength: 100, description: 'Уникальный номер, регистр не учитывается' },
      jira_url: { type: 'string', format: 'uri', maxLength: 2000 },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      expires_at: { type: 'string', format: 'date-time', description: 'Исходный срок; обязателен часовой пояс, годы 2000–2100' },
      is_deferred: { type: 'boolean' },
      deferred_until: { type: 'string', format: 'date-time', nullable: true, description: 'Обязателен при is_deferred=true и позже expires_at; иначе null' },
      version: { type: 'integer', minimum: 1, description: 'Обязателен для изменения и удаления; защищает от потери параллельной правки' },
    },
  };
  spec.components.schemas.IncidentInput = input;
  spec.components.schemas.Incident = { ...input, additionalProperties: true, properties: {
    ...input.properties, id: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
  } };
  const content = schema => ({ 'application/json': { schema } });
  const responses = { 400: { description: 'Некорректные поля' }, 401: { description: 'Нужна пользовательская сессия' }, 403: { description: 'Только чтение' }, 404: { description: 'Инцидент не найден' }, 409: { description: 'Номер занят или версия устарела' } };
  const body = schema => ({ required: true, content: content(schema) });
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
  spec.paths['/incidents'] = {
    get: { summary: 'Список самостоятельных инцидентов, по действующему сроку', security, responses: { 200: { description: 'Список', content: content({ type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Incident' } } } }) }, 401: responses[401] } },
    post: { summary: 'Создать инцидент (редактор)', security, requestBody: body({ $ref: '#/components/schemas/IncidentInput' }), responses: { ...responses, 201: { description: 'Создан', content: content({ $ref: '#/components/schemas/Incident' }) } } },
  };
  spec.paths['/incidents/{id}'] = {
    patch: { summary: 'Заменить поля инцидента с проверкой версии (редактор)', security, parameters: [id], requestBody: body({ ...input, required: [...input.required, 'version'] }), responses: { ...responses, 200: { description: 'Сохранён', content: content({ $ref: '#/components/schemas/Incident' }) } } },
    delete: { summary: 'Удалить инцидент с проверкой версии (редактор)', security, parameters: [id], requestBody: body({ type: 'object', required: ['version'], properties: { version: input.properties.version } }), responses: { ...responses, 204: { description: 'Удалён' } } },
  };
}
