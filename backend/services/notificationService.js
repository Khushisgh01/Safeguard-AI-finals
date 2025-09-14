// backend/services/notificationService.js
const { sendMany } = require('./smsService');

/** Fan-out notifier (currently SMS only; add email/push if you want). */
async function notifyContacts({ numbers, message }) {
  const sms = await sendMany(numbers, message);
  return { sms };
}

module.exports = { notifyContacts };