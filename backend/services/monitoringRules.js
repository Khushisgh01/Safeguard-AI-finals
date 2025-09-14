

// backend/services/monitoringRules.js
const DEFAULT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 2 * 60 * 1000); // 2 min
const DEFAULT_INACTIVITY_THRESHOLD_MS = Number(process.env.INACTIVITY_THRESHOLD_MS || 3 * 60 * 1000); // 3 min

// In-memory per-process cooldown tracker
const lastFired = new Map(); // key = `${userId}:${type}` -> timestamp

const key = (userId, type) => `${String(userId)}:${String(type).toLowerCase()}`;

function normalizeType(raw) {
  const t = String(raw || '').toLowerCase();
  if (t === 'fall' || t === 'falls') return 'fall';
  if (['inactivity', 'idle', 'prolonged_inactivity'].includes(t)) return 'inactivity';
  if (t === 'normal' || t === 'safe') return 'normal';
  return 'unknown';
}

function shouldFire(userId, type, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS) {
  const k = key(userId, type);
  const last = lastFired.get(k) || 0;
  if (now - last >= cooldownMs) {
    lastFired.set(k, now);
    return true;
  }
  return false;
}

function isDanger({ type, durationMs }) {
  const t = normalizeType(type);
  if (t === 'fall') return true;
  if (t === 'inactivity') {
    return Number(durationMs || 0) >= DEFAULT_INACTIVITY_THRESHOLD_MS;
  }
  return false;
}

function severityFor({ type, confidence = 0, durationMs = 0 }) {
  const t = normalizeType(type);
  if (t === 'fall') {
    if (confidence >= 0.9) return 'critical';
    if (confidence >= 0.7) return 'high';
    return 'medium';
  }
  if (t === 'inactivity') {
    if (durationMs >= DEFAULT_INACTIVITY_THRESHOLD_MS * 2) return 'high';
    if (durationMs >= DEFAULT_INACTIVITY_THRESHOLD_MS) return 'medium';
    return 'low';
  }
  return 'low';
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  normalizeType,
  shouldFire,
  isDanger,
  severityFor,
};