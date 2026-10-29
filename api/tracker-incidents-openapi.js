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
      comment: { type: 'string', maxLength: 10000, description: 'Локальный комментарий; МосИТСМ его не заменяет' },
      version: { type: 'integer', minimum: 1, description: 'Обязателен для изменения и удаления; защищает от потери параллельной правки' },
    },
  };
  spec.components.schemas.IncidentInput = input;
  spec.components.schemas.Incident = { ...input, additionalProperties: true, properties: {
    ...input.properties, id: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['active','completed','burned'], readOnly: true },
    closure_source: { type: 'string', enum: ['manual','itsm'], nullable: true, readOnly: true },
    closed_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true },
    closure_deadline_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true },
    itsm_completed_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true },
    itsm_created_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true, description: 'Дата создания обращения в МосИТСМ; null, пока источник не прочитан' },
    itsm_deadline_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true },
    last_checked_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true },
    check_error: { type: 'string', nullable: true, readOnly: true },
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
  spec.paths['/incidents/{id}/itsm'] = { get: {
    summary: 'Свежие сведения МосИТСМ: карточка и все страницы доступных разделов', security, parameters: [id],
    responses: { ...responses, 200: { description: 'record, sections (items/complete/error/upstream_status), checked_at, incident_version, synchronization (values/error)' }, 502: { description: 'Ошибка МосИТСМ' }, 503: { description: 'На сервере не настроен MOS_ITSM_TOKEN' }, 504: { description: 'Истекло время ожидания' } },
  } };
  spec.paths['/incidents/{id}/comment'] = { patch: {
    summary: 'Изменить только локальный комментарий с проверкой версии', security, parameters: [id],
    requestBody: body({ type: 'object', additionalProperties: false, required: ['comment','version'], properties: { comment: input.properties.comment, version: input.properties.version } }),
    responses: { ...responses, 200: { description: 'Комментарий сохранён; сроки, результат и состояние автоматической проверки не меняются', content: content({ $ref: '#/components/schemas/Incident' }) } },
  } };
  spec.paths['/incidents/{id}/fields'] = { patch: {
    summary: 'Изменить приоритет или сроки прямо в таблице, сохранив остальные поля', security, parameters: [id],
    requestBody: body({ type: 'object', additionalProperties: false, minProperties: 2, required: ['version'], properties: {
      priority: input.properties.priority, expires_at: input.properties.expires_at, is_deferred: input.properties.is_deferred,
      deferred_until: input.properties.deferred_until, version: input.properties.version,
    } }),
    responses: { ...responses, 200: { description: 'Обновлены только переданные поля. Изменение сроков планирует повторную проверку активного инцидента; результат архива сохраняется', content: content({ $ref: '#/components/schemas/Incident' }) } },
  } };
  spec.paths['/incidents/{id}/itsm/sync'] = { post: {
    summary: 'Повторно прочитать МосИТСМ и атомарно обновить только приоритет, срок решения и ожидание', security, parameters: [id],
    requestBody: body({ type: 'object', additionalProperties: false, required: ['version'], properties: { version: input.properties.version } }),
    responses: { ...responses, 200: { description: 'incident, changed_fields, record, checked_at; Jira-ссылка и локальный комментарий сохраняются' }, 422: { description: 'Нет корректных сроков или важности; ничего не изменено' }, 502: { description: 'Ошибка МосИТСМ' }, 503: { description: 'Интеграция не настроена' } },
  } };
  spec.paths['/incidents/{id}/close'] = { post: {
    summary: 'Ручное закрытие в архив: результат окончателен для автоматической проверки', security, parameters: [id],
    requestBody: body({ type: 'object', additionalProperties: false, required: ['status','version'], properties: { status: { type: 'string', enum: ['completed','burned'] }, version: input.properties.version } }),
    responses: { ...responses, 200: { description: 'Инцидент в архиве; closure_source=manual, автоматические проверки больше не выполняются', content: content({ $ref: '#/components/schemas/Incident' }) } },
  } };
}
