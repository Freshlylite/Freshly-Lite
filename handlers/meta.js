const axios = require("axios");
const { generateReply } = require("../services/aiReply");

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

async function handleEvent(req, res) {
  const body = req.body;
  res.status(200).send("EVENT_RECEIVED");

  if (body.object !== "page" && body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message && !event.message.is_echo) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        const platform = body.object === "instagram" ? "instagram" : "facebook";

        if (senderId && text) {
          const reply = await generateReply(text, platform);
          if (reply) await sendMessage(senderId, reply);
        }
      }
    }

    for (const change of entry.changes || []) {
      if (change.field === "comments" || change.field === "feed") {
        const commentText = change.value?.text || change.value?.message;
        const commentId = change.value?.comment_id || change.value?.id;
        const platform = body.object === "instagram" ? "instagram_comment" : "facebook_comment";

        if (commentText && commentId) {
          const reply = await generateReply(commentText, platform);
          if (reply) await replyToComment(commentId, reply);
        }
      }
    }
  }
}

async function sendMessage(recipientId, text) {
  const url = "https://graph.facebook.com/v20.0/me/messages";
  try {
    await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: { text }
      },
      {
        params: { access_token: process.env.META_ACCESS_TOKEN }
      }
    );
  } catch (err) {
    console.error("خطأ بإرسال رسالة Meta:", err.response?.data || err.message);
  }
}

async function replyToComment(commentId, text) {
  const url = `https://graph.facebook.com/v20.0/${commentId}/comments`;
  try {
    await axios.post(
      url,
      { message: text },
      { params: { access_token: process.env.META_ACCESS_TOKEN } }
    );
  } catch (err) {
    console.error("خطأ بالرد على تعليق:", err.response?.data || err.message);
  }
}

module.exports = { verifyWebhook, handleEvent };