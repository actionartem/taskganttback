// Cache source creation dates without changing local fields, versions or closure results.
export function incidentSourceCreatedAt(incident, record) {
  if (!/^[1-9]\d{0,14}$/.test(incident.number) || String(record?.id) !== String(BigInt(incident.number))) return null;
  const value = record.created_at;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || +value.slice(0,4) < 2000 || +value.slice(0,4) > 2100 || +value.slice(11,13) > 23 || !Number.isFinite(Date.parse(value))) return null;
  const day = new Date(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(+day) || day.toISOString().slice(0,10) !== value.slice(0,10)) return null;
  return new Date(value).toISOString();
}

export async function rememberIncidentCreatedAt(pool, incident, record) {
  const created = incidentSourceCreatedAt(incident, record);
  if (!created) return null;
  const result = await pool.query(`UPDATE incidents SET itsm_created_at=$1
    WHERE id=$2 AND number=$3 AND itsm_created_at IS NULL RETURNING itsm_created_at`, [created,incident.id,incident.number]);
  return result.rows[0]?.itsm_created_at || null;
}

export function createIncidentCreationLoader({ pool, itsm, now = Date.now, batchSize = 20 }) {
  const retryAfter = new Map();
  let running = false;
  return async function load() {
    if (running) return;
    running = true;
    try {
      const { rows } = await pool.query('SELECT id,number FROM incidents WHERE itsm_created_at IS NULL ORDER BY id DESC');
      const key = row => `${row.id}:${row.number}`;
      const pending = new Set(rows.map(key));
      for (const id of retryAfter.keys()) if (!pending.has(id)) retryAfter.delete(id);
      const batch = rows.filter(row => /^[1-9]\d{0,14}$/.test(row.number) && (retryAfter.get(key(row)) || 0) <= now()).slice(0,batchSize);
      let cursor = 0;
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (cursor < batch.length) {
          const incident = batch[cursor++], id = key(incident);
          try {
            const record = await itsm.record(incident.number);
            const created = await rememberIncidentCreatedAt(pool, incident, record);
            if (created) retryAfter.delete(id);
            else retryAfter.set(id, now() + 3600000);
          } catch { retryAfter.set(id, now() + 300000); }
        }
      }));
    } finally { running = false; }
  };
}

export function startIncidentCreationLoader(options) {
  const load = createIncidentCreationLoader(options);
  const tick = () => { void load().catch(error => console.error('incident creation dates failed:', error.code || error.name)); };
  const interval = setInterval(tick, 30000); interval.unref();
  const first = setTimeout(tick, 5000); first.unref();
  return () => { clearInterval(interval); clearTimeout(first); };
}
