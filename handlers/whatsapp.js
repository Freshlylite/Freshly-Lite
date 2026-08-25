const axios = require("axios");
const { generateReply } = require("../services/aiReply");

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

    // Temporary management-alert test. This is intercepted before AI processing.
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

    const reply = await generateReply(text, "whatsapp");
    if (reply) await sendWhatsAppMessage(from, reply);
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
