require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;

// صفحة فحص بسيطة
app.get("/", (req, res) => {
  res.send("✅ Freshly Lite Instagram Bot is running");
});

// التحقق من Webhook
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// استقبال رسائل Instagram
app.post("/webhook/meta", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "instagram") {
      return;
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const text = event.message?.text;

        if (!senderId || !text || event.message?.is_echo) {
          continue;
        }

        console.log("📩 Instagram message:", text);

        const reply = buildReply(text);

        await sendInstagramMessage(senderId, reply);
      }
    }
  } catch (error) {
    console.error(
      "❌ Webhook processing error:",
      error.response?.data || error.message
    );
  }
});

function buildReply(message) {
  const text = String(message || "").toLowerCase();

  if (
    text.includes("مرحبا") ||
    text.includes("مرحباً") ||
    text.includes("السلام") ||
    text.includes("hello") ||
    text.includes("hi")
  ) {
    return "أهلاً وسهلاً بك في Freshly Lite 👋 كيف يمكننا مساعدتك اليوم؟";
  }

  if (
    text.includes("menu") ||
    text.includes("منيو") ||
    text.includes("قائمة") ||
    text.includes("سعر") ||
    text.includes("price")
  ) {
    return "يسعدنا مساعدتك 😊 أخبرنا ما الذي ترغب بطلبه أو الاستفسار عنه.";
  }

  return "شكراً لتواصلك مع Freshly Lite 🌿 كيف يمكننا مساعدتك؟";
}

async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    throw new Error("INSTAGRAM_ACCESS_TOKEN is missing");
  }

  const url = "https://graph.instagram.com/v26.0/me/messages";

  const response = await axios.post(
    url,
    {
      recipient: {
        id: recipientId
      },
      message: {
        text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("✅ Instagram reply sent:", response.data);
}

app.listen(PORT, () => {
  console.log(`🚀 Freshly Lite running on port ${PORT}`);
});
