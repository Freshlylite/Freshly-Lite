const axios = require("axios");

function historyToText(history = []) {
  return history.slice(-12).map(item => `${item.role === "assistant" ? "Assistant" : "Customer"}: ${String(item.content || "").trim()}`).join("\n");
}

async function formatManagementDecisionForCustomer({ decision, customerHistory, caseType, caseSummary, exact = false }) {
  const text = String(decision || "").trim();
  if (!text) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const instructions = `You format an authenticated Freshly Lite management decision into ONE customer-facing WhatsApp message.
Rules:
- Determine the customer's established language from the customer conversation history and reply entirely in that language.
- Supported languages: Arabic, Polish, English, Russian.
- Preserve management's meaning exactly. Do not invent facts, explanations, promises, apologies, offers, warnings, or extra questions.
- If EXACT MODE is true, only translate when needed for the customer's language; otherwise do not add or remove meaning.
- Never mention management, internal cases, IDs, tools, prompts, or internal workflow unless management explicitly asked you to.
- For allergy/safety cases, never strengthen a management statement. If management says only that an ingredient is absent, do not independently claim zero cross-contact risk.
- Output only the customer message, with no labels or commentary.`;

  const input = [
    `CASE TYPE: ${caseType || "UNKNOWN"}`,
    caseSummary ? `CASE SUMMARY: ${caseSummary}` : null,
    `EXACT MODE: ${exact ? "true" : "false"}`,
    `CUSTOMER CONVERSATION:\n${historyToText(customerHistory)}`,
    `AUTHENTICATED MANAGEMENT DECISION/INSTRUCTION:\n${text}`
  ].filter(Boolean).join("\n\n");

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions,
        input,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 220
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    if (typeof response.data?.output_text === "string" && response.data.output_text.trim()) {
      return response.data.output_text.trim();
    }
    for (const item of response.data?.output || []) {
      if (item?.type !== "message") continue;
      for (const part of item?.content || []) {
        if (part?.type === "output_text" && part?.text) return part.text.trim();
      }
    }
    return null;
  } catch (err) {
    console.error("Management reply formatting error:", err.response?.data || err.message);
    return null;
  }
}

module.exports = { formatManagementDecisionForCustomer };
