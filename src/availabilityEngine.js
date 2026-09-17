// availabilityEngine.js — محرك حساب الأوقات المتاحة الحقيقي
// يحسب: وقت التجهيز + مدة كل خدمة + البدل الضائع + الوقت بين الخدمات + وقت الانتقال الفعلي،
// ويمنع أي حجز متداخل مع حجوزات الموظف الحالية.
'use strict';
const db = require('./db');
const { estimateTravelMinutes } = require('./mapsService');

const MIN_TRANSITION_MINUTES = 20; // حد أدنى للانتقال بين عميلين، قابل للتعديل من الإعدادات لاحقًا
const SLOT_STEP_MINUTES = 30;      // دقة عرض الأوقات للعميل

function toMinutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/**
 * يحسب "الوقت التشغيلي الداخلي الكامل" لمجموعة خدمات معيّنة.
 * العميل يرى فقط مجموع duration_minutes، لكن الموظف يحتاج وقتًا أطول فعليًا.
 */
function computeInternalDuration(services) {
  let internalMinutes = 0;
  let customerVisibleMinutes = 0;

  services.forEach((s, i) => {
    if (i === 0) internalMinutes += s.prep_minutes; // تجهيز أولي قبل أول خدمة فقط
    internalMinutes += s.duration_minutes;
    customerVisibleMinutes += s.duration_minutes;
    internalMinutes += s.buffer_minutes; // بدل ضائع بعد كل خدمة
    if (i < services.length - 1) internalMinutes += 3; // وقت بين الخدمات المتتالية
  });

  return { internalMinutes, customerVisibleMinutes };
}

/** يجلب حجوزات موظف معيّن في تاريخ معيّن (غير الملغاة) مرتبة بالوقت */
function getStaffBookingsForDate(staffId, dateStr, excludeBookingId) {
  const rows = db
    .prepare(
      `SELECT * FROM bookings
       WHERE staff_id = ? AND date(internal_start) = date(?)
       AND status NOT IN ('cancelled','expired')
       ORDER BY internal_start ASC`
    )
    .all(staffId, dateStr);
  return excludeBookingId ? rows.filter((b) => b.id !== excludeBookingId) : rows;
}

function isStaffWorkingAt(staffId, date) {
  const dow = date.getDay();
  const minutes = toMinutesSinceMidnight(date);
  const rows = db
    .prepare(`SELECT * FROM staff_schedule WHERE staff_id = ? AND day_of_week = ?`)
    .all(staffId, dow);
  if (!rows.length) return false;
  const onLeave = db
    .prepare(
      `SELECT 1 FROM staff_leaves WHERE staff_id = ? AND date(?) BETWEEN date(date_from) AND date(date_to)`
    )
    .get(staffId, date.toISOString());
  if (onLeave) return false;
  return rows.some((r) => minutes >= r.start_minutes && minutes <= r.end_minutes);
}

/**
 * الدالة الرئيسية: تُرجع قائمة الأوقات المتاحة (بصيغة "HH:MM") لموظف معيّن في تاريخ معيّن،
 * مع الأخذ بالاعتبار موقع العميل الجديد (لحساب وقت الانتقال من آخر حجز سابق).
 */
async function getAvailableSlots({ staffId, dateStr, serviceIds, customerLat, customerLng, excludeBookingId }) {
  const services = serviceIds.map((id) =>
    db.prepare(`SELECT * FROM services WHERE id = ? AND is_active = 1`).get(id)
  );
  if (services.some((s) => !s)) throw new Error('خدمة غير موجودة أو غير مفعّلة');

  const { internalMinutes, customerVisibleMinutes } = computeInternalDuration(services);
  const existingBookings = getStaffBookingsForDate(staffId, dateStr, excludeBookingId);

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const slots = [];

  for (let m = 8 * 60; m <= 23 * 60; m += SLOT_STEP_MINUTES) {
    const candidateStart = addMinutes(dayStart, m);
    if (candidateStart < new Date()) continue; // لا نعرض أوقاتًا في الماضي

    if (!isStaffWorkingAt(staffId, candidateStart)) continue;

    const candidateInternalEnd = addMinutes(candidateStart, internalMinutes);

    // وقت الانتقال المطلوب من آخر حجز سابق ينتهي قبل هذا الوقت
    const prevBooking = [...existingBookings]
      .reverse()
      .find((b) => new Date(b.internal_end) <= candidateStart);

    let requiredGapMinutes = 0;
    if (prevBooking && prevBooking.location_lat != null) {
      const travel = await estimateTravelMinutes(
        prevBooking.location_lat,
        prevBooking.location_lng,
        customerLat,
        customerLng
      );
      requiredGapMinutes = Math.max(MIN_TRANSITION_MINUTES, travel);
      const earliestPossibleStart = addMinutes(new Date(prevBooking.internal_end), requiredGapMinutes);
      if (candidateStart < earliestPossibleStart) continue;
    }

    // تحقق من عدم التداخل مع أي حجز حالي (وليس فقط السابق مباشرة)
    const overlaps = existingBookings.some((b) => {
      const bStart = new Date(b.internal_start);
      const bEnd = new Date(b.internal_end);
      return candidateStart < bEnd && candidateInternalEnd > bStart;
    });
    if (overlaps) continue;

    // تحقق أن الموظف سيبقى ضمن وقت عمله حتى نهاية الخدمة
    const lastMinuteOfShift = addMinutes(candidateStart, internalMinutes);
    if (!isStaffWorkingAt(staffId, addMinutes(lastMinuteOfShift, -1))) continue;

    slots.push({
      time: `${String(candidateStart.getHours()).padStart(2, '0')}:${String(
        candidateStart.getMinutes()
      ).padStart(2, '0')}`,
      internal_start: candidateStart.toISOString(),
      internal_end: candidateInternalEnd.toISOString(),
      customer_visible_end: addMinutes(candidateStart, customerVisibleMinutes).toISOString(),
    });
  }

  return { slots, customerVisibleMinutes, internalMinutes };
}

module.exports = { getAvailableSlots, computeInternalDuration };
