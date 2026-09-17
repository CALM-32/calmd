// holdManager.js — يلغي تلقائيًا أي حجز لم يُدفع خلال مهلة القفل المؤقت (10 دقائق)
// ملاحظة: هذا التنفيذ يعتمد على setTimeout داخل نفس العملية (Process) وهو مناسب لخادم واحد.
// عند التوسع لأكثر من خادم، يُستبدل بمهمة مجدولة عبر طابور مهام (مثل BullMQ + Redis) كما ورد في الخطة.
'use strict';
const db = require('./db');
const notifications = require('./notificationService');

const HOLD_MINUTES = 10;
const timers = new Map();

function scheduleExpiry(bookingId) {
  const timeout = setTimeout(() => {
    const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
    if (booking && booking.status === 'pending_payment') {
      db.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ?`).run(bookingId);
      notifications.log('admin', bookingId, 'hold_expired', `انتهت مهلة الدفع للحجز #${bookingId} وأُعيد الموعد للإتاحة`);
    }
    timers.delete(bookingId);
  }, HOLD_MINUTES * 60 * 1000);
  timers.set(bookingId, timeout);
}

function clearExpiry(bookingId) {
  const t = timers.get(bookingId);
  if (t) {
    clearTimeout(t);
    timers.delete(bookingId);
  }
}

module.exports = { scheduleExpiry, clearExpiry, HOLD_MINUTES };
