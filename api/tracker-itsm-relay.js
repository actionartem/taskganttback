// Outbound laptop worker transport. No generic proxy, provider credentials or DB writes.
import crypto from 'node:crypto';
import express from 'express';
import { RequestError } from './tracker-domain.js';

export const RELAY_SECTIONS = new Set(['notes','audit','note_attachments','affected_slas','cis','grouped_requests','inbound_emails','knowledge_articles','automation_rules','sprint_backlog_items','tags','watches']);
export const RELAY_MAX_BYTES = 12 * 1024 * 1024;
export function allowedItsmUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    if (u.origin !== 'https://api.itsm.mos.ru' || u.username || u.password || u.hash || u.href !== value) return false;
    const m = u.pathname.match(/^\/v1\/requests\/[1-9]\d{0,14}(?:\/([a-z_]+))?$/);
    if (!m || (m[1] && !RELAY_SECTIONS.has(m[1]))) return false;
    const seen = new Set();
    for (const [key, val] of u.searchParams) {
      if (seen.has(key) || !['page','per_page'].includes(key) || !/^[1-9]\d{0,5}$/.test(val) || (key === 'per_page' && +val > 100)) return false;
      seen.add(key);
    }
    return true;
  } catch { return false; }
}
const failure = (message, status = 503) => new RequestError(status, message);
const OFFLINE = 'Ноутбук-посредник МосИТСМ не подключён. Локальные данные не изменены';

export function createItsmRelay({ token = process.env.MOS_ITSM_RELAY_TOKEN, timeoutMs = 11000, pollMs = 20000, onlineMs = 10000, maxPending = 64, now = Date.now } = {}) {
  const jobs = new Map(), waiters = new Set();
  let lastSeen = 0;
  const configured = typeof token === 'string' && token.length >= 32;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const expected = configured ? digest(token) : null;
  const authorized = value => configured && typeof value === 'string' && value.length <= 256 && crypto.timingSafeEqual(digest(value), expected);
  const online = () => configured && (waiters.size > 0 || (lastSeen > 0 && now() - lastSeen < onlineMs));
  function notify() { for (const wake of [...waiters]) wake(); }
  async function fetchViaRelay(url, { signal } = {}) {
    if (!allowedItsmUrl(url)) throw failure('Недопустимый ресурс МосИТСМ', 400);
    if (!online()) throw failure(OFFLINE);
    if (jobs.size >= maxPending) throw failure('Посредник МосИТСМ занят. Повторите позже');
    if (signal?.aborted) throw failure('Загрузка МосИТСМ отменена', 504);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(), nonce = crypto.randomBytes(24).toString('hex');
      const finish = (error, response) => {
        if (!jobs.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(response);
      };
      const abort = () => finish(failure('Загрузка МосИТСМ отменена', 504));
      const timer = setTimeout(() => finish(failure('Ноутбук-посредник МосИТСМ не ответил вовремя. Повторите позже', 504)), timeoutMs);
      jobs.set(id, { id, nonce, url, expires_at: now() + timeoutMs, claimed: false, finish });
      signal?.addEventListener('abort', abort, { once: true });
      notify();
    });
  }
  async function poll(capacity, signal) {
    lastSeen = now();
    const take = () => {
      const batch = [];
      for (const j of jobs.values()) {
        if (!j.claimed && j.expires_at > now() && batch.length < capacity) {
          j.claimed = true;
          batch.push({ id: j.id, nonce: j.nonce, url: j.url, expires_at: j.expires_at, max_bytes: RELAY_MAX_BYTES });
        }
      }
      return batch;
    };
    let result = take();
    if (!result.length && !signal?.aborted) result = await new Promise(resolve => {
      let timer;
      const done = batch => { clearTimeout(timer); waiters.delete(wake); signal?.removeEventListener('abort', abort); resolve(batch); };
      const wake = (force = false) => { const batch = take(); if (batch.length || force) done(batch); };
      const abort = () => done([]);
      timer = setTimeout(() => done([]), pollMs);
      waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
    });
    lastSeen = now();
    return result;
  }
  function submit(id, payload) {
    const j = jobs.get(id);
    if (!j || !j.claimed || j.expires_at <= now() || payload?.nonce !== j.nonce) return 409;
    if (payload.error !== undefined) {
      if (!['timeout','network','too_large','invalid_response'].includes(payload.error)) return 400;
      j.finish(failure(payload.error === 'timeout' ? 'Не удалось дождаться ответа МосИТСМ' : 'Ноутбук не смог прочитать МосИТСМ. Повторите позже', 504));
      return 204;
    }
    if (!Number.isInteger(payload.status) || payload.status < 200 || payload.status > 599 || typeof payload.body !== 'string' || payload.body.length > Math.ceil(RELAY_MAX_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(payload.body)) return 400;
    if (payload.link != null && (typeof payload.link !== 'string' || payload.link.length > 16384 || /[\r\n]/.test(payload.link))) return 400;
    const body = Buffer.from(payload.body, 'base64');
    if (body.length > RELAY_MAX_BYTES || body.toString('base64') !== payload.body) return 400;
    // Empty-body statuses are represented faithfully; successful JSON parsing remains the client's job.
    const response = new Response([204,205,304].includes(payload.status) ? null : body, { status: payload.status, headers: { 'Content-Type': 'application/json', ...(payload.link ? { Link: payload.link } : {}) } });
    j.finish(null, response);
    lastSeen = now();
    return 204;
  }
  function stop() {
    for (const j of [...jobs.values()]) j.finish(failure(OFFLINE));
    for (const wake of [...waiters]) wake(true);
    lastSeen = 0;
  }
  return { configured, authorized, online, fetch: fetchViaRelay, poll, submit, stop, stats: () => ({ online: online(), pending: jobs.size, polling: waiters.size }) };
}
export const itsmRelay = createItsmRelay();

export function registerItsmRelayRoutes(app, { relay = itsmRelay } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!relay.authorized(req.get('X-ITSM-Relay-Token'))) return res.status(401).json({ error: 'unauthorized worker' });
    next();
  });
  router.get('/jobs', async (req, res) => {
    const capacity = Number(req.query.capacity || 4);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) return res.status(400).json({ error: 'invalid capacity' });
    if (relay.stats().polling >= 4) return res.status(429).json({ error: 'too many polls' });
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const jobs = await relay.poll(capacity, controller.signal);
    if (!res.destroyed) res.json({ jobs, server_time: Date.now() });
  });
  router.post('/jobs/:id/result', express.json({ limit: '17mb' }), (req, res) => {
    const status = relay.submit(req.params.id, req.body);
    if (status === 204) return res.status(204).end();
    res.status(status).json({ error: status === 409 ? 'expired, duplicate or unknown job' : 'invalid result' });
  });
  router.get('/status', (_req, res) => res.json(relay.stats()));
  router.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid relay payload' }));
  app.use('/integrations/itsm-relay', router);
}
