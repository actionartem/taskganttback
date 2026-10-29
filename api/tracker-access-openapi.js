export function extendAccessSpec(spec) {
  const role = { type: 'string', enum: ['editor', 'viewer', 'incident_editor'], description: 'editor: задачи и инциденты; viewer: только чтение; incident_editor: запись только инцидентов. is_superadmin даёт полный доступ.' };
  for (const name of ['User', 'AuthSession']) spec.components.schemas[name].properties.access_role = role;
  const create = spec.paths['/users'].post;
  create.description = 'Только главный администратор. Без login/password создаётся исполнитель; с ними — учётная запись. Пароль хранится только как scrypt-хеш.';
  Object.assign(create.requestBody.content['application/json'].schema.properties, {
    access_role: role,
    login: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-zA-Z0-9_.-]{3,64}$' },
    password: { type: 'string', minLength: 8, maxLength: 256, writeOnly: true },
  });
  const update = spec.paths['/users/{id}'].patch;
  update.description = 'Профиль: свой или любой для главного администратора. access_role меняет только главный администратор; изменение отзывает старые сессии. is_superadmin через API не меняется. role_text — должность, не права доступа.';
  update.requestBody.content['application/json'].schema.properties.access_role = role;
  for (const path of ['/incidents', '/incidents/{id}']) for (const [method, operation] of Object.entries(spec.paths[path])) {
    if (method !== 'get') operation.description = 'Доступно главному администратору, editor и incident_editor. viewer — только чтение.';
  }
}
