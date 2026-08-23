async function generateReply(incomingMessage, platform, extra = {}) {
  const message = String(incomingMessage || "").trim();

  if (!message) {
    return "مرحباً 👋 كيف يمكننا مساعدتك؟";
  }

  const lower = message.toLowerCase();

  if (
    lower.includes("hello") ||
    lower.includes("hi") ||
    lower.includes("مرحبا") ||
    lower.includes("مرحباً") ||
    lower.includes("السلام")
  ) {
    return "أهلاً وسهلاً بك في Freshly Lite 👋 كيف يمكننا مساعدتك اليوم؟";
  }

  if (
    lower.includes("menu") ||
    lower.includes("منيو") ||
    lower.includes("قائمة") ||
    lower.includes("أسعار") ||
    lower.includes("price")
  ) {
    return "يسعدنا مساعدتك 😊 أخبرنا ما الذي ترغب بطلبه أو الاستفسار عنه، وسنساعدك مباشرة.";
  }

  return "شكراً لتواصلك مع Freshly Lite 🌿 تم استلام رسالتك وسنساعدك بكل سرور.";
}

module.exports = { generateReply };
