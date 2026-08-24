const axios = require("axios");
const { SYSTEM_PROMPT } = require("../prompts/restaurantAssistant");

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

  const context = [
    `Channel: ${platform || "unknown"}`,
    extra?.customerName ? `Known customer name: ${extra.customerName}` : null,
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