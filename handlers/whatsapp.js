const axios = require("axios");
const { generateAgentResult } = require("../services/aiReply");
const { formatManagementDecisionForCustomer } = require("../services/managementReply");

const conversations = new Map();
const recentAlerts = new Map();
const openCases = new Map();
let caseSequence = 1;
const MAX_HISTORY_MESSAGES = 12;
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

function getHistory(key) {
  return conversations.get(key) || [];
}

function saveHistory(key, history) {
  conversations.set(key, history.slice(-MAX_HISTORY_MESSAGES));
}

function createCaseId() {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const seq = String(caseSequence++).padStart(3, "0");
  return `FL-${date}-${seq}`;
}

function createOrRefreshCase(customerNumber, alert) {
  const existing = [...openCases.values()]
    .filter(c => c.customerNumber === customerNumber && c.status === "OPEN" && c.type === alert.type)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (existing) {
    existing.summary = alert.summary;
    existing.action = alert.action;
    existing.updatedAt = Date.now();
    return existing;
  }
  const item = {
    id: createCaseId(),
    customerNumber,
    type: alert.type,
    summary: alert.summary,
    action: alert.action,
    status: "OPEN",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  openCases.set(item.id, item);
  return item;
}

function getOpenCases() {
  return [...openCases.values()].filter(c => c.status === "OPEN").sort((a, b) => b.updatedAt - a.updatedAt);
}

function resolveCaseReference(text) {
  const raw = String(text || "");
  const explicit = raw.match(/FL-\d{6}-\d{3}/i)?.[0]?.toUpperCase();
  if (explicit) return openCases.get(explicit)?.status === "OPEN" ? openCases.get(explicit) : null;

  const customerDigits = normalizePhone(raw);
  if (customerDigits.length >= 9) {
    const byPhone = getOpenCases().filter(c => c.customerNumber === customerDigits || c.customerNumber.endsWith(customerDigits) || customerDigits.endsWith(c.customerNumber));
    if (byPhone.length === 1) return byPhone[0];
  }

  const open = getOpenCases();
  return open.length === 1 ? open[0] : null;
}

function stripCaseReference(text) {
  return String(text || "").replace(/FL-\d{6}-\d{3}/ig, "").trim();
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

function shouldSendAlert(customerNumber, alert) {
  const key = `${customerNumber}:${alert.type}`;
  const previous = recentAlerts.get(key);
  const fingerprint = `${alert.summary}|${alert.action}`.toLowerCase().replace(/\s+/g, " ").trim();
  const now = Date.now();
  if (previous && previous.fingerprint === fingerprint && now - previous.sentAt < ALERT_DEDUPE_MS) return false;
  recentAlerts.set(key, { fingerprint, sentAt: now });
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
    `رقم العميل: ${caseItem.customerNumber}`,
    `الملخص: ${caseItem.summary}`,
    `المطلوب منك: ${caseItem.action}`,
    "",
    `للرد: اكتب ${caseItem.id} ثم أمر واضح مثل: «ابعث للزبون: ...»`
  ].join("\n");
}

async function executeOwnerCommand(from, text) {
  const parsed = parseManagementSendCommand(text);
  if (!parsed) return false;

  const caseItem = resolveCaseReference(text);
  if (!caseItem) {
    const open = getOpenCases();
    const hint = open.length > 1
      ? `عندي ${open.length} حالات مفتوحة. اكتب رقم الحالة مع الأمر، مثلاً: ${open[0].id} ابعث للزبون: ...`
      : "ما لقيت حالة مفتوحة مرتبطة بهذا الأمر. أرسل رقم الحالة الموجود في تنبيه الإدارة مع نص الرد.";
    await sendWhatsAppMessage(from, hint);
    return true;
  }

  const customerHistoryKey = `CUSTOMER:${caseItem.customerNumber}`;
  const customerHistory = getHistory(customerHistoryKey);
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

  saveHistory(customerHistoryKey, [
    ...customerHistory,
    { role: "assistant", content: customerMessage }
  ]);
  caseItem.status = "CLOSED";
  caseItem.updatedAt = Date.now();
  caseItem.closedBy = from;
  caseItem.managementDecision = parsed.decision;
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

    const senderRole = getSenderRole(from);
    console.log(`WhatsApp sender role: ${senderRole} (${from})`);

    if (text.toUpperCase() === "TEST_ALERT") {
      const sent = await sendManagementAlert(`🔔 اختبار تنبيه الإدارة من Freshly Lite\n\nرقم المُرسل: ${from}\nالحالة: نظام تنبيهات الإدارة يعمل.`);
      await sendWhatsAppMessage(from, sent ? "✅ تم إرسال تنبيه الاختبار للإدارة بنجاح." : "⚠️ لم ينجح إرسال تنبيه الاختبار للإدارة. سيتم فحص الإعدادات.");
      continue;
    }

    // OWNER execution is deterministic. Do not send clear commands to the customer-service AI first.
    if (senderRole === "OWNER" && await executeOwnerCommand(from, text)) continue;

    const historyKey = `${senderRole}:${from}`;
    const history = getHistory(historyKey);
    const result = await generateAgentResult(text, "whatsapp", { history, senderRole, senderNumber: from });
    if (!result) continue;

    if (result.reply) await sendWhatsAppMessage(from, result.reply);
    saveHistory(historyKey, [
      ...history,
      { role: "user", content: text },
      ...(result.reply ? [{ role: "assistant", content: result.reply }] : [])
    ]);

    if (senderRole === "CUSTOMER" && result.managementAlert && shouldSendAlert(from, result.managementAlert)) {
      const caseItem = createOrRefreshCase(from, result.managementAlert);
      const sent = await sendManagementAlert(formatManagementAlert(caseItem));
      if (!sent) console.error("Management alert was generated but could not be delivered", { customer: from, type: result.managementAlert.type, caseId: caseItem.id });
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
