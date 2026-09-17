// paymentService.js — بوابة الدفع (Moyasar)
// إذا لم يتم ضبط MOYASAR_SECRET_KEY، يعمل النظام في "وضع تجريبي" يحاكي نجاح الدفع فورًا
// حتى يمكن اختبار تدفق الحجز الكامل قبل ربط حساب دفع حقيقي.
'use strict';

const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || '';
const TEST_MODE = !MOYASAR_SECRET_KEY;

/**
 * ينشئ عملية دفع. في الوضع الحقيقي يتصل بـ Moyasar وينشئ Payment Session.
 * يُعيد رابط دفع (أو معرّف) يُستخدم في واجهة العميل.
 */
async function createPayment({ bookingId, amount, currency = 'SAR', callbackUrl }) {
  if (TEST_MODE) {
    return {
      testMode: true,
      paymentId: 'TEST-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      // في الوضع التجريبي نُعيد رابطًا وهميًا يمكن للواجهة معالجته كنجاح فوري
      redirectUrl: `about:blank#test-payment-success?booking=${bookingId}`,
    };
  }

  const auth = Buffer.from(`${MOYASAR_SECRET_KEY}:`).toString('base64');
  const res = await fetch('https://api.moyasar.com/v1/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100), // Moyasar تتعامل بالهللة
      currency,
      description: `حجز #${bookingId} — هُدوء`,
      callback_url: callbackUrl,
      metadata: { booking_id: bookingId },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'فشل إنشاء عملية الدفع');
  return { testMode: false, paymentId: data.id, redirectUrl: data.url };
}

/**
 * يتحقق من Webhook قادم من Moyasar عند اكتمال الدفع.
 * ملاحظة أمنية: في الإنتاج يجب التحقق من التوقيع (Signature) المرسل من Moyasar
 * وليس فقط الاعتماد على محتوى الطلب — هذا حقل يُضاف بمجرد ربط الحساب الحقيقي.
 */
function verifyWebhookPayload(payload) {
  if (TEST_MODE) return { valid: true, status: 'paid', paymentId: payload.paymentId };
  const status = payload?.data?.status;
  return {
    valid: status === 'paid',
    status,
    paymentId: payload?.data?.id,
    bookingId: payload?.data?.metadata?.booking_id,
  };
}

module.exports = { createPayment, verifyWebhookPayload, TEST_MODE };
