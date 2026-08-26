const axios = require("axios");
const { generateAgentResult } = require("../services/aiReply");

const conversations = new Map();
const recentAlerts = new Map();
const MAX_HISTORY_MESSAGES = 12;
const ALERT_DEDUPE_MS = 30 * 60 * 1000;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function getSenderRole(from) {
  const sender = normalizePhone(from);
  const management = normalizePhone(process.env.MANAGEMENT_WHATSAPP_NUMBER);
  const staff = String(process.env.AUTHORIZED_STAFF_WHATSAPP_NUMBERS || "")
    .split(",")
    .map(normalizePhone)
    .filter(Boolean);

  if (management && sender === management) return "OWNER";
  if (staff.includes(sender)) return "AUTHORIZED_STAFF";
  return "CUSTOMER";
}

function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ تم التحقق من WhatsApp webhook");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

function getHistory(key) {
  return conversations.get(key) || [];
}

function saveHistory(key, history) {
  conversations.set(key, history.slice(-MAX_HISTORY_MESSAGES));
}

function shouldSendAlert(customerNumber, alert) {
  const key = `${customerNumber}:${alert.type}`;
  const previous = recentAlerts.get(key);
  const fingerprint = `${alert.summary}|${alert.action}`.toLowerCase().replace(/\s+/g, " ").trim();
  const now = Date.now();
  if (previous && previous.fingerprint === fingerprint && now - previous.sentAt < ALERT_DEDUPE_MS) return false;
  recentAlerts.set(key, { fingerprint, sentAt: now });
  return true;
}

function formatManagementAlert(customerNumber, alert) {
  const labels = {
    CATERING: "🍽️ طلب كاترينغ يحتاج إدارة",
    COMPLAINT: "🚨 شكوى مهمة",
    ALLERGY: "⚠️ سؤال حساسية يحتاج تأكيد",
    ANGRY: "🔥 عميل غاضب / حالة متصاعدة",
    DISCOUNT: "💰 خصم أو استثناء يحتاج موافقة",
    BUSINESS: "🤝 عرض شركة / مؤثر / تعاون",
    MANAGEMENT_DECISION: "📌 قرار إدارة مطلوب",
    UNUSUAL: "❗ حالة غير اعتيادية"
  };

  return [
    labels[alert.type] || "🔔 تنبيه إدارة",
    "",
    `رقم العميل: ${customerNumber}`,
    `الملخص: ${alert.summary}`,
    `المطلوب منك: ${alert.action}`
  ].join("\n");
}

async function handleEvent(req, res) {
  res.status(200).send("EVENT_RECEIVED");

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const messages = change?.value?.messages;
  if (!messages) return;

  for (const msg of messages) {
    const from = normalizePhone(msg.from);
    const text = msg.text?.body?.trim();
    if (!from || !text) continue;

    const senderRole = getSenderRole(from);
    console.log(`WhatsApp sender role: ${senderRole} (${from})`);

    if (text.toUpperCase() === "TEST_ALERT") {
      const sent = await sendManagementAlert(
        `🔔 اختبار تنبيه الإدارة من Freshly Lite\n\nرقم المُرسل: ${from}\nالحالة: نظام تنبيهات الإدارة يعمل.`
      );
      await sendWhatsAppMessage(from, sent ? "✅ تم إرسال تنبيه الاختبار للإدارة بنجاح." : "⚠️ لم ينجح إرسال تنبيه الاختبار للإدارة. سيتم فحص الإعدادات.");
      continue;
    }

    const historyKey = `${senderRole}:${from}`;
    const history = getHistory(historyKey);
    const result = await generateAgentResult(text, "whatsapp", {
      history,
      senderRole,
      senderNumber: from
    });
    if (!result) continue;

    if (result.reply) await sendWhatsAppMessage(from, result.reply);

    const updatedHistory = [
      ...history,
      { role: "user", content: text },
      ...(result.reply ? [{ role: "assistant", content: result.reply }] : [])
    ];
    saveHistory(historyKey, updatedHistory);

    // Management/staff messages must never generate alerts back to management.
    if (senderRole === "CUSTOMER" && result.managementAlert && shouldSendAlert(from, result.managementAlert)) {
      const alertText = formatManagementAlert(from, result.managementAlert);
      const sent = await sendManagementAlert(alertText);
      if (!sent) {
        console.error("Management alert was generated but could not be delivered", {
          customer: from,
          type: result.managementAlert.type
        });
      }
    }
  }
}

async function sendManagementAlert(text) {
  const managementNumber = normalizePhone(process.env.MANAGEMENT_WHATSAPP_NUMBER);
  if (!managementNumber) {
    console.error("MANAGEMENT_WHATSAPP_NUMBER is missing");
    return false;
  }
  return sendWhatsAppMessage(managementNumber, text);
}

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    console.error("WhatsApp sending configuration is missing");
    return false;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to, text: { body: text } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return true;
  } catch (err) {
    console.error("خطأ بإرسال رسالة واتساب:", err.response?.data || err.message);
    return false;
  }
}

module.exports = { verifyWebhook, handleEvent, sendManagementAlert };
