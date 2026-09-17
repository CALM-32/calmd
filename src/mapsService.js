// mapsService.js — حساب وقت التنقل الفعلي بين موقعين
// يستخدم Google Distance Matrix API إذا توفر مفتاح API، وإلا يعود لتقدير تقريبي (خط مستقيم + سرعة متوسطة)
// حتى يعمل النظام أثناء التطوير بدون اتصال إنترنت أو قبل الحصول على مفتاح API فعلي.
'use strict';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

/** المسافة بالخط المستقيم (كم) باستخدام معادلة Haversine */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** تقدير احتياطي بدون إنترنت: خط مستقيم × معامل التعرج × سرعة متوسطة داخل المدينة */
function fallbackEstimate(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 0;
  const straightKm = haversineKm(lat1, lng1, lat2, lng2);
  const roadKm = straightKm * 1.35; // معامل تعرج تقريبي للشوارع
  const avgSpeedKmh = 35; // سرعة متوسطة داخل المدينة مع الإشارات
  return Math.ceil((roadKm / avgSpeedKmh) * 60);
}

/**
 * يُرجع تقدير وقت التنقل بالدقائق بين نقطتين.
 * إذا توفر مفتاح Google Maps API، يستخدم Distance Matrix الحقيقي (يشمل الازدحام).
 * وإلا، يستخدم التقدير الاحتياطي أعلاه حتى لا يتوقف النظام.
 */
async function estimateTravelMinutes(lat1, lng1, lat2, lng2) {
  if (!GOOGLE_MAPS_API_KEY) {
    return fallbackEstimate(lat1, lng1, lat2, lng2);
  }
  try {
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${lat1},${lng1}&destinations=${lat2},${lng2}` +
      `&departure_time=now&traffic_model=best_guess&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const element = data?.rows?.[0]?.elements?.[0];
    if (element?.status === 'OK') {
      const seconds = element.duration_in_traffic?.value ?? element.duration.value;
      return Math.ceil(seconds / 60);
    }
    return fallbackEstimate(lat1, lng1, lat2, lng2);
  } catch (err) {
    console.warn('⚠️ تعذّر الاتصال بـ Google Maps API، تم استخدام التقدير الاحتياطي:', err.message);
    return fallbackEstimate(lat1, lng1, lat2, lng2);
  }
}

module.exports = { estimateTravelMinutes, haversineKm };
