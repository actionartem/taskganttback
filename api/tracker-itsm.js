import { fail, RequestError } from './tracker-domain.js';
import { itsmRelay } from './tracker-itsm-relay.js';

const ORIGIN = 'https://api.itsm.mos.ru';
export const ITSM_SECTIONS = {
  notes: 'Комментарии и заметки', audit: 'История изменений', note_attachments: 'Вложения',
  affected_slas: 'Показатели SLA', cis: 'Оборудование', grouped_requests: 'Связанные обращения',
  inbound_emails: 'Входящие письма', knowledge_articles: 'База знаний',
  automation_rules: 'Правила автоматизации', sprint_backlog_items: 'Спринты', tags: 'Метки', watches: 'Наблюдатели',
};

const remoteError = (status) => status === 404 ? 'Инцидент не найден в МосИТСМ'
  : [401, 403].includes(status) ? 'МосИТСМ не разрешил чтение этого раздела'
  : status === 429 ? 'МосИТСМ ограничил частоту запросов. Повторите позже'
  : 'МосИТСМ временно не отвечает';

export function createItsmClient({ token = process.env.MOS_ITSM_TOKEN, fetchImpl = fetch, timeoutMs = 12000, overallMs = 60000, maxPages = 100, maxBytes = 32 * 1024 * 1024, transport = process.env.MOS_ITSM_TRANSPORT || 'direct', relay = itsmRelay } = {}) {
  const relayed = transport === 'relay';
  if (!['direct','relay'].includes(transport)) throw new Error('Invalid MOS_ITSM_TRANSPORT');
  const configured = relayed ? relay.configured : Boolean(token);
  async function json(url, signal, budget) {
    if (!configured) fail('Подключение к МосИТСМ ещё не настроено на сервере', 503);
    if (signal.aborted) fail('Загрузка МосИТСМ отменена или превысила время ожидания', 504);
    if (++budget.requests > 250 || budget.bytes > maxBytes) fail('Достигнут предел объёма загрузки МосИТСМ; раздел получен не полностью', 502);
    let response;
    try {
      response = relayed ? await relay.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) }) : await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'X-4me-Account': 'echd', Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) { if (error instanceof RequestError) throw error; fail('Не удалось дождаться ответа МосИТСМ', 504); }
    if (!response.ok) {
      const error = new RequestError(response.status === 404 ? 404 : 502, remoteError(response.status));
      error.upstreamStatus = response.status;
      throw error;
    }
    // Read a bounded stream rather than trusting Content-Length from the remote API.
    let length = 0; const chunks = [];
    if (!response.body) fail('МосИТСМ вернул пустой ответ', 502);
    for await (const chunk of response.body) {
      length += chunk.length;
      budget.bytes += chunk.length;
      if (length > 12 * 1024 * 1024 || budget.bytes > maxBytes) fail('Ответ МосИТСМ слишком большой; раздел получен не полностью', 502);
      chunks.push(chunk);
    }
    try { return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), link: response.headers.get('link') }; }
    catch { fail('МосИТСМ вернул некорректный ответ', 502); }
  }
  function pathFor(number) {
    if (!/^[1-9]\d{0,14}$/.test(number)) fail('Для МосИТСМ нужен числовой номер инцидента', 400);
    return `/v1/requests/${number}`;
  }
  async function record(number, signal = AbortSignal.timeout(overallMs), budget = { bytes: 0, requests: 0 }) {
    const { data } = await json(ORIGIN + pathFor(number), signal, budget);
    if (!data || Array.isArray(data) || String(data.id) !== String(BigInt(number))) fail('МосИТСМ вернул другой инцидент', 502);
    return data;
  }
  async function collection(path, signal, budget) {
    let url = new URL(ORIGIN + path + '?per_page=100');
    const visited = new Set(), ids = new Set(), items = [];
    try {
      while (url) {
        if (visited.has(url.href) || visited.size >= maxPages) fail('Раздел получен не полностью: превышен предел страниц', 502);
        visited.add(url.href);
        const { data, link } = await json(url.href, signal, budget);
        if (!Array.isArray(data)) fail('МосИТСМ вернул некорректный список', 502);
        for (const item of data) {
          if (item?.id == null || !ids.has(String(item.id))) items.push(item);
          if (item?.id != null) ids.add(String(item.id));
        }
        const next = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
        url = next ? new URL(next, url) : null;
        if (url && (url.origin !== ORIGIN || url.pathname !== path || url.username || url.password)) fail('МосИТСМ вернул недопустимую ссылку следующей страницы', 502);
      }
      return { items, complete: true, error: null, upstream_status: null };
    } catch (error) {
      return { items, complete: false, error: error instanceof RequestError ? error.message : 'Не удалось прочитать раздел', upstream_status: error.upstreamStatus || null };
    }
  }
  return {
    configured,
    record,
    async details(number, callerSignal) {
      const timeout = AbortSignal.timeout(overallMs), signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const path = pathFor(number), budget = { bytes: 0, requests: 0 };
      const data = await record(number, signal, budget), entries = Object.entries(ITSM_SECTIONS), sections = {};
      // Limit parallel requests to the provider; no background polling or ITSM writes.
      let cursor = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < entries.length) {
          const [key, title] = entries[cursor++];
          sections[key] = { title, ...await collection(`${path}/${key}`, signal, budget) };
        }
      }));
      return { record: data, sections, checked_at: new Date().toISOString() };
    },
  };
}

function syncDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value)) || +value.slice(0, 4) < 2000 || +value.slice(0, 4) > 2100)
    fail(`В МосИТСМ нет корректного значения «${label}». Локальные поля не изменены`, 422);
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10))
    fail(`МосИТСМ вернул несуществующую дату «${label}». Локальные поля не изменены`, 422);
  return new Date(value).toISOString();
}
export function incidentSyncFields(record) {
  const priority = new Map([['low','low'],['medium','medium'],['high','high'],['top','high']]).get(record.impact);
  if (!priority) fail('В МосИТСМ не указан уровень важности. Локальные поля не изменены', 422);
  const expires_at = syncDate(record.resolution_target_at, 'Срок решения');
  const is_deferred = record.status === 'waiting_for';
  const deferred_until = is_deferred ? syncDate(record.waiting_until, 'Отложен до') : null;
  if (deferred_until && deferred_until <= expires_at) fail('Дата ожидания МосИТСМ не позже срока решения. Проверьте сроки вручную; локальные поля не изменены', 422);
  return { priority, expires_at, is_deferred, deferred_until };
}

export function incidentSyncPreview(record) {
  try { return { values: incidentSyncFields(record), error: null }; }
  catch (error) { return { values: null, error: error.message }; }
}
