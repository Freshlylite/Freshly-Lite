const axios = require("axios");
const { SYSTEM_PROMPT } = require("../prompts/restaurantAssistant");
const { formatMenuForAI } = require("../data/menu");

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

async function generateReply(incomingMessage, platform, extra = {}) {
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
        instructions: SYSTEM_PROMPT,
        input: context,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 700
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const reply = extractText(response.data);
    if (!reply) {
      console.error("OpenAI returned no text output", {
        status: response.data?.status,
        incomplete_details: response.data?.incomplete_details,
        output_types: (response.data?.output || []).map(item => item?.type)
      });
      return null;
    }
    return reply;
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return null;
  }
}

module.exports = { generateReply };
