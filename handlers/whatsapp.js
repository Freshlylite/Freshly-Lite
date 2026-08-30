const axios = require("axios");
const crypto = require("crypto");
const { generateAgentResult } = require("../services/aiReply");
const { formatManagementDecisionForCustomer } = require("../services/managementReply");
const storage = require("../services/storage");

const ALERT_DEDUPE_MS = 30 * 60 * 1000;
const DISCOUNT_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fallbackCustomerReply(text) {
  const value = String(text || "");
  if (/[ąćęłńóśźż]/i.test(value)) return "Przepraszam, mam chwilowy problem techniczny. Twoja wiadomość dotarła — spróbuję ponownie za chwilę.";
  if (/[а-яё]/i.test(value)) return "Извините, возникла временная техническая проблема. Ваше сообщение получено — попробую ответить снова через минуту.";
  if (/[A-Za-z]/.test(value) && !/[\u0600-\u06FF]/.test(value)) return "Sorry, I’m having a temporary technical issue. Your message was received — I’ll try again shortly.";
  return "عذرًا، صار عندي خلل تقني مؤقت. رسالتك وصلت وسأحاول الرد من جديد بعد قليل.";
}

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

function detectCustomerTopic(text) {
  const raw = String(text || "").toLowerCase();
  if (/(كاترينغ|كيترينغ|catering|حفلة|مناسبة|بوفيه|buffet|ضيوف|شركة|مكتب|event)/i.test(raw)) return "CATERING";
  if (/(خصم|discount|kod rabat|rabat|كود خصم)/i.test(raw)) return "DISCOUNT";
  if (/(حساس|حساسية|allerg|alerg|سمسم|sesame|sezam|gluten|غلوتين|جلوتين)/i.test(raw)) return "ALLERGY";
  if (/(شكوى|complaint|problem|مشكلة|زعلان|غاضب)/i.test(raw)) return "COMPLAINT";
  return "GENERAL";
}

function filterHistoryForCurrentTopic(history, newestMessage) {
  const topic = detectCustomerTopic(newestMessage);
  const items = Array.isArray(history) ? history : [];

  if (topic === "CATERING") {
    return items.filter(item => !/(خصم|discount|rabat|كود\s*(?:خصم|تحقق)|رمز\s*(?:خصم|تحقق))/i.test(String(item.content || ""))).slice(-12);
  }
  if (topic === "DISCOUNT") {
    return items.filter(item => !/(حساسية|allerg|alerg|سمسم|sesame|sezam)/i.test(String(item.content || ""))).slice(-12);
  }
  if (topic === "ALLERGY") {
    return items.filter(item => !/(خصم|discount|rabat|كود\s*(?:خصم|تحقق))/i.test(String(item.content || ""))).slice(-12);
  }
  return items.slice(-12);
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

function cutInternalTail(payload) {
  const text = String(payload || "").trim();
  if (!text) return "";
  const internalTail = /(?:\n|[.;،])\s*(?:داخلي(?:اً|ا)?|ملاحظة(?:\s+داخلية)?|للتفاوض|حد\s+التفاوض|السعر\s+الداخلي|لا\s+ترسل|ولا\s+ترسل|بعدها\s+تفاوض|ثم\s+تفاوض)\b/i;
  const match = internalTail.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

function parseManagementSendCommand(text) {
  const raw = stripCaseReference(String(text || "").trim());
  const sendVerb = "(?:ابعث|ارسل|أرسل|بلغ|بلّغ|خبر|اخبر|جاوب|رد|بعت|قل\\s*له)";
  const explicitCustomer = new RegExp(`${sendVerb}\\s*(?:للزبون|للعميل|له|إله|الو)\\s*[:،,-]?\\s*`, "i");
  const explicitMatch = explicitCustomer.exec(raw);
  const hasSendIntent = new RegExp(sendVerb, "i").test(raw);
  if (!hasSendIntent) return null;

  const exact = /(كما هي|مثل ما هي|نفس الكلام|حرفي|بدون تعديل|ولا تعدل|لا تعدل)/i.test(raw);
  let decision = "";

  if (explicitMatch) {
    decision = cutInternalTail(raw.slice(explicitMatch.index + explicitMatch[0].length));
  } else {
    const startsWithSend = new RegExp(`^\\s*(?:بس\\s*)?${sendVerb}\\s*[:،,-]?\\s*`, "i").exec(raw);
    const looksMultiInstruction = /\n/.test(raw) || /(للتفاوض|حد\s+التفاوض|داخلي|لا\s+ترسل|ولا\s+ترسل|السعر\s+الداخلي)/i.test(raw);
    if (!startsWithSend || looksMultiInstruction) return { ambiguous: true, decision: null, exact: false };
    decision = cutInternalTail(raw.slice(startsWithSend[0].length));
  }

  if (exact) {
    decision = decision.replace(/(?:كما هي|مثل ما هي|نفس الكلام|حرفي(?:اً|ا)?|بدون تعديل|ولا تعدل(?:\s*شي)?|لا تعدل(?:\s*شي)?)/ig, "").trim();
  }
  return decision ? { decision, exact, ambiguous: false } : { ambiguous: true, decision: null, exact: false };
}

function looksLikeExplicitCaseCloseCommand(text) {
  return /(اغلق|أغلق|سكر|سكّر|انهي|أنهي|اقفل|أقفل)\s*(?:الحالة|الكيس|case)|(?:الحالة|الكيس|case)\s*(?:مغلقة|منتهية|انتهت)/i.test(String(text || ""));
}

function looksLikeCustomerOrderConfirmation(text) {
  const raw = String(text || "").trim();
  return /(أؤكد\s*(?:الطلب|الحجز)|اؤكد\s*(?:الطلب|الحجز)|أكدوا\s*(?:الطلب|الحجز)|ثبتوا\s*(?:الطلب|الحجز)|ثبّتوا\s*(?:الطلب|الحجز)|موافق\s+على\s+(?:الطلب|العرض)|احجزوا|إحجزوا|potwierdzam\s+zam[oó]wienie|potwierdzam\s+rezerwacj|confirm\s+(?:the\s+)?order|i\s+confirm\s+(?:the\s+)?order|подтверждаю\s+заказ)/i.test(raw);
}

async function closeCaseFromCustomerConfirmation(customerNumber, text) {
  if (!looksLikeCustomerOrderConfirmation(text)) return null;
  const open = await storage.getOpenCasesByPhone(customerNumber);
  const eligible = open.find(c => ["CATERING", "DISCOUNT", "MANAGEMENT_DECISION", "BUSINESS"].includes(c.type));
  if (!eligible) return null;

  await storage.closeCase(eligible.id, {
    closedBy: customerNumber,
    managementDecision: "Customer explicitly confirmed/registered the order"
  });
  await sendManagementAlert(`✅ تم إغلاق الحالة ${eligible.id}\nرقم العميل: ${customerNumber}\nالسبب: العميل أكد/ثبت الطلب بشكل صريح.`);
  return eligible;
}

function parseArabicNumberWord(value) {
  const words = {
    واحد: 1, واحدة: 1, اثنين: 2, اثنان: 2, اتنين: 2, اثنتين: 2,
    ثلاثة: 3, ثلاث: 3, اربعة: 4, أربعة: 4, اربع: 4, أربع: 4,
    خمسة: 5, خمس: 5, ستة: 6, ست: 6, سبعة: 7, سبع: 7,
    ثمانية: 8, ثمان: 8, تسعة: 9, تسع: 9, عشرة: 10, عشر: 10
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
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
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
    for (let i = 0; i < length; i++) code += DISCOUNT_CODE_CHARS[crypto.randomInt(0, DISCOUNT_CODE_CHARS.length)];
    if (!(await storage.discountCodeExists(code))) return code;
  }
  throw new Error("Could not generate unique discount code");
}

function formatDiscountCustomerMessage({ percent, validFrom, validUntil, code }) {
  return `تمت الموافقة على خصم ${percent}% لطلبك.\nرمز التحقق: ${code}\nصالح من ${validFrom} حتى ${validUntil}.\nأبرز الرمز عند الكاشير للاستفادة من الخصم.`;
}

function looksLikeDiscountApproval(text) {
  const raw = String(text || "");
  return /(موافق|موافقة|اعطيه|أعطيه|نعطيه|خصم|وافق|اعتمد|اعتمده)/i.test(raw) && extractDiscountPercent(raw) !== null;
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
    await sendWhatsAppMessage(from, `ℹ️ ${caseItem.id}: يوجد رمز خصم مسجل مسبقاً لهذه الحالة: ${existing.code}. الحالة تبقى مفتوحة حتى تأمر بإغلاقها أو يؤكد العميل الطلب.`);
    return true;
  }

  const validFrom = warsawDateParts();
  const validUntil = addDaysToDateString(validFrom, durationDays - 1);
  const code = await generateUniqueDiscountCode(5);
  await storage.createDiscountCode({ code, caseId: caseItem.id, customerPhone: caseItem.customerNumber, customerId: caseItem.customerId, discountPercent: percent, validFrom, validUntil, createdBy: from });

  const customerMessage = formatDiscountCustomerMessage({ percent, validFrom, validUntil, code });
  const sent = await sendWhatsAppMessage(caseItem.customerNumber, customerMessage);
  if (!sent) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: تم إنشاء وحفظ رمز الخصم ${code}، لكن فشل إرسال الرسالة للعميل. الحالة بقيت مفتوحة.`);
    return true;
  }

  await storage.addMessage({ phone: caseItem.customerNumber, senderRole: "CUSTOMER", role: "assistant", content: customerMessage });
  await sendWhatsAppMessage(from, `✅ ${caseItem.id}: تم إنشاء وإرسال رمز الخصم للعميل.\nالخصم: ${percent}%\nالصلاحية: ${validFrom} إلى ${validUntil}\nرمز التحقق: ${code}\nالحالة ما زالت مفتوحة حتى تأمر بإغلاقها أو يؤكد العميل الطلب.`);
  return true;
}

function formatManagementAlert(caseItem) {
  const labels = {
    CATERING: "🍽️ طلب كاترينغ يحتاج إدارة", COMPLAINT: "🚨 شكوى مهمة", ALLERGY: "⚠️ سؤال حساسية يحتاج تأكيد",
    ANGRY: "🔥 عميل غاضب / حالة متصاعدة", DISCOUNT: "💰 خصم أو استثناء يحتاج موافقة", BUSINESS: "🤝 عرض شركة / مؤثر / تعاون",
    MANAGEMENT_DECISION: "📌 قرار إدارة مطلوب", UNUSUAL: "❗ حالة غير اعتيادية"
  };
  return [labels[caseItem.type] || "🔔 تنبيه إدارة", `الحالة: ${caseItem.id}`, caseItem.customerCode ? `رقم العميل الداخلي: ${caseItem.customerCode}` : null,
    `رقم العميل: ${caseItem.customerNumber}`, `الملخص: ${caseItem.summary}`, `المطلوب منك: ${caseItem.action}`, "",
    caseItem.type === "DISCOUNT"
      ? `للموافقة والتنفيذ مباشرة: اكتب ${caseItem.id} ثم مثلاً: «موافق على خصم 10% لمدة أسبوعين من اليوم». سيُنشأ رمز التحقق ويُرسل للعميل تلقائياً، وتبقى الحالة مفتوحة حتى الإغلاق الصريح أو تأكيد العميل للطلب.`
      : `للرد: اكتب ${caseItem.id} ثم أمر واضح مثل: «ابعث للزبون: ...». إرسال الجواب لا يغلق الحالة.`
  ].filter(Boolean).join("\n");
}

async function executeOwnerCommand(from, text) {
  if (looksLikeExplicitCaseCloseCommand(text)) {
    const caseItem = await resolveCaseReference(text);
    if (!caseItem) {
      await sendWhatsAppMessage(from, "ما قدرت أحدد الحالة المطلوب إغلاقها. اكتب رقم الـ Case ID مع أمر الإغلاق.");
      return true;
    }
    await storage.closeCase(caseItem.id, { closedBy: from, managementDecision: "Explicit management close command" });
    await sendWhatsAppMessage(from, `✅ ${caseItem.id}: تم إغلاق الحالة بأمر إداري صريح.`);
    return true;
  }

  if (await executeApprovedDiscount(from, text)) return true;
  const parsed = parseManagementSendCommand(text);
  if (!parsed) return false;
  if (parsed.ambiguous) {
    await sendWhatsAppMessage(from, "فهمت أن الرسالة تحتوي تعليمات إدارية وفيها أمر إرسال، لكن لن أحوّل الرسالة كاملة للعميل. حدّد الجزء المخصص للعميل بصيغة: «ابعث للزبون: ...». باقي السعر/التفاوض/الملاحظات ستبقى داخلية.");
    return true;
  }

  const caseItem = await resolveCaseReference(text);
  if (!caseItem) {
    const open = await storage.getOpenCases();
    const hint = open.length > 1 ? `عندي ${open.length} حالات مفتوحة. اكتب رقم الحالة مع الأمر، مثلاً: ${open[0].id} ابعث للزبون: ...` : "ما لقيت حالة مفتوحة مرتبطة بهذا الأمر. أرسل رقم الحالة الموجود في تنبيه الإدارة مع نص الرد.";
    await sendWhatsAppMessage(from, hint);
    return true;
  }

  const customerHistory = await storage.getHistory(caseItem.customerNumber, 12);
  const customerMessage = await formatManagementDecisionForCustomer({ decision: parsed.decision, customerHistory, caseType: caseItem.type, caseSummary: caseItem.summary, exact: parsed.exact });
  if (!customerMessage) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: فهمت الأمر لكن تعذر تجهيز رسالة العميل تقنياً، ولم يتم الإرسال.`);
    return true;
  }

  const sent = await sendWhatsAppMessage(caseItem.customerNumber, customerMessage);
  if (!sent) {
    await sendWhatsAppMessage(from, `⚠️ ${caseItem.id}: لم ينجح إرسال الرسالة للعميل. الحالة ما زالت مفتوحة.`);
    return true;
  }

  await storage.addMessage({ phone: caseItem.customerNumber, senderRole: "CUSTOMER", role: "assistant", content: customerMessage });
  await sendWhatsAppMessage(from, `✅ ${caseItem.id}: تم إرسال الجزء المخصص للعميل فقط إلى ${caseItem.customerNumber}. الحالة بقيت مفتوحة؛ لا تُغلق إلا بأمر إداري صريح أو عندما يؤكد العميل الطلب.`);
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
    if (!claimed) { console.log("Duplicate WhatsApp event ignored:", msg.id); continue; }

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
    const rawHistory = await storage.getHistory(from, 12);
    const history = senderRole === "CUSTOMER" ? filterHistoryForCurrentTopic(rawHistory, text) : rawHistory;

    let result = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      result = await generateAgentResult(text, "whatsapp", { history, senderRole, senderNumber: from });
      if (!result && attempt < 2) {
        console.warn(`AI reply attempt ${attempt} failed for ${from}; retrying`);
        await sleep(1500);
      }
    }

    await storage.addMessage({ phone: from, senderRole, role: "user", content: text, externalMessageId: msg.id || null });

    if (!result) {
      console.error("AI failed twice; sending fallback instead of leaving customer unanswered", { from, messageId: msg.id });
      if (senderRole === "CUSTOMER") {
        const fallback = fallbackCustomerReply(text);
        const fallbackSent = await sendWhatsAppMessage(from, fallback);
        if (fallbackSent) {
          await storage.addMessage({ phone: from, senderRole, role: "assistant", content: fallback });
        }
        await sendManagementAlert(`⚠️ خلل تقني في رد الوكيل\nرقم العميل: ${from}\nالرسالة: ${text}\nفشل توليد الرد بعد محاولتين.${fallbackSent ? " تم إرسال رد مؤقت للعميل." : " كما فشل إرسال الرد المؤقت."}`);
      } else {
        await sendWhatsAppMessage(from, "⚠️ حصل خلل تقني مؤقت ولم أستطع معالجة رسالتك بعد محاولتين.");
      }
      continue;
    }

    if (senderRole === "CUSTOMER") await closeCaseFromCustomerConfirmation(from, text);

    if (result.reply) {
      const sent = await sendWhatsAppMessage(from, result.reply);
      if (sent) {
        await storage.addMessage({ phone: from, senderRole, role: "assistant", content: result.reply });
      } else if (senderRole === "CUSTOMER") {
        await sendManagementAlert(`⚠️ فشل إرسال رد واتساب للعميل\nرقم العميل: ${from}\nالرسالة الواردة: ${text}\nالرد تم توليده لكن WhatsApp API لم ينجح بإرساله.`);
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
  if (!managementNumber) { console.error("MANAGEMENT_WHATSAPP_NUMBER is missing"); return false; }
  return sendWhatsAppMessage(managementNumber, text);
}

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) { console.error("WhatsApp sending configuration is missing"); return false; }
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
