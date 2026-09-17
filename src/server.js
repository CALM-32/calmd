// server.js — نقطة الدخول الرئيسية للـ Backend
// خادم HTTP بسيط بدون أي حزم خارجية (فقط وحدات Node.js المدمجة) — يعمل مباشرة بأمر: node src/server.js
'use strict';

// تحميل ملف .env تلقائيًا إن وُجد (دعم مدمج في Node 22+، لا حاجة لحزمة dotenv)
try {
  process.loadEnvFile();
} catch (err) {
  // لا مشكلة إن لم يوجد ملف .env — يعمل النظام بالقيم الافتراضية/متغيرات البيئة الحالية
}

const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./db');
const { getAvailableSlots, computeInternalDuration } = require('./availabilityEngine');
const payments = require('./paymentService');
const maps = require('./mapsService');
const notifications = require('./notificationService');
const holdManager = require('./holdManager');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// مصادقة الإدارة — تسجيل دخول بسيط بكلمة مرور واحدة + رموز جلسة (بدون أي حزمة خارجية)
// ---------------------------------------------------------------------------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.log('');
  console.log('⚠️  لم يتم ضبط ADMIN_PASSWORD — تم توليد كلمة مرور مؤقتة لهذه الجلسة فقط:');
  console.log(`    ${ADMIN_PASSWORD}`);
  console.log('    اضبط ADMIN_PASSWORD في ملف .env قبل النشر الفعلي حتى لا تتغيّر مع كل إعادة تشغيل.');
  console.log('');
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const adminSessions = new Map(); // token -> expiryTimestamp

function createAdminSession() {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isValidAdminToken(token) {
  if (!token) return false;
  const expiry = adminSessions.get(token);
  if (!expiry || expiry < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  adminSessions.set(token, Date.now() + SESSION_TTL_MS); // تمديد الجلسة عند الاستخدام
  return true;
}
function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('صيغة JSON غير صحيحة'));
      }
    });
    req.on('error', reject);
  });
}

function audit(actorType, actorId, action, targetType, targetId) {
  db.prepare(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id) VALUES (?,?,?,?,?)`
  ).run(actorType, actorId ?? null, action, targetType ?? null, targetId ?? null);
}

// ---------------------------------------------------------------------------
// معالجات المسارات
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  // pattern مثل /api/staff/:id/bookings
  const paramNames = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[^/]+/g, (m) => {
        paramNames.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, paramNames, handler });
}

/** مثل route()، لكنها تتطلب تسجيل دخول إداري صالح قبل تنفيذ المعالج — تُستخدم لكل مسارات /api/admin/* الحساسة */
function adminRoute(method, pattern, handler) {
  route(method, pattern, async (req, res, params, query) => {
    if (!isValidAdminToken(getBearerToken(req))) {
      return sendJson(res, 401, { error: 'غير مصرح — الرجاء تسجيل الدخول كمسؤول' });
    }
    return handler(req, res, params, query);
  });
}

// ---- تسجيل دخول الإدارة ----
route('POST', '/api/admin/login', async (req, res) => {
  const b = await readBody(req);
  if (b.password !== ADMIN_PASSWORD) {
    return sendJson(res, 401, { error: 'كلمة المرور غير صحيحة' });
  }
  const token = createAdminSession();
  audit('admin', null, 'login', null, null);
  sendJson(res, 200, { token, expiresInMs: SESSION_TTL_MS });
});
route('POST', '/api/admin/logout', async (req, res) => {
  const token = getBearerToken(req);
  if (token) adminSessions.delete(token);
  sendJson(res, 200, { ok: true });
});

// ---- الخدمات ----
route('GET', '/api/services', async (req, res) => {
  const rows = db.prepare(`SELECT * FROM services ORDER BY id`).all();
  sendJson(res, 200, rows);
});

adminRoute('POST', '/api/admin/services', async (req, res) => {
  const b = await readBody(req);
  const info = db
    .prepare(
      `INSERT INTO services (name, price, duration_minutes, prep_minutes, buffer_minutes, is_active)
       VALUES (?,?,?,?,?,1)`
    )
    .run(b.name, b.price, b.duration_minutes, b.prep_minutes ?? 10, b.buffer_minutes ?? 3);
  audit('admin', null, 'create_service', 'service', info.lastInsertRowid);
  sendJson(res, 201, { id: info.lastInsertRowid });
});

adminRoute('PATCH', '/api/admin/services/:id', async (req, res, params) => {
  const b = await readBody(req);
  const existing = db.prepare(`SELECT * FROM services WHERE id = ?`).get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'الخدمة غير موجودة' });
  const merged = { ...existing, ...b };
  db.prepare(
    `UPDATE services SET name=?, price=?, duration_minutes=?, prep_minutes=?, buffer_minutes=?, is_active=? WHERE id=?`
  ).run(
    merged.name,
    merged.price,
    merged.duration_minutes,
    merged.prep_minutes,
    merged.buffer_minutes,
    merged.is_active ? 1 : 0,
    params.id
  );
  audit('admin', null, 'update_service', 'service', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- الموظفون ----
route('GET', '/api/staff', async (req, res) => {
  const rows = db.prepare(`SELECT id, internal_name, flag, commission_percent, is_on_leave, rating_avg, rating_count FROM staff`).all();
  sendJson(res, 200, rows);
});

adminRoute('POST', '/api/admin/staff', async (req, res) => {
  const b = await readBody(req);
  const info = db
    .prepare(
      `INSERT INTO staff (internal_name, flag, phone, commission_percent, base_lat, base_lng) VALUES (?,?,?,?,?,?)`
    )
    .run(b.internal_name, b.flag, b.phone ?? null, b.commission_percent ?? 40, b.base_lat ?? null, b.base_lng ?? null);
  // جدول عمل افتراضي (سبت-خميس 10ص-10م) — يُعدَّل لاحقًا من لوحة الإدارة
  const insSched = db.prepare(`INSERT INTO staff_schedule (staff_id, day_of_week, start_minutes, end_minutes) VALUES (?,?,?,?)`);
  for (const dow of [0, 1, 2, 3, 4, 6]) insSched.run(info.lastInsertRowid, dow, 10 * 60, 22 * 60);
  audit('admin', null, 'create_staff', 'staff', info.lastInsertRowid);
  sendJson(res, 201, { id: info.lastInsertRowid });
});

adminRoute('PATCH', '/api/admin/staff/:id', async (req, res, params) => {
  const b = await readBody(req);
  const existing = db.prepare(`SELECT * FROM staff WHERE id=?`).get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'الموظف غير موجود' });
  const merged = { ...existing, ...b };
  db.prepare(`UPDATE staff SET commission_percent=?, is_on_leave=? WHERE id=?`).run(
    merged.commission_percent,
    merged.is_on_leave ? 1 : 0,
    params.id
  );
  audit('admin', null, 'update_staff', 'staff', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- قائمة الموظفين الموسّعة للوحة الإدارة (تقييم، إنجاز، مستحقات) ----
adminRoute('GET', '/api/admin/staff', async (req, res) => {
  const rows = db.prepare(`SELECT * FROM staff`).all();
  const enriched = rows.map((s) => {
    const completed = db
      .prepare(`SELECT COUNT(*) as c FROM bookings WHERE staff_id=? AND status='completed'`)
      .get(s.id).c;
    const dues = db
      .prepare(`SELECT COALESCE(SUM(amount),0) as d FROM commissions_ledger WHERE staff_id=? AND paid_out=0`)
      .get(s.id).d;
    return { ...s, completed_bookings: completed, dues };
  });
  sendJson(res, 200, enriched);
});

// ---- التوفر (محرك الحجز الحقيقي) ----
route('GET', '/api/availability', async (req, res, params, query) => {
  const dateStr = query.get('date');
  const serviceIds = (query.get('serviceIds') || '').split(',').filter(Boolean).map(Number);
  const staffParam = query.get('staffId'); // رقم أو 'any'
  const lat = query.get('lat') ? Number(query.get('lat')) : null;
  const lng = query.get('lng') ? Number(query.get('lng')) : null;
  const excludeBookingId = query.get('excludeBookingId') ? Number(query.get('excludeBookingId')) : null;

  if (!dateStr || !serviceIds.length) {
    return sendJson(res, 400, { error: 'التاريخ والخدمات مطلوبة' });
  }

  try {
    if (staffParam && staffParam !== 'any') {
      const result = await getAvailableSlots({
        staffId: Number(staffParam),
        dateStr,
        serviceIds,
        customerLat: lat,
        customerLng: lng,
        excludeBookingId,
      });
      return sendJson(res, 200, result);
    }

    // "لا يهمني" — نجمع كل الأوقات المتاحة من كل الموظفات غير المتعطلات
    const allStaff = db.prepare(`SELECT id FROM staff WHERE is_on_leave = 0`).all();
    const merged = new Map(); // time -> {time, staffOptions: [staffId,...]}
    let meta = null;
    for (const s of allStaff) {
      const result = await getAvailableSlots({
        staffId: s.id,
        dateStr,
        serviceIds,
        customerLat: lat,
        customerLng: lng,
        excludeBookingId,
      });
      meta = { customerVisibleMinutes: result.customerVisibleMinutes, internalMinutes: result.internalMinutes };
      result.slots.forEach((slot) => {
        if (!merged.has(slot.time)) merged.set(slot.time, { ...slot, staffOptions: [s.id] });
        else merged.get(slot.time).staffOptions.push(s.id);
      });
    }
    const slots = [...merged.values()].sort((a, b) => a.time.localeCompare(b.time));
    sendJson(res, 200, { slots, ...meta });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

// ---- إنشاء حجز (حجز مؤقت + بدء عملية الدفع) ----
route('POST', '/api/bookings', async (req, res) => {
  const b = await readBody(req);
  const { name, phone, serviceIds, staffId, date, time, address, lat, lng, campaignSlug } = b;

  if (!name || !phone || !serviceIds?.length || !date || !time) {
    return sendJson(res, 400, { error: 'بيانات الحجز غير مكتملة' });
  }

  const services = serviceIds.map((id) => db.prepare(`SELECT * FROM services WHERE id=?`).get(id));
  if (services.some((s) => !s)) return sendJson(res, 400, { error: 'خدمة غير صالحة' });
  const { internalMinutes, customerVisibleMinutes } = computeInternalDuration(services);
  const totalPrice = services.reduce((a, s) => a + s.price, 0);

  // حل "لا يهمني" باختيار أول موظفة متاحة فعليًا لهذا الوقت
  let resolvedStaffId = staffId;
  if (staffId === 'any') {
    const availability = await getAvailableSlots({
      staffId: null,
      dateStr: date,
      serviceIds,
      customerLat: lat,
      customerLng: lng,
    }).catch(() => null);
    // في حال "any" نعيد فحص كل موظفة يدويًا للتبسيط
    const allStaff = db.prepare(`SELECT id FROM staff WHERE is_on_leave = 0`).all();
    for (const s of allStaff) {
      const r = await getAvailableSlots({ staffId: s.id, dateStr: date, serviceIds, customerLat: lat, customerLng: lng });
      if (r.slots.some((sl) => sl.time === time)) {
        resolvedStaffId = s.id;
        break;
      }
    }
    if (resolvedStaffId === 'any') return sendJson(res, 409, { error: 'لا يوجد موظف متاح لهذا الوقت الآن' });
  }

  // إعادة التحقق من توفر الوقت لحظة الحجز (منع التعارض مع طلبات متزامنة)
  const check = await getAvailableSlots({
    staffId: Number(resolvedStaffId),
    dateStr: date,
    serviceIds,
    customerLat: lat,
    customerLng: lng,
  });
  const chosenSlot = check.slots.find((s) => s.time === time);
  if (!chosenSlot) return sendJson(res, 409, { error: 'عذرًا، هذا الوقت لم يعد متاحًا. الرجاء اختيار وقت آخر.' });

  // إيجاد/إنشاء العميل
  let customer = db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(phone);
  if (!customer) {
    const info = db.prepare(`INSERT INTO customers (name, phone) VALUES (?,?)`).run(name, phone);
    customer = { id: info.lastInsertRowid };
  }

  // حملة تسويقية (اختياري)
  let campaignId = null;
  if (campaignSlug) {
    const camp = db.prepare(`SELECT id FROM marketing_campaigns WHERE slug = ?`).get(campaignSlug);
    if (camp) campaignId = camp.id;
  }

  const holdExpiresAt = new Date(Date.now() + holdManager.HOLD_MINUTES * 60000).toISOString();

  const bookingInfo = db
    .prepare(
      `INSERT INTO bookings
       (customer_id, staff_id, status, scheduled_start, internal_start, internal_end, customer_visible_end,
        address_text, location_lat, location_lng, total_price, campaign_id, hold_expires_at)
       VALUES (?,?, 'pending_payment', ?,?,?,?, ?,?,?, ?, ?, ?)`
    )
    .run(
      customer.id,
      resolvedStaffId,
      chosenSlot.internal_start,
      chosenSlot.internal_start,
      chosenSlot.internal_end,
      chosenSlot.customer_visible_end,
      address ?? null,
      lat ?? null,
      lng ?? null,
      totalPrice,
      campaignId,
      holdExpiresAt
    );

  const bookingId = bookingInfo.lastInsertRowid;
  const insBS = db.prepare(
    `INSERT INTO booking_services (booking_id, service_id, sequence_order) VALUES (?,?,?)`
  );
  serviceIds.forEach((sid, i) => insBS.run(bookingId, sid, i));

  const payment = await payments.createPayment({
    bookingId,
    amount: totalPrice,
    callbackUrl: `http://localhost:${PORT}/api/payments/webhook`,
  });
  db.prepare(`INSERT INTO payments (booking_id, amount, gateway, gateway_ref, status) VALUES (?,?,?,?, 'initiated')`).run(
    bookingId,
    totalPrice,
    'moyasar',
    payment.paymentId
  );

  holdManager.scheduleExpiry(bookingId);
  notifications.log('admin', bookingId, 'new_booking', `حجز جديد #${bookingId} بانتظار الدفع`);
  audit('customer', customer.id, 'create_booking', 'booking', bookingId);

  sendJson(res, 201, {
    bookingId,
    totalPrice,
    customerVisibleMinutes,
    holdExpiresAt,
    payment,
  });
});

// ---- Webhook تأكيد الدفع ----
route('POST', '/api/payments/webhook', async (req, res) => {
  const body = await readBody(req);
  const verification = payments.verifyWebhookPayload(body);

  const bookingId = body.bookingId || verification.bookingId;
  if (!verification.valid || !bookingId) {
    return sendJson(res, 400, { error: 'فشل التحقق من عملية الدفع' });
  }

  const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  if (booking.status !== 'pending_payment') {
    return sendJson(res, 200, { ok: true, note: 'تمت معالجة هذا الحجز مسبقًا' });
  }

  db.prepare(`UPDATE bookings SET status='confirmed' WHERE id=?`).run(bookingId);
  db.prepare(`UPDATE payments SET status='paid', paid_at=datetime('now') WHERE booking_id=?`).run(bookingId);
  holdManager.clearExpiry(bookingId);

  if (booking.campaign_id) {
    db.prepare(`INSERT INTO campaign_visits (campaign_id) VALUES (?)`).run(booking.campaign_id);
  }

  notifications.log('staff', bookingId, 'booking_confirmed', `تم تأكيد الحجز #${bookingId} — موعدك الجديد بالانتظار`);
  notifications.log('admin', bookingId, 'payment_success', `نجح الدفع للحجز #${bookingId}`);

  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(booking.customer_id);
  if (customer) {
    await notifications.sendWhatsApp(customer.phone, `تم تأكيد حجزك في هُدوء رقم #${bookingId}. نراك قريبًا 🌿`);
  }

  sendJson(res, 200, { ok: true });
});

// ---- حجوزات موظف معيّن (لواجهة الموظف) ----
route('GET', '/api/staff/:id/bookings', async (req, res, params, query) => {
  const dateStr = query.get('date') || new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT b.*, c.name as customer_name FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       WHERE b.staff_id = ? AND date(b.internal_start) = date(?)
       AND b.status IN ('confirmed','staff_onway','arrived','prep','in_service','between_services','wrapup','completed')
       ORDER BY b.internal_start ASC`
    )
    .all(params.id, dateStr);

  const withServices = rows.map((b) => ({
    ...b,
    services: db
      .prepare(
        `SELECT s.* , bs.started_at, bs.ended_at, bs.sequence_order FROM booking_services bs
         JOIN services s ON s.id = bs.service_id WHERE bs.booking_id = ? ORDER BY bs.sequence_order`
      )
      .all(b.id),
  }));
  sendJson(res, 200, withServices);
});

// ---- حالة حجز معيّن (لواجهة العميل — بدون كشف بيانات الموظف الشخصية) ----
route('GET', '/api/bookings/:id', async (req, res, params) => {
  const b = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!b) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  const staff = b.staff_id ? db.prepare(`SELECT flag FROM staff WHERE id=?`).get(b.staff_id) : null;
  sendJson(res, 200, {
    id: b.id,
    status: b.status,
    scheduled_start: b.scheduled_start,
    customer_visible_end: b.customer_visible_end,
    total_price: b.total_price,
    staff_id: b.staff_id,
    staff_flag: staff ? staff.flag : null,
    arrived_at: b.arrived_at,
    can_modify: b.status === 'confirmed',
    cancellation_fee: b.cancellation_fee,
    refund_amount: b.refund_amount,
  });
});

// ---- تحديث حالة الحجز من واجهة الموظف ----
route('POST', '/api/bookings/:id/status', async (req, res, params) => {
  const b = await readBody(req);
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });

  const bServices = db
    .prepare(`SELECT * FROM booking_services WHERE booking_id=? ORDER BY sequence_order`)
    .all(params.id);

  switch (b.action) {
    case 'arrived':
      db.prepare(`UPDATE bookings SET status='arrived', arrived_at=datetime('now') WHERE id=?`).run(params.id);
      notifications.log('admin', params.id, 'staff_arrived', `وصل الموظف للحجز #${params.id}`);
      break;

    case 'ready_start_service': {
      const first = bServices[0];
      db.prepare(`UPDATE booking_services SET started_at=datetime('now') WHERE id=?`).run(first.id);
      db.prepare(`UPDATE bookings SET status='in_service', current_service_index=0 WHERE id=?`).run(params.id);
      notifications.log('admin', params.id, 'service_started', `بدأت الخدمة للحجز #${params.id}`);
      break;
    }

    case 'finish_current_service': {
      const idx = booking.current_service_index;
      const current = bServices[idx];
      db.prepare(`UPDATE booking_services SET ended_at=datetime('now') WHERE id=?`).run(current.id);

      if (idx >= bServices.length - 1) {
        db.prepare(`UPDATE bookings SET status='wrapup' WHERE id=?`).run(params.id);
        notifications.log('admin', params.id, 'all_services_done', `انتهت جميع خدمات الحجز #${params.id}`);
      } else {
        db.prepare(`UPDATE bookings SET status='between_services' WHERE id=?`).run(params.id);
        notifications.log('admin', params.id, 'service_finished', `انتهت خدمة ضمن الحجز #${params.id}`);
      }
      break;
    }

    case 'start_next_service': {
      const nextIdx = booking.current_service_index + 1;
      const next = bServices[nextIdx];
      db.prepare(`UPDATE booking_services SET started_at=datetime('now') WHERE id=?`).run(next.id);
      db.prepare(`UPDATE bookings SET status='in_service', current_service_index=? WHERE id=?`).run(nextIdx, params.id);
      break;
    }

    case 'finish_booking': {
      db.prepare(`UPDATE bookings SET status='completed' WHERE id=?`).run(params.id);
      const staff = db.prepare(`SELECT * FROM staff WHERE id=?`).get(booking.staff_id);
      const commissionAmount = (booking.total_price * staff.commission_percent) / 100;
      db.prepare(
        `INSERT INTO commissions_ledger (staff_id, booking_id, amount, percent_applied) VALUES (?,?,?,?)`
      ).run(staff.id, params.id, commissionAmount, staff.commission_percent);
      notifications.log('admin', params.id, 'booking_completed', `اكتمل الحجز #${params.id} بالكامل`);
      notifications.log('customer', params.id, 'thank_you', `شكرًا لاختيارك هُدوء — نرجو تقييم تجربتك`);
      break;
    }

    default:
      return sendJson(res, 400, { error: 'إجراء غير معروف' });
  }

  audit('staff', booking.staff_id, `status:${b.action}`, 'booking', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- التقييم ----
route('POST', '/api/bookings/:id/rating', async (req, res, params) => {
  const b = await readBody(req);
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });

  db.prepare(
    `INSERT INTO ratings (booking_id, staff_id, stars, cleanliness_stars, punctuality_stars, comment) VALUES (?,?,?,?,?,?)`
  ).run(params.id, booking.staff_id, b.stars, b.cleanliness_stars ?? null, b.punctuality_stars ?? null, b.comment ?? null);

  const agg = db
    .prepare(`SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE staff_id=?`)
    .get(booking.staff_id);
  db.prepare(`UPDATE staff SET rating_avg=?, rating_count=? WHERE id=?`).run(agg.avg, agg.cnt, booking.staff_id);

  sendJson(res, 201, { ok: true });
});

const CANCELLATION_FEE_SAR = 10;

// ---- إلغاء الحجز من قبل العميل (مسموح فقط قبل وصول الموظف) ----
route('POST', '/api/bookings/:id/cancel', async (req, res, params) => {
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  if (booking.status !== 'confirmed') {
    return sendJson(res, 409, {
      error: 'لا يمكن إلغاء الحجز بعد توجّه الموظف أو بدء الخدمة — تواصل مع الدعم إن كانت هناك ظروف استثنائية',
    });
  }

  const fee = CANCELLATION_FEE_SAR;
  const refund = Math.max(0, booking.total_price - fee);
  db.prepare(
    `UPDATE bookings SET status='cancelled', cancelled_by='customer', cancellation_fee=?, refund_amount=?, cancelled_at=datetime('now') WHERE id=?`
  ).run(fee, refund, params.id);

  notifications.log('admin', params.id, 'customer_cancelled', `ألغى العميل الحجز #${params.id} — رسوم إلغاء ${fee} ر.س، والمبلغ المسترد ${refund} ر.س`);
  audit('customer', booking.customer_id, 'cancel_booking', 'booking', params.id);
  sendJson(res, 200, { ok: true, cancellationFee: fee, refundAmount: refund });
});

// ---- تعديل موعد الحجز من قبل العميل (مسموح فقط قبل وصول الموظف، بدون رسوم) ----
route('POST', '/api/bookings/:id/reschedule', async (req, res, params) => {
  const b = await readBody(req);
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  if (booking.status !== 'confirmed') {
    return sendJson(res, 409, { error: 'لا يمكن تعديل الموعد بعد توجّه الموظف أو بدء الخدمة' });
  }
  if (!b.date || !b.time) return sendJson(res, 400, { error: 'التاريخ والوقت الجديدان مطلوبان' });

  const svcRows = db
    .prepare(`SELECT service_id FROM booking_services WHERE booking_id=? ORDER BY sequence_order`)
    .all(params.id);
  const serviceIds = svcRows.map((r) => r.service_id);

  const availability = await getAvailableSlots({
    staffId: booking.staff_id,
    dateStr: b.date,
    serviceIds,
    customerLat: booking.location_lat,
    customerLng: booking.location_lng,
    excludeBookingId: booking.id,
  });
  const slot = availability.slots.find((s) => s.time === b.time);
  if (!slot) return sendJson(res, 409, { error: 'عذرًا، هذا الوقت لم يعد متاحًا. الرجاء اختيار وقت آخر.' });

  db.prepare(
    `UPDATE bookings SET scheduled_start=?, internal_start=?, internal_end=?, customer_visible_end=?, rescheduled_count=rescheduled_count+1 WHERE id=?`
  ).run(slot.internal_start, slot.internal_start, slot.internal_end, slot.customer_visible_end, params.id);

  notifications.log('admin', params.id, 'customer_rescheduled', `عدّل العميل موعد الحجز #${params.id} إلى ${b.date} ${b.time}`);
  audit('customer', booking.customer_id, 'reschedule_booking', 'booking', params.id);
  sendJson(res, 200, { ok: true, newDate: b.date, newTime: b.time });
});
adminRoute('GET', '/api/admin/overview', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todaysBookings = db
    .prepare(`SELECT COUNT(*) as c FROM bookings WHERE date(scheduled_start)=date(?) AND status!='cancelled' AND status!='expired'`)
    .get(today).c;
  const revenueToday = db
    .prepare(`SELECT COALESCE(SUM(total_price),0) as s FROM bookings WHERE date(scheduled_start)=date(?) AND status IN ('confirmed','completed','in_service','arrived','wrapup','between_services')`)
    .get(today).s;
  const availableStaff = db.prepare(`SELECT COUNT(*) as c FROM staff WHERE is_on_leave=0`).get().c;
  const totalStaff = db.prepare(`SELECT COUNT(*) as c FROM staff`).get().c;
  const avgRating = db.prepare(`SELECT AVG(rating_avg) as a FROM staff WHERE rating_count>0`).get().a;

  sendJson(res, 200, {
    todaysBookings,
    revenueToday,
    availableStaff,
    totalStaff,
    avgRating: avgRating || 0,
  });
});

adminRoute('GET', '/api/admin/bookings', async (req, res, params, query) => {
  const from = query.get('from');
  const to = query.get('to');
  const dateStr = query.get('date') || new Date().toISOString().slice(0, 10);
  const whereClause = from && to
    ? `date(b.scheduled_start) BETWEEN date(?) AND date(?)`
    : `date(b.scheduled_start) = date(?)`;
  const bindValues = from && to ? [from, to] : [dateStr];
  const rows = db
    .prepare(
      `SELECT b.*, c.name as customer_name, c.phone as customer_phone, s.internal_name as staff_name, s.flag as staff_flag,
              mc.source as campaign_source,
              (SELECT GROUP_CONCAT(sv.name, ' + ') FROM booking_services bs
                 JOIN services sv ON sv.id = bs.service_id
                 WHERE bs.booking_id = b.id ORDER BY bs.sequence_order) as services_summary
       FROM bookings b
       JOIN customers c ON c.id=b.customer_id
       LEFT JOIN staff s ON s.id=b.staff_id
       LEFT JOIN marketing_campaigns mc ON mc.id=b.campaign_id
       WHERE ${whereClause}
       ORDER BY b.scheduled_start`
    )
    .all(...bindValues);
  sendJson(res, 200, rows);
});

// ---- إلغاء حجز من لوحة الإدارة — بدون قيود، بصلاحية كاملة ----
adminRoute('POST', '/api/admin/bookings/:id/cancel', async (req, res, params) => {
  const b = await readBody(req);
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  if (booking.status === 'cancelled') return sendJson(res, 409, { error: 'الحجز ملغى مسبقًا' });

  const fee = Number(b.fee) || 0; // الإدارة تقرر الرسوم، افتراضيًا بدون رسوم
  const refund = Math.max(0, booking.total_price - fee);
  db.prepare(
    `UPDATE bookings SET status='cancelled', cancelled_by='admin', cancellation_fee=?, refund_amount=?, cancelled_at=datetime('now') WHERE id=?`
  ).run(fee, refund, params.id);

  notifications.log('customer', params.id, 'admin_cancelled', `ألغت الإدارة الحجز #${params.id}`);
  audit('admin', null, 'cancel_booking', 'booking', params.id);
  sendJson(res, 200, { ok: true, cancellationFee: fee, refundAmount: refund });
});

// ---- تعديل موعد/موظف حجز من لوحة الإدارة — بدون قيود، بصلاحية كاملة ----
adminRoute('POST', '/api/admin/bookings/:id/reschedule', async (req, res, params) => {
  const b = await readBody(req);
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(params.id);
  if (!booking) return sendJson(res, 404, { error: 'الحجز غير موجود' });
  if (!b.date || !b.time) return sendJson(res, 400, { error: 'التاريخ والوقت الجديدان مطلوبان' });

  const targetStaffId = b.staffId ? Number(b.staffId) : booking.staff_id;
  const svcRows = db
    .prepare(`SELECT service_id FROM booking_services WHERE booking_id=? ORDER BY sequence_order`)
    .all(params.id);
  const serviceIds = svcRows.map((r) => r.service_id);

  const availability = await getAvailableSlots({
    staffId: targetStaffId,
    dateStr: b.date,
    serviceIds,
    customerLat: booking.location_lat,
    customerLng: booking.location_lng,
    excludeBookingId: booking.id,
  });
  const slot = availability.slots.find((s) => s.time === b.time);
  if (!slot) {
    return sendJson(res, 409, { error: 'هذا الوقت غير متاح فعليًا لهذا الموظف (تعارض مع حجز آخر أو خارج ساعات العمل)' });
  }

  db.prepare(
    `UPDATE bookings SET staff_id=?, scheduled_start=?, internal_start=?, internal_end=?, customer_visible_end=?, rescheduled_count=rescheduled_count+1 WHERE id=?`
  ).run(targetStaffId, slot.internal_start, slot.internal_start, slot.internal_end, slot.customer_visible_end, params.id);

  notifications.log('customer', params.id, 'admin_rescheduled', `عدّلت الإدارة موعد الحجز #${params.id} إلى ${b.date} ${b.time}`);
  audit('admin', null, 'reschedule_booking', 'booking', params.id);
  sendJson(res, 200, { ok: true, newDate: b.date, newTime: b.time, staffId: targetStaffId });
});

adminRoute('GET', '/api/admin/finance', async (req, res, params, query) => {
  const period = query.get('period') || 'today';
  const ranges = {
    today: `date(scheduled_start) = date('now')`,
    week: `date(scheduled_start) >= date('now','-7 days')`,
    month: `date(scheduled_start) >= date('now','-30 days')`,
    year: `date(scheduled_start) >= date('now','-365 days')`,
  };
  const cond = ranges[period] || ranges.today;
  const activeStatuses = `('confirmed','completed','in_service','arrived','wrapup','between_services')`;

  const revenue = db
    .prepare(`SELECT COALESCE(SUM(total_price),0) as s FROM bookings WHERE ${cond} AND status IN ${activeStatuses}`)
    .get().s;

  const byService = db
    .prepare(
      `SELECT sv.name, COALESCE(SUM(sv.price),0) as total
       FROM booking_services bs
       JOIN bookings bk ON bk.id = bs.booking_id
       JOIN services sv ON sv.id = bs.service_id
       WHERE ${cond.replace(/scheduled_start/g, 'bk.scheduled_start')} AND bk.status IN ${activeStatuses}
       GROUP BY sv.id ORDER BY total DESC`
    )
    .all();

  const expenseCond = period === 'today' ? `date(expense_date)=date('now')`
    : period === 'week' ? `date(expense_date)>=date('now','-7 days')`
    : period === 'month' ? `date(expense_date)>=date('now','-30 days')`
    : `date(expense_date)>=date('now','-365 days')`;
  const expenses = db.prepare(`SELECT category, SUM(amount) as total FROM expenses WHERE ${expenseCond} GROUP BY category`).all();
  const totalExpenses = expenses.reduce((a, e) => a + e.total, 0);

  const commissions = db
    .prepare(
      `SELECT st.internal_name as name, st.flag, SUM(cl.amount) as total
       FROM commissions_ledger cl JOIN staff st ON st.id=cl.staff_id
       JOIN bookings bk ON bk.id = cl.booking_id
       WHERE ${cond.replace(/scheduled_start/g, 'bk.scheduled_start')}
       GROUP BY cl.staff_id`
    )
    .all();

  sendJson(res, 200, { revenue, byService, expenses, totalExpenses, netProfit: revenue - totalExpenses, commissions });
});

adminRoute('GET', '/api/admin/reports/summary', async (req, res) => {
  const cancelled = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status='cancelled'`).get().c;
  const expired = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status='expired'`).get().c;
  const totalBookings = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status NOT IN ('pending_payment')`).get().c;
  const repeatCustomers = db
    .prepare(
      `SELECT COUNT(*) as c FROM (
         SELECT customer_id FROM bookings WHERE status='completed' GROUP BY customer_id HAVING COUNT(*) > 1
       )`
    )
    .get().c;
  const avgBookingValue = db
    .prepare(`SELECT AVG(total_price) as a FROM bookings WHERE status IN ('confirmed','completed','in_service','arrived','wrapup','between_services')`)
    .get().a;
  const topServices = db
    .prepare(
      `SELECT sv.name, COUNT(*) as count FROM booking_services bs
       JOIN bookings bk ON bk.id=bs.booking_id JOIN services sv ON sv.id=bs.service_id
       WHERE bk.status NOT IN ('pending_payment','cancelled','expired')
       GROUP BY sv.id ORDER BY count DESC LIMIT 5`
    )
    .all();

  sendJson(res, 200, {
    cancelled,
    expired,
    cancellationRate: totalBookings ? (((cancelled + expired) / totalBookings) * 100).toFixed(1) : '0.0',
    repeatCustomers,
    avgBookingValue: avgBookingValue || 0,
    topServices,
  });
});

adminRoute('GET', '/api/admin/reports/services-per-staff', async (req, res) => {
  const rows = db
    .prepare(
      `SELECT st.internal_name as staff_name, st.flag, sv.name as service_name, COUNT(*) as count
       FROM booking_services bs
       JOIN bookings bk ON bk.id = bs.booking_id
       JOIN staff st ON st.id = bk.staff_id
       JOIN services sv ON sv.id = bs.service_id
       WHERE bk.status = 'completed'
       GROUP BY st.id, sv.id
       ORDER BY st.id`
    )
    .all();
  sendJson(res, 200, rows);
});

adminRoute('GET', '/api/admin/notifications', async (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications_log ORDER BY id DESC LIMIT 50`).all();
  sendJson(res, 200, rows);
});

// ---- الإعدادات العامة (رقم واتساب الدعم، قابل للتعديل من لوحة الإدارة) ----
route('GET', '/api/settings/public', async (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key='support_whatsapp'`).get();
  sendJson(res, 200, { support_whatsapp: row ? row.value : null });
});

adminRoute('GET', '/api/admin/settings', async (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const obj = {};
  rows.forEach((r) => (obj[r.key] = r.value));
  sendJson(res, 200, obj);
});

adminRoute('PATCH', '/api/admin/settings', async (req, res) => {
  const b = await readBody(req);
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );
  for (const [key, value] of Object.entries(b)) {
    upsert.run(key, String(value));
  }
  audit('admin', null, 'update_settings', null, null);
  sendJson(res, 200, { ok: true });
});

// ---- المخزون ----
adminRoute('GET', '/api/admin/inventory', async (req, res) => {
  const rows = db.prepare(`SELECT * FROM inventory_items ORDER BY name`).all();
  sendJson(res, 200, rows);
});

adminRoute('POST', '/api/admin/inventory', async (req, res) => {
  const b = await readBody(req);
  const info = db
    .prepare(`INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold, notes) VALUES (?,?,?,?,?)`)
    .run(b.name, b.quantity ?? 0, b.unit || 'قطعة', b.low_stock_threshold ?? 5, b.notes ?? null);
  audit('admin', null, 'create_inventory_item', 'inventory_item', info.lastInsertRowid);
  sendJson(res, 201, { id: info.lastInsertRowid });
});

adminRoute('PATCH', '/api/admin/inventory/:id', async (req, res, params) => {
  const b = await readBody(req);
  const existing = db.prepare(`SELECT * FROM inventory_items WHERE id=?`).get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'الصنف غير موجود' });
  const merged = { ...existing, ...b };
  db.prepare(
    `UPDATE inventory_items SET name=?, quantity=?, unit=?, low_stock_threshold=?, notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(merged.name, merged.quantity, merged.unit, merged.low_stock_threshold, merged.notes, params.id);
  audit('admin', null, 'update_inventory_item', 'inventory_item', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- المستشار الذكي ----
adminRoute('POST', '/api/admin/advisor', async (req, res) => {
  const b = await readBody(req);
  const question = (b.question || '').trim();
  if (!question) return sendJson(res, 400, { error: 'الرجاء كتابة سؤال أو طلب' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_API_KEY) {
    return sendJson(res, 200, {
      answer:
        'ميزة المستشار الذكي تحتاج مفتاح API من Anthropic ليعمل فعليًا.\n\n' +
        'الخطوات: أنشئ مفتاحًا من console.anthropic.com، ثم أضفه في ملف .env كـ:\n' +
        'ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'وأعد تشغيل الخادم. بعدها سيرى المستشار بيانات مشروعك الفعلية (الحجوزات، الإيرادات، المخزون) ويقدّم نصائح مبنية عليها.',
      configured: false,
    });
  }

  // نجهّز للمستشار سياقًا حقيقيًا عن المشروع بدل سؤال عام بلا بيانات
  const today = new Date().toISOString().slice(0, 10);
  const overview = {
    todaysBookings: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE date(scheduled_start)=date(?) AND status NOT IN ('cancelled','expired')`).get(today).c,
    revenueThisMonth: db.prepare(`SELECT COALESCE(SUM(total_price),0) as s FROM bookings WHERE date(scheduled_start)>=date('now','-30 days') AND status IN ('confirmed','completed','in_service','arrived','wrapup','between_services')`).get().s,
    lowStockItems: db.prepare(`SELECT name, quantity, unit, low_stock_threshold FROM inventory_items WHERE quantity <= low_stock_threshold`).all(),
    staffPerformance: db.prepare(`SELECT internal_name, flag, rating_avg, rating_count, commission_percent FROM staff`).all(),
    topServices: db.prepare(
      `SELECT sv.name, COUNT(*) as count FROM booking_services bs
       JOIN bookings bk ON bk.id=bs.booking_id JOIN services sv ON sv.id=bs.service_id
       WHERE bk.status='completed' GROUP BY sv.id ORDER BY count DESC LIMIT 5`
    ).all(),
    cancelledLast30Days: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE status='cancelled' AND date(created_at)>=date('now','-30 days')`).get().c,
  };

  const systemPrompt =
    'أنت مستشار أعمال لمشروع "هُدوء" لخدمات العناية المنزلية (مساج، حمام مغربي، بديكير، منيكير) في السعودية. ' +
    'أجب بالعربية، بإيجاز ووضوح، واستند فقط إلى البيانات الفعلية المرفقة أدناه — لا تخترع أرقامًا. ' +
    'إذا كان السؤال يحتاج بيانات غير متوفرة هنا، وضّح ذلك بدل التخمين.\n\n' +
    'بيانات المشروع الحالية:\n' + JSON.stringify(overview, null, 2);

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error(data?.error?.message || 'فشل الاتصال بخدمة الذكاء الاصطناعي');
    const answer = data.content?.map((c) => c.text || '').join('\n') || 'تعذّر توليد رد.';
    sendJson(res, 200, { answer, configured: true });
  } catch (err) {
    sendJson(res, 200, { answer: 'تعذّر الاتصال بخدمة الذكاء الاصطناعي: ' + err.message, configured: true });
  }
});

// ---- التسويق ----
adminRoute('GET', '/api/marketing/campaigns', async (req, res) => {
  const rows = db
    .prepare(
      `SELECT mc.*,
        (SELECT COUNT(*) FROM campaign_visits WHERE campaign_id=mc.id) as visits,
        (SELECT COUNT(*) FROM bookings WHERE campaign_id=mc.id AND status NOT IN ('cancelled','expired')) as bookings_count,
        (SELECT COALESCE(SUM(total_price),0) FROM bookings WHERE campaign_id=mc.id AND status NOT IN ('cancelled','expired')) as revenue
       FROM marketing_campaigns mc ORDER BY mc.id DESC`
    )
    .all();
  sendJson(res, 200, rows);
});

adminRoute('POST', '/api/marketing/campaigns', async (req, res) => {
  const b = await readBody(req);
  const slug = (b.slug || `${b.source}-${Date.now().toString(36)}`).toLowerCase();
  const info = db
    .prepare(`INSERT INTO marketing_campaigns (source, campaign_name, slug) VALUES (?,?,?)`)
    .run(b.source, b.campaign_name, slug);
  sendJson(res, 201, { id: info.lastInsertRowid, slug });
});

route('GET', '/api/marketing/visit/:slug', async (req, res, params) => {
  const camp = db.prepare(`SELECT * FROM marketing_campaigns WHERE slug=?`).get(params.slug);
  if (!camp) return sendJson(res, 404, { error: 'رابط غير معروف' });
  db.prepare(`INSERT INTO campaign_visits (campaign_id) VALUES (?)`).run(camp.id);
  sendJson(res, 200, { ok: true, campaign: camp });
});

// ---------------------------------------------------------------------------
// تقديم صفحات الواجهة الثلاث كملفات ثابتة — حتى يمكن فتحها من أي جوال على نفس الشبكة
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_ALIASES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/staff': 'staff-app.html',
  '/staff-app.html': 'staff-app.html',
  '/admin': 'admin-dashboard.html',
  '/admin-dashboard.html': 'admin-dashboard.html',
};
function serveStatic(pathname, res) {
  const fileName = STATIC_ALIASES[pathname];
  if (!fileName) return false;
  const filePath = path.join(PUBLIC_DIR, fileName);
  if (!fs.existsSync(filePath)) return false;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(filePath));
  return true;
}
function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// الخادم
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && serveStatic(parsedUrl.pathname, res)) return;

  const match = routes.find(
    (r) => r.method === req.method && r.regex.test(parsedUrl.pathname)
  );

  if (!match) return sendJson(res, 404, { error: 'مسار غير موجود' });

  const values = match.regex.exec(parsedUrl.pathname).slice(1);
  const params = {};
  match.paramNames.forEach((name, i) => (params[name] = values[i]));

  try {
    await match.handler(req, res, params, parsedUrl.searchParams);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'خطأ داخلي في الخادم', detail: err.message });
  }
});

server.listen(PORT, () => {
  const lanIp = getLocalNetworkIp();
  console.log(`🚀 خادم هُدوء يعمل على http://localhost:${PORT}`);
  console.log(`   وضع الدفع: ${payments.TEST_MODE ? 'تجريبي (بدون مفتاح Moyasar حقيقي)' : 'حقيقي'}`);
  console.log('');
  console.log('📱 لفتح الصفحات من جوال الموظف أو العميل (على نفس شبكة الواي فاي):');
  if (lanIp) {
    console.log(`   صفحة العميل   : http://${lanIp}:${PORT}/`);
    console.log(`   واجهة الموظف  : http://${lanIp}:${PORT}/staff`);
    console.log(`   لوحة الإدارة  : http://${lanIp}:${PORT}/admin`);
  } else {
    console.log('   تعذّر تحديد عنوان الشبكة المحلي تلقائيًا — تأكد من اتصال الجهاز بشبكة واي فاي.');
  }
});
