const axios = require("axios");
const crypto = require("crypto");
const { generateAgentResult } = require("../services/aiReply");
const { formatManagementDecisionForCustomer } = require("../services/managementReply");
const storage = require("../services/storage");

const ALERT_DEDUPE_MS = 30 * 60 * 1000;
const DISCOUNT_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

async function resolveCaseReference(text) {
  const raw = String(text || "");
  const explicit = raw.match(/FL-\d{6}-\d{6}/i)?.[0]?.toUpperCase();
  if (explicit) return storage.getOpenCaseById(explicit);

  const customerDigits = normalizePhone(raw);
  if (customerDigits.length >= 9) {
    const byPhone = await storage.getOpenCasesByPhone(customerDigits);
    if (byPhone.length === 1) return byPhone[0];
  }

  const open = await storage.getOpenCases();
  return open.length === 1 ? open[0] : null;
}

function stripCaseReference(text) {
  return String(text || "").replace(/FL-\d{6}-\d{6}/ig, "").trim();
}

function parseManagementSendCommand(text) {
  const raw = String(text || "").trim();
  const sendIntent = /(ابعث|ارسل|أرسل|بلغ|بلّغ|خبر|اخبر|جاوب|رد|قل\s*له|بعت)/i.test(raw);
  if (!sendIntent) return null;
  const exact = /(كما هي|مثل ما هي|نفس الكلام|حرفي|بدون تعديل|ولا تعدل|لا تعدل)/i.test(raw);
  let decision = stripCaseReference(raw)
    .replace(/^(?:بس\s*)?(?:ابعث|ارسل|أرسل|بلغ|بلّغ|خبر|اخبر|جاوب|رد|بعت)\s*(?:للزبون|للعميل|له|إله|الو)?\s*[:،,-]?\s*/i, "")
    .trim();
  if (exact) {
    decision = decision
      .replace(/(?:كما هي|مثل ما هي|نفس الكلام|حرفي(?:اً|ا)?|بدون تعديل|ولا تعدل(?:\s*شي)?|لا تعدل(?:\s*شي)?)/ig, "")
      .trim();
  }
  return decision ? { decision, exact } : null;
}

function parseArabicNumberWord(value) {
  const words = {
    واحد: 1, واحدة: 1,
    اثنين: 2, اثنان: 2, اتنين: 2, اثنتين: 2,
    ثلاثة: 3, ثلاث: 3,
    اربعة: 4, أربعة: 4, اربع: 4, أربع: 4,
    خمسة: 5, خمس: 5,
    ستة: 6, ست: 6,
    سبعة: 7, سبع: 7,
    ثمانية: 8, ثمان: 8,
    تسعة: 9, تسع: 9,
    عشرة: 10, عشر: 10
  };
  return words[value] || null;
}

function extractDiscountPercent(text) {
  const raw = String(text || "");
  const direct = raw.match(/(?:خصم\s*)?(\d{1,3}(?:[.,]\d+)?)\s*%/i)
    || raw.match(/خصم\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:بالمية|بالمئة|في\s*المية|في\s*المئة)/i);
  if (!direct) return null;
  const value = Number(direct[1].replace(",", "."));
  return value > 0 && value <= 100 ? value : null;
}

function extractDurationDays(text) {
  const raw = String(text || "").toLowerCase();
  if (/(اسبوعين|أسبوعين|اسبوعان|أسبوعان)/i.test(raw)) return 14;
  if (/(اسبوع|أسبوع)\s*(واحد|واحدة)?/i.test(raw)) return 7;
  if (/(شهرين|شهران)/i.test(raw)) return 60;
  if (/شهر\s*(واحد|واحدة)?/i.test(raw)) return 30;

  const numeric = raw.match(/(\d{1,3})\s*(يوم|ايام|أيام|اسبوع|أسبوع|اسابيع|أسابيع|شهر|اشهر|أشهر)/i);
  if (numeric) {
    const n = Number(numeric[1]);
    const unit = numeric[2];
    if (/يوم|ايام|أيام/i.test(unit)) return n;
    if (/اسبوع|أسبوع|اسابيع|أسابيع/i.test(unit)) return n * 7;
    if (/شهر|اشهر|أشهر/i.test(unit)) return n * 30;
  }

  const word = raw.match(/(واحد|واحدة|اثنين|اثنان|اتنين|اثنتين|ثلاثة|ثلاث|اربعة|أربعة|اربع|أربع|خمسة|خمس|ستة|ست|سبعة|سبع|ثمانية|ثمان|تسعة|تسع|عشرة|عشر)\s*(ايام|أيام|اسابيع|أسابيع|اشهر|أشهر)/i);
  if (word) {
    const n = parseArabicNumberWord(word[1]);
    if (!n) return null;
    if (/ايام|أيام/i.test(word[2])) return n;
    if (/اسابيع|أسابيع/i.test(word[2])) return n * 7;
    if (/اشهر|أشهر/i.test(word[2])) return n * 30;
  }
  return null;
}

function warsawDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDaysToDateString(dateString, days) {
  const [y, m, d] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function generateUniqueDiscountCode(length = 5) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let code = "";
    for (let i = 0; i < length; i++) {
      code += DISCOUNT_CODE_CHARS[crypto.randomInt(0, DISCOUNT_CODE_CHARS.length)];
    }
    if (!(await storage.discountCodeExists(code))) return code;
  }
  throw new Error("Could not generate unique discount code");
}

function formatDiscountCustomerMessage({ percent, validFrom, validUntil, code }) {
  return `تمت الموافقة على خصم ${percent}% لطلبك.\nرمز التحقق: ${code}\nصالح من ${validFrom} حتى ${validUntil}.\nأبرز الرمز عند الكاشير للاستفادة من الخصم.`;
}

function looksLikeDiscountApproval(text) {
  const raw = String(text || "");
  return /(موافق|موافقة|اعطيه|أعطيه|نعطيه|خصم|وافق|اعتمد|اعتمده)/i.test(raw)
    && extractDiscountPercent(raw) !== null;
}

async function executeApprovedDiscount(from, text) {
  const caseItem = await resolveCaseReference(text);
  if (!caseItem || caseItem.type !== "DISCOUNT") return false;
  if (!looksLikeDiscountApproval(text)) return false;

  const percent = extractDiscountPercent(text);
  const durationDays = extractDurationDays(text);
  if (!percent) return false;

  if (!durationDays) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: فهمت قيمة الخصم ${percent}%، لكن مدة الصلاحية غير محددة بوضوح. اكتب المدة فقط مثل: «أسبوعين من اليوم».`);
    return true;
  }

  const existing = await storage.getDiscountCodeByCase(caseItem.id);
  if (existing) {
    await sendWhatsAppMessage(from, `ℹ️ ${caseItem.id}: يوجد رمز خصم مسجل مسبقاً لهذه الحالة: ${existing.code}`);
    return true;
  }

  const validFrom = warsawDateParts();
  const validUntil = addDaysToDateString(validFrom, durationDays - 1);
  const code = await generateUniqueDiscountCode(5);

  await storage.createDiscountCode({
    code,
    caseId: caseItem.id,
    customerPhone: caseItem.customerNumber,
    customerId: caseItem.customerId,
    discountPercent: percent,
    validFrom,
    validUntil,
    createdBy: from
  });

  const customerMessage = formatDiscountCustomerMessage({ percent, validFrom, validUntil, code });
  const sent = await sendWhatsAppMessage(caseItem.customerNumber, customerMessage);

  if (!sent) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: تم إنشاء وحفظ رمز الخصم ${code}، لكن فشل إرسال الرسالة للعميل. الحالة بقيت مفتوحة.`);
    return true;
  }

  await storage.addMessage({
    phone: caseItem.customerNumber,
    senderRole: "CUSTOMER",
    role: "assistant",
    content: customerMessage
  });

  await storage.closeCase(caseItem.id, {
    closedBy: from,
    managementDecision: `Approved ${percent}% discount for ${durationDays} days; verification code ${code}`
  });

  await sendWhatsAppMessage(
    from,
    `✅ ${caseItem.id}: تمت الموافقة والتنفيذ مباشرة.\nالخصم: ${percent}%\nالصلاحية: ${validFrom} إلى ${validUntil}\nرمز التحقق: ${code}\nتم إرسال الرمز للعميل وإغلاق الحالة.`
  );
  return true;
}

function formatManagementAlert(caseItem) {
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
    labels[caseItem.type] || "🔔 تنبيه إدارة",
    `الحالة: ${caseItem.id}`,
    caseItem.customerCode ? `رقم العميل الداخلي: ${caseItem.customerCode}` : null,
    `رقم العميل: ${caseItem.customerNumber}`,
    `الملخص: ${caseItem.summary}`,
    `المطلوب منك: ${caseItem.action}`,
    "",
    caseItem.type === "DISCOUNT"
      ? `للموافقة والتنفيذ مباشرة: اكتب ${caseItem.id} ثم مثلاً: «موافق على خصم 10% لمدة أسبوعين من اليوم». سيُنشأ رمز التحقق ويُرسل للعميل تلقائياً.`
      : `للرد: اكتب ${caseItem.id} ثم أمر واضح مثل: «ابعث للزبون: ...»`
  ].filter(Boolean).join("\n");
}

async function executeOwnerCommand(from, text) {
  if (await executeApprovedDiscount(from, text)) return true;

  const parsed = parseManagementSendCommand(text);
  if (!parsed) return false;

  const caseItem = await resolveCaseReference(text);
  if (!caseItem) {
    const open = await storage.getOpenCases();
    const hint = open.length > 1
      ? `عندي ${open.length} حالات مفتوحة. اكتب رقم الحالة مع الأمر، مثلاً: ${open[0].id} ابعث للزبون: ...`
      : "ما لقيت حالة مفتوحة مرتبطة بهذا الأمر. أرسل رقم الحالة الموجود في تنبيه الإدارة مع نص الرد.";
    await sendWhatsAppMessage(from, hint);
    return true;
  }

  const customerHistory = await storage.getHistory(caseItem.customerNumber, 12);
  const customerMessage = await formatManagementDecisionForCustomer({
    decision: parsed.decision,
    customerHistory,
    caseType: caseItem.type,
    caseSummary: caseItem.summary,
    exact: parsed.exact
  });

  if (!customerMessage) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: فهمت الأمر لكن تعذر تجهيز رسالة العميل تقنياً، ولم يتم الإرسال.`);
    return true;
  }

  const sent = await sendWhatsAppMessage(caseItem.customerNumber, customerMessage);
  if (!sent) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: لم ينجح إرسال الرسالة للعميل. الحالة ما زالت مفتوحة.`);
    return true;
  }

  await storage.addMessage({
    phone: caseItem.customerNumber,
    senderRole: "CUSTOMER",
    role: "assistant",
    content: customerMessage
  });
  await storage.closeCase(caseItem.id, {
    closedBy: from,
    managementDecision: parsed.decision
  });
  await sendWhatsAppMessage(from, `✅ ${caseItem.id}: تم إرسال الرد للعميل ${caseItem.customerNumber} وإغلاق الحالة.`);
  return true;
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

    const claimed = await storage.claimInboundEvent(msg.id || null);
    if (!claimed) {
      console.log("Duplicate WhatsApp event ignored:", msg.id);
      continue;
    }

    const senderRole = getSenderRole(from);
    console.log(`WhatsApp sender role: ${senderRole} (${from})`);

    if (text.toUpperCase() === "TEST_ALERT") {
      const sent = await sendManagementAlert(`🔔 اختبار تنبيه الإدارة من Freshly Lite\n\nرقم المُرسل: ${from}\nالحالة: نظام تنبيهات الإدارة يعمل.`);
      await sendWhatsAppMessage(from, sent ? "✅ تم إرسال تنبيه الاختبار للإدارة بنجاح." : "⚠️ لم ينجح إرسال تنبيه الاختبار للإدارة. سيتم فحص الإعدادات.");
      continue;
    }

    if (senderRole === "OWNER" && await executeOwnerCommand(from, text)) {
      await storage.addMessage({ phone: from, senderRole, role: "user", content: text, externalMessageId: msg.id || null });
      continue;
    }

    if (senderRole === "CUSTOMER") await storage.ensureCustomer(from);
    const history = await storage.getHistory(from, 12);
    const result = await generateAgentResult(text, "whatsapp", { history, senderRole, senderNumber: from });
    if (!result) continue;

    await storage.addMessage({ phone: from, senderRole, role: "user", content: text, externalMessageId: msg.id || null });

    if (result.reply) {
      const sent = await sendWhatsAppMessage(from, result.reply);
      if (sent) {
        await storage.addMessage({ phone: from, senderRole, role: "assistant", content: result.reply });
      }
    }

    if (senderRole === "CUSTOMER" && result.managementAlert) {
      const shouldAlert = await storage.shouldSendAlert(from, result.managementAlert, ALERT_DEDUPE_MS);
      if (shouldAlert) {
        const caseItem = await storage.createOrRefreshCase(from, result.managementAlert);
        const sent = await sendManagementAlert(formatManagementAlert(caseItem));
        if (!sent) console.error("Management alert was generated but could not be delivered", { customer: from, type: result.managementAlert.type, caseId: caseItem.id });
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
    await axios.post(url, { messaging_product: "whatsapp", to, text: { body: text } }, { headers: { Authorization: `Bearer ${accessToken}` } });
    return true;
  } catch (err) {
    console.error("خطأ بإرسال رسالة واتساب:", err.response?.data || err.message);
    return false;
  }
}

module.exports = { verifyWebhook, handleEvent, sendManagementAlert };
