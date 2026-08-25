const axios = require("axios");
const { SYSTEM_PROMPT } = require("../prompts/restaurantAssistant");
const { formatMenuForAI } = require("../data/menu");

const MANAGEMENT_ALERT_PROTOCOL = `
## INTERNAL MANAGEMENT ALERT PROTOCOL
This protocol is machine-readable and MUST NEVER be shown to the customer.

Create a management alert ONLY for these important cases:
1. CATERING: the catering request has enough useful details and now needs pricing/approval, OR an off-menu/special catering request needs management judgment.
2. COMPLAINT: an important/serious complaint that should reach management now. Ordinary mild negative feedback does not require an immediate alert.
3. ALLERGY: a serious allergy/safety question where verified information is insufficient and management confirmation is required.
4. ANGRY: the customer is seriously angry, abusive, threatening, or the situation has escalated beyond normal customer service.
5. DISCOUNT: the customer requests a discount, special price, compensation, free item, or exception that requires authorization.
6. BUSINESS: a company, supplier, influencer, collaboration, partnership, event, or commercial proposal that management should review.
7. MANAGEMENT_DECISION: any other case where your customer-facing reply genuinely says a management/responsible-person decision or confirmation is required.
8. UNUSUAL: a genuinely unusual/sensitive request that should be seen by management now.

Do NOT alert management for normal menu questions, normal recommendations, ordinary delivery questions, normal pickup questions before confirmation is needed, compliments, or routine conversation.
Do NOT create repeated alerts for the same unresolved issue unless new important information materially changes the case.

If NO immediate management alert is needed, return only the normal customer reply.

If an alert IS needed, append this exact block AFTER the customer reply:
<<<MANAGEMENT_ALERT>>>
TYPE: one of CATERING, COMPLAINT, ALLERGY, ANGRY, DISCOUNT, BUSINESS, MANAGEMENT_DECISION, UNUSUAL
SUMMARY: concise factual summary using the current message and relevant recent conversation history
ACTION: exactly what management needs to decide, confirm, price, review, or know
<<<END_MANAGEMENT_ALERT>>>

The customer-facing text before this block must remain natural and must not mention the internal block.
Never put protected internal data in the customer reply.
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

  if (!match) {
    return { reply: text, managementAlert: null };
  }

  const reply = text.replace(match[0], "").trim();
  const allowedTypes = new Set([
    "CATERING",
    "COMPLAINT",
    "ALLERGY",
    "ANGRY",
    "DISCOUNT",
    "BUSINESS",
    "MANAGEMENT_DECISION",
    "UNUSUAL"
  ]);

  const type = match[1].trim().toUpperCase();
  const summary = match[2].trim();
  const action = match[3].trim();

  return {
    reply,
    managementAlert: allowedTypes.has(type) && summary && action
      ? { type, summary, action }
      : null
  };
}

async function generateAgentResult(incomingMessage, platform, extra = {}) {
  const message = String(incomingMessage || "").trim();
  if (!message) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing");
    return null;
  }

  const history = Array.isArray(extra.history)
    ? extra.history.slice(-12).map(item => `${item.role === "assistant" ? "Assistant" : "Customer"}: ${String(item.content || "").trim()}`).join("\n")
    : "";

  const verifiedMenu = formatMenuForAI();

  const context = [
    `Channel: ${platform || "unknown"}`,
    extra?.customerName ? `Known customer name: ${extra.customerName}` : null,
    `VERIFIED CURRENT MENU:\n${verifiedMenu}`,
    `MENU USAGE RULES:\n- The menu above is the verified source for current item names, listed sizes/quantities, descriptions/ingredients and prices.\n- You may translate/explain these verified facts naturally into the customer's language.\n- Never invent an item, ingredient, size, price, option or availability not present in verified information.\n- A listed menu item is not proof that it is currently in stock; do not promise real-time availability unless separately confirmed.\n- When recommending food, recommend only verified menu items and use the listed descriptions to match customer preferences.\n- Do not infer allergy safety from the ingredient descriptions. Follow the system allergen rules.\n- If the menu contains an apparent inconsistency or duplicate with different category/price, use the exact category/context requested; if still ambiguous, ask a short clarifying question rather than guessing.`,
    history ? `Recent conversation:\n${history}` : null,
    `Customer message: ${message}`
  ].filter(Boolean).join("\n\n");

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions: `${SYSTEM_PROMPT}\n\n${MANAGEMENT_ALERT_PROTOCOL}`,
        input: context,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 900
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const raw = extractText(response.data);
    if (!raw) {
      console.error("OpenAI returned no text output", {
        status: response.data?.status,
        incomplete_details: response.data?.incomplete_details,
        output_types: (response.data?.output || []).map(item => item?.type)
      });
      return null;
    }

    return parseAgentOutput(raw);
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
