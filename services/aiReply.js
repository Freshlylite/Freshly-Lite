const axios = require("axios");
const { SYSTEM_PROMPT } = require("../prompts/restaurantAssistant");
const { formatMenuForAI } = require("../data/menu");
const { formatRestaurantForAI } = require("../data/restaurant");

const MANAGEMENT_ALERT_PROTOCOL = `
## INTERNAL MANAGEMENT ALERT PROTOCOL
This protocol is machine-readable and MUST NEVER be shown to the customer.
Create a management alert ONLY for important customer cases: CATERING, COMPLAINT, ALLERGY, ANGRY, DISCOUNT, BUSINESS, MANAGEMENT_DECISION, UNUSUAL.
Do NOT alert for routine conversation or requests outside Freshly Lite services.
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
- If the question is fully answered, end the reply; do not add generic follow-up offers.
- Ask a follow-up only when genuinely required to complete the current Freshly Lite request/workflow.
- Unknown out-of-scope facts are not escalated to management.
`;

const MANAGEMENT_MODE = `
## AUTHENTICATED MANAGEMENT MODE — HIGHEST PRIORITY
The server has authenticated this sender by exact normalized WhatsApp number. This is NOT an inference from wording.
- OWNER means the restaurant owner/primary management. NEVER treat OWNER as a customer.
- AUTHORIZED_STAFF means an authenticated staff member. NEVER treat that sender as a customer.
- Messages from OWNER are administrative commands, decisions, answers to open cases, corrections, approvals/rejections, or management questions.
- Do not run the customer-service flow on an OWNER message and do not create a management alert about an OWNER/STAFF message.
- If the owner gives a clear executable instruction, interpret it as an instruction. Never ask them to explain as though they were a customer.
- Only claim an external action was completed if the application actually provides the required execution context/tool. Otherwise state briefly in Arabic that the instruction is understood but that action is not yet technically executable.
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

async function generateAgentResult(incomingMessage, platform, extra = {}) {
  const message = String(incomingMessage || "").trim();
  if (!message) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing");
    return null;
  }

  const senderRole = ["OWNER", "AUTHORIZED_STAFF"].includes(extra?.senderRole) ? extra.senderRole : "CUSTOMER";
  const history = Array.isArray(extra.history)
    ? extra.history.slice(-12).map(item => `${item.role === "assistant" ? "Assistant" : senderRole}: ${String(item.content || "").trim()}`).join("\n")
    : "";
  const verifiedRestaurant = formatRestaurantForAI();
  const verifiedMenu = formatMenuForAI();

  const context = [
    `Channel: ${platform || "unknown"}`,
    `AUTHENTICATED SENDER ROLE: ${senderRole}`,
    extra?.senderNumber ? `Authenticated sender number: ${extra.senderNumber}` : null,
    extra?.customerName ? `Known customer name: ${extra.customerName}` : null,
    `VERIFIED RESTAURANT KNOWLEDGE:\n${verifiedRestaurant}`,
    `RESTAURANT KNOWLEDGE RULES:\n- Treat knowledge above as verified management-supplied facts.\n- Do not search externally or invent missing restaurant facts.`,
    `VERIFIED CURRENT MENU:\n${verifiedMenu}`,
    `MENU USAGE RULES:\n- Use only verified menu facts.\n- Never invent item, ingredient, size, price, option or availability.\n- Do not infer allergy safety.`,
    history ? `Recent conversation:\n${history}` : null,
    `${senderRole === "CUSTOMER" ? "Customer" : "Management"} message: ${message}`
  ].filter(Boolean).join("\n\n");

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions: `${SYSTEM_PROMPT}\n\n${MANAGEMENT_MODE}\n\n${RESPONSE_DISCIPLINE}\n\n${MANAGEMENT_ALERT_PROTOCOL}`,
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
