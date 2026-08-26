const axios = require("axios");
const { generateAgentResult } = require("../services/aiReply");
const { formatManagementDecisionForCustomer } = require("../services/managementReply");
const storage = require("../services/storage");

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
    `للرد: اكتب ${caseItem.id} ثم أمر واضح مثل: «ابعث للزبون: ...»`
  ].filter(Boolean).join("\n");
}

async function executeOwnerCommand(from, text) {
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
