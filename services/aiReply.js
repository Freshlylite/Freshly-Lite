const axios = require("axios");

/**
 * يولّد رد ذكي باستخدام Claude API بناءً على رسالة الزبون
 * @param {string} incomingMessage - رسالة الزبون
 * @param {string} platform - اسم المنصة (instagram, facebook, whatsapp, tiktok, google_review)
 * @param {object} extra - أي سياق إضافي (مثل تقييم بالنجوم لغوغل)
 */
async function generateReply(incomingMessage, platform, extra = {}) {
  const businessName = process.env.BUSINESS_NAME || "شركتنا";
  const businessContext = process.env.BUSINESS_CONTEXT || "";

  let systemPrompt = `انت مساعد خدمة عملاء لـ "${businessName}". 
معلومات عن العمل: ${businessContext}
مهمتك ترد على رسائل الزبائن من منصة ${platform} بشكل ودود، مختصر، ومهني باللهجة نفسها يلي حكى فيها الزبون (عربي فصيح أو عامي حسب رسالته).
لا تخترع معلومات غير موجودة بالسياق أعلاه. إذا سؤال محتاج تفاصيل ما عندك ياها، اطلب من الزبون التواصل مباشرة مع الفريق.
خلي الرد قصير (2-4 جمل كحد أقصى) ومناسب لمنصة تواصل اجتماعي.`;

  if (platform === "google_review") {
    systemPrompt += `\nهاي رسالة تقييم من جوجل${extra.rating ? ` بتقييم ${extra.rating} نجوم` : ""}. رد بامتنان، وإذا كان التقييم سلبي اعتذر بلطف واعرض حل المشكلة.`;
  }

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: incomingMessage }]
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }
  );

  const textBlock = response.data.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "شكراً لتواصلك معنا!";
}

module.exports = { generateReply };
