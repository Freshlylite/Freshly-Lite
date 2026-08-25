const axios = require("axios");
const { generateAgentResult } = require("../services/aiReply");

// Short in-memory WhatsApp context. This survives normal messages on the same
// running instance, but is intentionally not treated as permanent customer memory.
const conversations = new Map();
const recentAlerts = new Map();
const MAX_HISTORY_MESSAGES = 12;
const ALERT_DEDUPE_MS = 30 * 60 * 1000;

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

function getHistory(customerNumber) {
  return conversations.get(customerNumber) || [];
}

function saveHistory(customerNumber, history) {
  conversations.set(customerNumber, history.slice(-MAX_HISTORY_MESSAGES));
}

function shouldSendAlert(customerNumber, alert) {
  const key = `${customerNumber}:${alert.type}`;
  const previous = recentAlerts.get(key);
  const fingerprint = `${alert.summary}|${alert.action}`.toLowerCase().replace(/\s+/g, " ").trim();
  const now = Date.now();

  if (previous && previous.fingerprint === fingerprint && now - previous.sentAt < ALERT_DEDUPE_MS) {
    return false;
  }

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
    const from = msg.from;
    const text = msg.text?.body?.trim();
    if (!from || !text) continue;

    // Keep the working test route for diagnostics.
    if (text.toUpperCase() === "TEST_ALERT") {
      const sent = await sendManagementAlert(
        `🔔 اختبار تنبيه الإدارة من Freshly Lite\n\nرقم المُرسل: ${from}\nالحالة: نظام تنبيهات الإدارة يعمل.`
      );

      if (sent) {
        await sendWhatsAppMessage(from, "✅ تم إرسال تنبيه الاختبار للإدارة بنجاح.");
      } else {
        await sendWhatsAppMessage(from, "⚠️ لم ينجح إرسال تنبيه الاختبار للإدارة. سيتم فحص الإعدادات.");
      }
      continue;
    }

    const history = getHistory(from);
    const result = await generateAgentResult(text, "whatsapp", { history });
    if (!result) continue;

    if (result.reply) {
      await sendWhatsAppMessage(from, result.reply);
    }

    const updatedHistory = [
      ...history,
      { role: "user", content: text },
      ...(result.reply ? [{ role: "assistant", content: result.reply }] : [])
    ];
    saveHistory(from, updatedHistory);

    if (result.managementAlert && shouldSendAlert(from, result.managementAlert)) {
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
  const managementNumber = String(process.env.MANAGEMENT_WHATSAPP_NUMBER || "").replace(/\D/g, "");
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
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    return true;
  } catch (err) {
    console.error("خطأ بإرسال رسالة واتساب:", err.response?.data || err.message);
    return false;
  }
}

module.exports = { verifyWebhook, handleEvent, sendManagementAlert };
