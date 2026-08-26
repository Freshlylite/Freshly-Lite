require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const meta = require("./handlers/meta");
const whatsapp = require("./handlers/whatsapp");
const { generateReply } = require("./services/aiReply");
const storage = require("./services/storage");

const app = express();
app.use(bodyParser.json({ limit: "100kb" }));

app.get("/", (req, res) => {
  res.send("✅ Social Media Agent شغال تمام");
});

app.get("/health", async (req, res) => {
  let databaseConnected = false;
  try {
    databaseConnected = await storage.healthCheck();
  } catch (err) {
    console.error("Database health check failed:", err.message);
  }

  res.json({
    status: databaseConnected ? "ok" : "degraded",
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "not-set",
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    whatsappConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    databaseConnected
  });
});

function testEnabled(req, res, next) {
  if (process.env.ENABLE_TEST_ENDPOINT !== "true") return res.status(404).send("Not Found");
  next();
}

app.get("/test-agent", testEnabled, (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freshly Lite Agent Test</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f2;font-family:Arial,sans-serif;color:#20231f}.wrap{max-width:820px;margin:30px auto;padding:16px}.card{background:white;border:1px solid #ddd;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px #00000010}.head{padding:18px 22px;background:#173d2b;color:white}.head h2{margin:0 0 5px}.head small{opacity:.8}.controls{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid #eee;direction:ltr}.controls select,.controls button{padding:9px 12px;border:1px solid #ccc;border-radius:9px;background:white}.chat{height:500px;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px;direction:ltr}.msg{max-width:78%;padding:11px 14px;border-radius:14px;white-space:pre-wrap;line-height:1.45}.user{align-self:flex-end;background:#dcecdf}.bot{align-self:flex-start;background:#f0f0ed}.status{align-self:center;font-size:12px;color:#777}.composer{display:flex;gap:10px;padding:14px;border-top:1px solid #eee;direction:ltr}.composer textarea{flex:1;resize:none;padding:12px;border:1px solid #ccc;border-radius:12px;font:inherit}.composer button{border:0;border-radius:12px;padding:0 22px;background:#173d2b;color:white;font-weight:bold;cursor:pointer}.composer button:disabled{opacity:.5}@media(max-width:600px){.wrap{margin:0;padding:0}.card{border-radius:0}.chat{height:70vh}.msg{max-width:88%}}
</style></head>
<body><div class="wrap"><div class="card"><div class="head"><h2>Freshly Lite — Agent Test</h2><small>V2 Prompt • بيئة اختبار فقط</small></div><div class="controls"><select id="platform"><option value="instagram">Instagram</option><option value="whatsapp">WhatsApp</option><option value="facebook">Facebook</option><option value="tiktok">TikTok</option></select><button onclick="resetChat()">New conversation</button></div><div id="chat" class="chat"><div class="status">اكتب رسالة كأنك عميل</div></div><div class="composer"><textarea id="message" rows="2" placeholder="Customer message..."></textarea><button id="send">Send</button></div></div></div>
<script>
let history=[];const chat=document.getElementById('chat'),input=document.getElementById('message'),send=document.getElementById('send');
function add(text,cls){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;d.dir='auto';chat.appendChild(d);chat.scrollTop=chat.scrollHeight}
function resetChat(){history=[];chat.innerHTML='<div class="status">محادثة جديدة</div>';input.focus()}
async function submit(){const message=input.value.trim();if(!message)return;add(message,'user');input.value='';send.disabled=true;const wait=document.createElement('div');wait.className='status';wait.textContent='Agent is thinking...';chat.appendChild(wait);try{const r=await fetch('/test-agent/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,platform:document.getElementById('platform').value,history})});const data=await r.json();wait.remove();if(!r.ok)throw new Error(data.message||'Request failed');add(data.reply,'bot');history.push({role:'user',content:message},{role:'assistant',content:data.reply});history=history.slice(-12)}catch(e){wait.remove();add('Error: '+e.message,'bot')}finally{send.disabled=false;input.focus()}}
send.onclick=submit;input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit()}});
</script></body></html>`);
});

app.post("/test-agent/message", testEnabled, async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 2000);
  const allowedPlatforms = new Set(["instagram", "whatsapp", "facebook", "tiktok"]);
  const platform = allowedPlatforms.has(req.body?.platform) ? req.body.platform : "internal_test";
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12).map(x => ({ role: x?.role === "assistant" ? "assistant" : "user", content: String(x?.content || "").slice(0, 2000) })) : [];
  if (!message) return res.status(400).json({ ok:false, message:"Message is required" });
  try {
    const reply = await generateReply(message, platform, { history });
    if (!reply) return res.status(503).json({ ok:false, message:"Agent returned no reply. Check Render logs." });
    res.json({ ok:true, reply });
  } catch (err) {
    console.error("Interactive test error:", err.message);
    res.status(500).json({ ok:false, message:"Agent test failed" });
  }
});

app.get("/privacy", (req, res) => {
  res.send(`<h1>Freshly Lite Privacy Policy</h1><p>Freshly Lite uses customer messages only to provide customer service, answer questions, and assist with restaurant orders.</p><p>We do not sell personal information to third parties.</p><p>Customers may request deletion of their information by contacting Freshly Lite.</p><p>Contact: info@freshlylite.com</p>`);
});

app.get("/webhook/meta", meta.verifyWebhook);
app.post("/webhook/meta", meta.handleEvent);
app.get("/webhook/whatsapp", whatsapp.verifyWebhook);
app.post("/webhook/whatsapp", whatsapp.handleEvent);

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await storage.initStorage();
    app.listen(PORT, () => console.log(`🚀 السيرفر شغال على المنفذ ${PORT}`));
  } catch (err) {
    console.error("❌ Failed to initialize persistent memory:", err);
    process.exit(1);
  }
}

start();
