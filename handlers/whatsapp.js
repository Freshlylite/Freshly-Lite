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
    const text = msg.text?.body;
    if (from && text) {
      const reply = await generateReply(text, "whatsapp");
      if (reply) await sendWhatsAppMessage(from, reply);
    }
  }
}

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
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
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
        }
      }
    );
  } catch (err) {
    console.error("خطأ بإرسال رسالة واتساب:", err.response?.data || err.message);
  }
}

module.exports = { verifyWebhook, handleEvent };