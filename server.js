require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const meta = require("./handlers/meta");
const whatsapp = require("./handlers/whatsapp");
const { generateReply } = require("./services/aiReply");

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("✅ Social Media Agent شغال تمام");
});

// Health check: confirms configuration without exposing secrets.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "not-set",
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    whatsappConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN)
  });
});

// Temporary fixed-message AI test. Enable only with ENABLE_TEST_ENDPOINT=true.
// It does not accept arbitrary user input, which limits accidental API usage.
app.get("/test-agent", async (req, res) => {
  if (process.env.ENABLE_TEST_ENDPOINT !== "true") {
    return res.status(404).send("Not Found");
  }

  try {
    const reply = await generateReply(
      "مرحبا، أول مرة بدي جرب مطعمكم وما بعرف شو أطلب. شو بتنصحني؟",
      "internal_test"
    );

    if (!reply) {
      return res.status(503).json({
        ok: false,
        message: "Agent returned no reply. Check Render logs and reply hours."
      });
    }

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("Test endpoint error:", err.message);
    return res.status(500).json({ ok: false, message: "Agent test failed" });
  }
});

app.get("/privacy", (req, res) => {
  res.send(`
    <h1>Freshly Lite Privacy Policy</h1>
    <p>Freshly Lite uses customer messages only to provide customer service,
    answer questions, and assist with restaurant orders.</p>
    <p>We do not sell personal information to third parties.</p>
    <p>Customers may request deletion of their information by contacting Freshly Lite.</p>
    <p>Contact: info@freshlylite.com</p>
  `);
});

// ===== Facebook + Instagram =====
app.get("/webhook/meta", meta.verifyWebhook);
app.post("/webhook/meta", meta.handleEvent);

// ===== WhatsApp =====
app.get("/webhook/whatsapp", whatsapp.verifyWebhook);
app.post("/webhook/whatsapp", whatsapp.handleEvent);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على المنفذ ${PORT}`);
});
