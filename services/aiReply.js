const axios = require("axios");
const { SYSTEM_PROMPT } = require("../prompts/restaurantAssistant");
const { formatMenuForAI } = require("../data/menu");
const { formatRestaurantForAI } = require("../data/restaurant");

const MANAGEMENT_ALERT_PROTOCOL = `
## INTERNAL MANAGEMENT ALERT PROTOCOL
This protocol is machine-readable and MUST NEVER be shown to the customer.
Create a management alert ONLY for important customer cases: CATERING, COMPLAINT, ALLERGY, ANGRY, DISCOUNT, BUSINESS, MANAGEMENT_DECISION, UNUSUAL.
Do NOT alert for routine conversation or requests outside Freshly Lite services.

CASE-TYPE PRIORITY:
- Classify the customer's PRIMARY unresolved intent, not isolated words from assistant questions.
- If the active conversation is a catering/event request, keep it CATERING unless the CUSTOMER positively reports an actual allergy/safety concern that itself requires management confirmation.
- A customer answer such as "لا", "لا يوجد حساسية", "ما عندي حساسية", "no allergies", or equivalent must NEVER create an ALLERGY case.
- The assistant merely asking about allergies does not mean an allergy exists.

ALLERGY is mandatory only when ALL of these are true:
- the CUSTOMER positively indicates an allergy/sensitivity or asks about a specific allergen for safety reasons;
- the relevant item/product scope is known well enough to identify what management must check;
- verified restaurant data is insufficient to safely answer.
In that situation append the machine-readable ALLERGY block in the SAME response so the server can send the management alert.
Do not ask the customer to choose between ingredient presence and cross-contamination; management should confirm both when relevant.

CATERING:
- When a catering/event conversation has enough information for management pricing/approval, create a CATERING alert.
- Never substitute ALLERGY merely because the catering workflow contained a routine allergy question.
- Catering pricing, custom quantities, event package composition, presentation/service commitments, and final catering offer terms must not be invented by the assistant when not explicitly verified.

OFF-MENU / CUSTOM RESTAURANT REQUESTS:
- If the customer requests a Freshly Lite food/product/order variation that is not present in verified menu data, do not claim it is accepted or available.
- Collect only the minimum details needed to identify the request.
- Once the request is clear enough for management to decide, create a MANAGEMENT_DECISION alert in the SAME response.
- If you tell the customer that you will notify/contact/send the request to management, the management alert block is mandatory in that same response. Never promise escalation without generating the block.

PAYMENT / DEPOSIT:
- Never invent bank-account details, IBANs, payment links, beneficiary details, transfer references, deposit instructions, payment deadlines, or payment methods.
- Payment information may be sent only if it exists verbatim in VERIFIED RESTAURANT KNOWLEDGE or is supplied explicitly by authenticated management for that case.
- If a customer needs payment/deposit details and verified data does not contain them, create a MANAGEMENT_DECISION alert. Do not fabricate placeholders or example account numbers.

If an alert is needed append exactly:
<<<MANAGEMENT_ALERT>>>
TYPE: one of CATERING, COMPLAINT, ALLERGY, ANGRY, DISCOUNT, BUSINESS, MANAGEMENT_DECISION, UNUSUAL
SUMMARY: concise factual summary
ACTION: exactly what management needs to decide/confirm
<<<END_MANAGEMENT_ALERT>>>
Never expose this block to customers.
`;

const RESPONSE_DISCIPLINE = `
## CUSTOMER RESPONSE DISCIPLINE
- Answer only from verified Freshly Lite information supplied in context.
- Never invent or proactively offer unsupported information/services.
- Never invent catering prices, catering package quantities, catering presentation/service details, staffing, delivery/setup promises, or timing commitments that are not explicitly verified.
- Never invent payment or banking data. If verified payment data is unavailable, ask management instead of giving any account number or transfer instruction.
- If the active request is catering and management pricing/approval is required, collect only the missing essential information, then stop and escalate as CATERING rather than estimating.
- If the customer asks for an off-menu/custom restaurant item, do not say the request was sent to management unless the machine-readable management alert is produced in the same response.
- If the question is fully answered, end the reply; do not add generic follow-up offers.
- Ask a follow-up only when genuinely required to complete the current Freshly Lite request/workflow.
- Unknown out-of-scope facts are not escalated to management.
`;

const LANGUAGE_AND_CONTEXT_PROTOCOL = `
## LANGUAGE AND CONVERSATION CONTINUITY — STRICT
This section has high priority for every customer reply.

LANGUAGE LOCK:
- Determine the reply language primarily from the customer's MOST RECENT message and the established conversation language.
- If the conversation is clearly Arabic, reply fully in Arabic. If Polish, reply fully in Polish. If English, reply fully in English. If Russian, reply fully in Russian.
- NEVER mix Arabic, Polish, Russian, and English in one sentence or reply without a necessary reason.
- A menu item's official foreign-language name may be quoted once when needed for identification, but all explanation and surrounding text must remain in the customer's language.
- Do not insert random translated words, confirmations, or phrases from another supported language.
- A short foreign menu name in history does NOT mean the customer changed conversation language.
- Change conversation language only when the customer clearly starts communicating in another language, not because a product name is Polish or another language.

ACTIVE INTENT MEMORY:
- The latest unresolved customer goal has priority over the assistant's previous follow-up questions.
- Track what the customer originally asked for and why any clarification was requested.
- A clarification answer such as "الكلاسيك", "نعم", "لا", a quantity, date, or option must be interpreted as an answer to the pending clarification, NOT as a new unrelated request.
- After receiving the needed clarification, immediately continue the ORIGINAL request.
- If the customer explicitly says they want the answer to their previous question, return to that unresolved question immediately using already collected details.

CATERING CONTINUITY:
- Once the customer's primary intent is clearly catering/event food, keep CATERING as the active workflow until the request is completed or explicitly abandoned.
- Do not let generic questions about allergies, pickup, presentation, menu preferences, or event details replace the primary catering intent.
- Do not repeat already collected catering details in every reply.
- Do not fabricate a final catering proposal or price; when enough details exist, escalate to management for pricing/approval.

ALLERGY / SAFETY CONTINUITY:
- Allergy and food-safety intents have priority only when the CUSTOMER positively states an allergy/safety concern.
- A negative answer such as "لا" to an allergy question means NO allergy was reported and must clear allergy as a possible active intent for that branch.
- If the customer says they have an allergy and names the allergen, retain that allergen as active context until resolved.
- Never infer an allergy from the assistant's own previous question.
- Never pivot from an unresolved positive allergy question to sales/ordering.
- If verified information is insufficient to confirm allergy safety and the product scope is known, tell the customer briefly that restaurant confirmation is needed and generate the ALLERGY management alert in the same response.
`;

const MANAGEMENT_MODE = `
## AUTHENTICATED MANAGEMENT MODE — HIGHEST PRIORITY
The server has authenticated this sender by exact normalized WhatsApp number. This is NOT an inference from wording.
- OWNER means the restaurant owner/primary management. NEVER treat OWNER as a customer.
- AUTHORIZED_STAFF means an authenticated staff member. NEVER treat that sender as a customer.
- Messages from OWNER are administrative commands, decisions, answers to open cases, corrections, approvals/rejections, or management questions.
- Do not run the customer-service flow on an OWNER message and do not create a management alert about an OWNER/STAFF message.
- If the owner gives a clear executable instruction, interpret it as an instruction.
- Only claim an external action was completed if the application actually provides the required execution context/tool.
- Preserve the distinction between management and customers across the conversation.
`;

function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && part?.text) return part.text.trim();
    }
  }
  return null;
}

function parseAgentOutput(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/<<<MANAGEMENT_ALERT>>>\s*TYPE:\s*([^\n]+)\s*SUMMARY:\s*([\s\S]*?)\s*ACTION:\s*([\s\S]*?)\s*<<<END_MANAGEMENT_ALERT>>>/i);
  if (!match) return { reply: text, managementAlert: null };
  const reply = text.replace(match[0], "").trim();
  const allowedTypes = new Set(["CATERING", "COMPLAINT", "ALLERGY", "ANGRY", "DISCOUNT", "BUSINESS", "MANAGEMENT_DECISION", "UNUSUAL"]);
  const type = match[1].trim().toUpperCase();
  const summary = match[2].trim();
  const action = match[3].trim();
  return { reply, managementAlert: allowedTypes.has(type) && summary && action ? { type, summary, action } : null };
}

function customerMessagesFromHistory(historyItems = []) {
  return historyItems.filter(item => item?.role !== "assistant").map(item => String(item?.content || "").trim()).filter(Boolean);
}

function hasPositiveAllergySignal(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const negative = /(ما\s*عندي\s*(حساسية|حساسيات)|ما\s*في\s*(حساسية|حساسيات)|لا\s*(يوجد|توجد)?\s*(حساسية|حساسيات)|بدون\s*حساسية|no\s+allerg|no\s+food\s+allerg|nie\s+mam\s+alerg|brak\s+alerg|нет\s+аллерг)/i.test(value);
  if (negative) return false;
  return /(عندي\s*(حساسية|حساسيه)|أنا\s*(حساس|حساسة)|حساسية\s+من|حساس\s+على|allerg(?:y|ic)|mam\s+alerg|uczulen|аллерг|سمسم|sesame|sezam|кунжут|gluten|جلوتين|غلوتين|soy|صويا|dairy|ألبان|orzech|مكسرات)/i.test(value);
}

function isCateringSignal(text) {
  return /(كاترينغ|كاترنج|catering|حفلة|فعالية|event|بوفيه|buffet|ضيوف|guests|przyjęcie|imprez|банкет|мероприят)/i.test(String(text || ""));
}

function needsManagementConfirmation(text) {
  return /(تأكيد|الإدارة|المطبخ|غير متوفر|غير متوفرة|سأرسل|سارسل|سأطلب|ساطلب|سأبلغ|سابلغ|أبلغ\s+الإدارة|ابلغ\s+الادارة|confirm|management|kitchen|need to check|muszę.*sprawdzić|potwierdzić|уточн|подтверд)/i.test(String(text || ""));
}

function isRestaurantRequestSignal(text) {
  return /(طلب|وجبة|طبق|أكل|اكل|داخل\s+المطعم|استلام|رز|بازيلا|فلافل|حمص|ساندويش|menu|order|meal|dish|restaurant|zam[oó]w|danie|restaurac|заказ|блюд)/i.test(String(text || ""));
}

function promisedManagementEscalation(reply) {
  return /(سأرسل.*الإدارة|سارسل.*الادارة|سأبلغ.*الإدارة|سابلغ.*الادارة|سأعود.*رد|سارجع.*رد|أرسل.*إلى\s+الإدارة|send.*management|contact.*management|przekaż.*kierown|уточн.*админ)/i.test(String(reply || ""));
}

function containsPaymentData(text) {
  const value = String(text || "");
  const ibanLike = /\b[A-Z]{2}\d{2}(?:\s*\d){10,30}\b/i.test(value);
  const bankLabel = /(numer\s+konta|konto\s+do\s+wpłaty|rachunek|IBAN|bank\s+account|account\s+number|nr\s+konta|رقم\s+الحساب|حساب\s+بنكي|beneficiary|nazwa\s+odbiorcy|tytuł\s+przelewu|transfer\s+title|данные\s+для\s+оплаты)/i.test(value);
  return ibanLike || bankLabel;
}

function verifiedPaymentDataExists(verifiedRestaurant) {
  return /(numer\s+konta|IBAN|bank\s+account|account\s+number|رقم\s+الحساب|حساب\s+بنكي|nazwa\s+odbiorcy|tytuł\s+przelewu)/i.test(String(verifiedRestaurant || ""));
}

function safePaymentReplyForCustomer(message) {
  const value = String(message || "");
  if (/[ąćęłńóśźż]/i.test(value) || /tak|proszę|płatno|zaliczk/i.test(value)) {
    return "Dziękuję. Dane do płatności wymagają potwierdzenia przez restaurację. Nie podam numeru konta ani danych do przelewu bez zweryfikowanych danych. Przekazuję prośbę do administracji.";
  }
  if (/[а-яё]/i.test(value)) {
    return "Спасибо. Платёжные реквизиты должны быть подтверждены рестораном. Я не буду указывать номер счёта или реквизиты без проверенных данных. Передаю запрос администрации.";
  }
  if (/[A-Za-z]/.test(value) && !/[\u0600-\u06FF]/.test(value)) {
    return "Thank you. Payment details must be confirmed by the restaurant. I will not provide a bank account or transfer details unless they are verified. I’m sending the request to management.";
  }
  return "شكرًا. بيانات الدفع لازم تكون مؤكدة من المطعم. ما رح أعطي رقم حساب أو بيانات تحويل بدون معلومات موثقة. سأرسل الطلب للإدارة للتأكيد.";
}

function buildAllergyFallback(historyItems, newestMessage, reply) {
  const customerHistory = customerMessagesFromHistory(historyItems);
  const customerText = [...customerHistory, String(newestMessage || "")].join("\n");
  if (!hasPositiveAllergySignal(customerText) || !needsManagementConfirmation(reply)) return null;
  const sesame = /(سمسم|sesame|sezam|кунжут)/i.test(customerText);
  const falafel = /(فلافل|falafel)/i.test(customerText);
  const allergen = sesame ? "السمسم ومشتقاته" : "مسبب الحساسية المذكور من العميل";
  const item = falafel ? "الفلافل المذكور في المحادثة" : "المنتج المذكور في المحادثة";
  return {
    type: "ALLERGY",
    summary: `العميل لديه سؤال حساسية بخصوص ${allergen} في ${item}، والمعلومات الموثقة الحالية لا تكفي لتأكيد السلامة.`,
    action: `يرجى تأكيد هل ${item} يحتوي على ${allergen} ضمن المكونات، وهل يوجد خطر تلوث/تماس متقاطع معروف مع ${allergen}.`
  };
}

function buildManagementDecisionFallback(historyItems, newestMessage, reply) {
  const customerHistory = customerMessagesFromHistory(historyItems);
  const customerText = [...customerHistory, String(newestMessage || "")].join("\n");
  if (!isRestaurantRequestSignal(customerText) && !/(płatno|zaliczk|payment|deposit|دفع|عربون|دفعة|оплат)/i.test(customerText)) return null;
  if (!promisedManagementEscalation(reply) && !needsManagementConfirmation(reply)) return null;
  const recent = [...customerHistory, String(newestMessage || "")].filter(Boolean).slice(-4).join(" | ");
  return {
    type: "MANAGEMENT_DECISION",
    summary: `العميل لديه طلب يحتاج قرار الإدارة. آخر تفاصيل العميل: ${recent}`,
    action: "يرجى مراجعة الطلب وتأكيد القرار والمعلومات المعتمدة التي يجب إبلاغ العميل بها. إذا كان الموضوع دفعاً/عربوناً، أرسل بيانات الدفع الرسمية فقط إن كانت معتمدة."
  };
}

async function generateAgentResult(incomingMessage, platform, extra = {}) {
  const message = String(incomingMessage || "").trim();
  if (!message) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing");
    return null;
  }

  const senderRole = ["OWNER", "AUTHORIZED_STAFF"].includes(extra?.senderRole) ? extra.senderRole : "CUSTOMER";
  const historyItems = Array.isArray(extra.history) ? extra.history.slice(-12) : [];
  const history = historyItems.map(item => `${item.role === "assistant" ? "Assistant" : senderRole}: ${String(item.content || "").trim()}`).join("\n");
  const verifiedRestaurant = formatRestaurantForAI();
  const verifiedMenu = formatMenuForAI();
  const customerOnlyContext = [...customerMessagesFromHistory(historyItems), message].join("\n");
  const likelyCatering = isCateringSignal(customerOnlyContext);

  const context = [
    `Channel: ${platform || "unknown"}`,
    `AUTHENTICATED SENDER ROLE: ${senderRole}`,
    `LIKELY PRIMARY CATERING INTENT: ${likelyCatering ? "YES" : "NO"}`,
    extra?.senderNumber ? `Authenticated sender number: ${extra.senderNumber}` : null,
    extra?.customerName ? `Known customer name: ${extra.customerName}` : null,
    `VERIFIED RESTAURANT KNOWLEDGE:\n${verifiedRestaurant}`,
    `RESTAURANT KNOWLEDGE RULES:\n- Treat knowledge above as verified management-supplied facts.\n- Do not search externally or invent missing restaurant facts.`,
    `VERIFIED CURRENT MENU:\n${verifiedMenu}`,
    `MENU USAGE RULES:\n- Use only verified menu facts.\n- Never invent item, ingredient, size, price, option or availability.\n- Never use menu prices to fabricate a catering package total.\n- Do not infer allergy safety.`,
    history ? `Recent conversation in chronological order:\n${history}` : null,
    `CUSTOMER-ONLY CONTEXT (use this for intent facts; assistant questions are not customer facts):\n${customerOnlyContext}`,
    `IMPORTANT: The message below is the newest message and has priority when resolving the current intent.`,
    `${senderRole === "CUSTOMER" ? "Customer" : "Management"} message: ${message}`
  ].filter(Boolean).join("\n\n");

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions: `${SYSTEM_PROMPT}\n\n${MANAGEMENT_MODE}\n\n${LANGUAGE_AND_CONTEXT_PROTOCOL}\n\n${RESPONSE_DISCIPLINE}\n\n${MANAGEMENT_ALERT_PROTOCOL}`,
        input: context,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 900
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 }
    );

    const raw = extractText(response.data);
    if (!raw) {
      console.error("OpenAI returned no text output", { status: response.data?.status });
      return null;
    }

    const parsed = parseAgentOutput(raw);

    if (parsed.managementAlert?.type === "ALLERGY" && !hasPositiveAllergySignal(customerOnlyContext)) {
      parsed.managementAlert = null;
    }

    if (senderRole === "CUSTOMER" && containsPaymentData(parsed.reply) && !verifiedPaymentDataExists(verifiedRestaurant)) {
      console.warn("Blocked hallucinated payment/bank details from customer reply");
      parsed.reply = safePaymentReplyForCustomer(message);
      parsed.managementAlert = {
        type: "MANAGEMENT_DECISION",
        summary: `العميل يحتاج بيانات دفع/عربون، لكن لا توجد بيانات دفع موثقة في معلومات المطعم. طلب العميل: ${message}`,
        action: "يرجى تزويد العميل ببيانات الدفع الرسمية المعتمدة أو تحديد طريقة الدفع الصحيحة. ممنوع استخدام أي رقم حساب غير موثق."
      };
    }

    if (senderRole === "CUSTOMER" && !parsed.managementAlert) {
      const allergyFallback = buildAllergyFallback(historyItems, message, parsed.reply);
      if (allergyFallback) parsed.managementAlert = allergyFallback;
    }

    if (senderRole === "CUSTOMER" && !parsed.managementAlert) {
      const decisionFallback = buildManagementDecisionFallback(historyItems, message, parsed.reply);
      if (decisionFallback) parsed.managementAlert = decisionFallback;
    }

    if (senderRole !== "CUSTOMER") parsed.managementAlert = null;
    return parsed;
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return null;
  }
}

async function generateReply(incomingMessage, platform, extra = {}) {
  const result = await generateAgentResult(incomingMessage, platform, extra);
  return result?.reply || null;
}

module.exports = { generateReply, generateAgentResult };
