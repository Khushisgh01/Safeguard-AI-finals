

// backend/services/smsService.js
const isConfigured =
  !!process.env.SMS_ACCOUNT_SID &&
  !!process.env.SMS_AUTH_TOKEN &&
  !!process.env.SMS_FROM_NUMBER &&
  process.env.SMS_ACCOUNT_SID.startsWith('AC') &&
  process.env.SMS_ACCOUNT_SID.length > 10;

let client = null;
if (isConfigured) {
  try {
    const twilio = require('twilio');
    client = twilio(process.env.SMS_ACCOUNT_SID, process.env.SMS_AUTH_TOKEN);
  } catch (error) {
    console.warn('Failed to initialize Twilio client:', error.message);
    client = null;
  }
}

/** Send one SMS (Twilio if configured, otherwise mock-log). */
async function sendSMS(to, body) {
  if (!to || !body) throw new Error('Missing SMS "to" or "body"');
  // Normalize phone number to E.164 if possible. If no leading '+',
  // prepend default country code from env (e.g., +91) for local testing.
  const defaultCountryCode = process.env.SMS_DEFAULT_COUNTRY_CODE || '+91';
  const digitsOnly = String(to).replace(/[^\d+]/g, '');
  const normalizedTo = digitsOnly.startsWith('+')
    ? digitsOnly
    : `${defaultCountryCode}${digitsOnly.replace(/^0+/, '')}`;
  if (!isConfigured) {
    console.log(`[MOCK SMS] to=${normalizedTo} body="${body}"`);
    return { status: 'mocked', to: normalizedTo };
  }
  const msg = await client.messages.create({
    to: normalizedTo,
    from: process.env.SMS_FROM_NUMBER,
    body,
  });
  return { status: 'sent', sid: msg.sid, to: normalizedTo };
}

/** Send to many numbers (best effort). */
async function sendMany(numbers, body) {
  const unique = [...new Set(numbers.filter(Boolean))];
  const results = await Promise.allSettled(unique.map(n => sendSMS(n, body)));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? { to: unique[i], ok: true, data: r.value }
      : { to: unique[i], ok: false, error: r.reason?.message || String(r.reason) }
  );
}

/** Compatibility helper used by alerts.js */
async function sendAlertSMS(to, alert) {
  const text =
    `[FamilySafe] ${alert.title}\n` +
    `${alert.description}\n` +
    (alert.location ? `Location: ${alert.location}\n` : '') +
    `Severity: ${String(alert.severity).toUpperCase()}`;
  return sendSMS(to, text);
}

module.exports = { sendSMS, sendMany, sendAlertSMS, isConfigured };