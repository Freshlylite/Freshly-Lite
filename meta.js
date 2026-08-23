const axios = require("axios");
const { generateReply } = require("../services/aiReply");

// التحقق من الـ webhook عند ربطه أول مرة بمنصة Meta
function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("✅ تم التحقق من Meta webhook");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// استقبال الأحداث (رسائل / تعليقات) من فيسبوك وانستقرام
async function handleEvent(req, res) {
  const body = req.body;

  // نرد فوراً 200 عشان Meta ما تعيد إرسال نفس الحدث
  res.status(200).send("EVENT_RECEIVED");

  if (body.object !== "page" && body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    // رسائل الماسنجر / الدايركت
    for (const event of entry.messaging || []) {
      if (event.message && !event.message.is_echo) {
        const senderId = event.sender.id;
        const text = event.message.text;
        const platform = body.object === "instagram" ? "instagram" : "facebook";
        if (text) {
          const reply = await generateReply(text, platform);
          await sendMessage(senderId, reply, platform);
        }
      }
    }

    // تعليقات على منشورات انستقرام/فيسبوك (تصل بصيغة changes)
    for (const change of entry.changes || []) {
      if (change.field === "comments" || change.field === "feed") {
        const commentText = change.value?.text || change.value?.message;
        const commentId = change.value?.comment_id || change.value?.id;
        if (commentText && commentId) {
          const reply = await generateReply(commentText, "facebook_comment");
          await replyToComment(commentId, reply);
        }
      }
    }
  }
}

async function sendMessage(recipientId, text, platform) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`;
  try {
    await axios.post(url, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (err) {
    console.error(`خطأ بإرسال رسالة ${platform}:`, err.response?.data || err.message);
  }
}

async function replyToComment(commentId, text) {
  const url = `https://graph.facebook.com/v20.0/${commentId}/comments?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`;
  try {
    await axios.post(url, { message: text });
  } catch (err) {
    console.error("خطأ بالرد على تعليق:", err.response?.data || err.message);
  }
}

module.exports = { verifyWebhook, handleEvent };
