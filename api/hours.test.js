import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, completedOn } from './tracker-hours.js';
const now = new Date('2026-10-26T18:00:00Z');
const done = { status: 'завершена', due_at: '2025-01-01', updated_at: '2026-10-25' };
const event = (id, date, old, next, source = 'simpletracker') => ({ id, occurred_at: date, received_at: date, source, changes: { status: { old, new: next } } });
test('completion uses Moscow calendar boundary, never planned deadline or updated_at', () => {
  assert.equal(calendarDate('2025-12-31T22:00:00Z'), '2026-01-01');
  assert.equal(calendarDate(null), null);
  assert.equal(completedOn(done, [], now), null);
  assert.equal(completedOn(done, [event('1','2025-12-31T22:00:00Z','разработка','завершена')], now), '2026-01-01');
});
test('reopening followed by completion uses last actual completion, unfinished is never completed', () => {
  const events = [event('1','2025-10-01','разработка','done'), event('2','2026-01-02','done','разработка'), event('3','2026-03-10','разработка','завершена')];
  assert.equal(completedOn(done, events, now), '2026-03-10');
  assert.equal(completedOn({status:'разработка'}, events, now), null);
  assert.equal(completedOn(done, events.slice(0, 2), now), null);
});
test('Jira transitions, no-op records, and future entries do not change actual completion', () => {
  const events = [event('1','2026-04-01','разработка','done','legacy'), event('2','2026-06-01','done','завершена'), event('3','2026-10-01','разработка','done','jira'), event('4','2027-01-01','разработка','done')];
  assert.equal(completedOn(done, events, now), '2026-04-01');
});
test('undated transition after known completion makes its year unknown', () => {
  const events = [event('1','2025-12-31','разработка','done'), { ...event('2',null,'разработка','done'), received_at: '2026-01-03' }];
  assert.equal(completedOn(done, events, now), null);
  events[1].received_at = '2025-01-01';
  assert.equal(completedOn(done, events, now), '2025-12-31');
});
