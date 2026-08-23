require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const meta = require("./handlers/meta");
const whatsapp = require("./handlers/whatsapp");

const app = express();
app.use(bodyParser.json());

// صفحة رئيسية بسيطة للتأكد إن السيرفر شغال
app.get("/", (req, res) => {
  res.send("✅ Social Media Agent شغال تمام");
});

// ===== فيسبوك + انستقرام (نفس webhook لأنهم من Meta) =====
app.get("/webhook/meta", meta.verifyWebhook);
app.post("/webhook/meta", meta.handleEvent);

// ===== واتساب =====
app.get("/webhook/whatsapp", whatsapp.verifyWebhook);
app.post("/webhook/whatsapp", whatsapp.handleEvent);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على المنفذ ${PORT}`);
});
