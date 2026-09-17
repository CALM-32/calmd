// notificationService.js — الإشعارات
// يسجّل كل إشعار في notifications_log (تراه لوحة الإدارة لحظيًا عبر API)،
// ويرسل أيضًا عبر واتساب فعليًا إذا تم ضبط بيانات WhatsApp Cloud API.
'use strict';
const db = require('./db');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';

const insertLog = db.prepare(
  `INSERT INTO notifications_log (audience, booking_id, event, message) VALUES (?,?,?,?)`
);

/** يُسجّل إشعارًا داخليًا (تظهر لحظيًا في لوحة الإدارة عبر GET /api/admin/notifications) */
function log(audience, bookingId, event, message) {
  insertLog.run(audience, bookingId ?? null, event, message);
  console.log(`🔔 [${audience}] ${event}: ${message}`);
}

/** إرسال رسالة واتساب فعلية للعميل (يتطلب WhatsApp Business Cloud API مفعّلة) */
async function sendWhatsApp(toPhone, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log(`(وضع تجريبي — بدون WhatsApp API) رسالة إلى ${toPhone}: ${message}`);
    return { simulated: true };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: message },
      }),
    });
    return await res.json();
  } catch (err) {
    console.warn('⚠️ تعذّر إرسال رسالة واتساب:', err.message);
    return { error: err.message };
  }
}

module.exports = { log, sendWhatsApp };
