const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ============ ENVIRONMENT VARIABLES ============
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iraqibot123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ============ SYSTEM PROMPT (شخصية البوت) ============
const SYSTEM_PROMPT = `أنت موظف مبيعات ذكي ومحترف تمثل بيج عراقي يبيع جهاز قياس الضغط الناطق.

معلومات المنتج:
- الاسم: جهاز قياس الضغط الناطق
- السعر: 35,000 دينار
- التوصيل: مجاني لكل محافظات العراق
- الضمان: استبدال أو استرجاع خلال 7 أيام في حالة وجود خلل أو ضرر من المصنع فقط (لا يشمل سوء الاستخدام)
- الدفع: عند الاستلام

أسلوبك:
- تحكي باللهجة العراقية العامية بشكل طبيعي
- شبابي واحترافي بنفس الوقت
- ذكي بالمبيعات وما تستسلم بسرعة
- تفهم سياق الكلام حتى لو الزبون ما كتب صح

استراتيجية المبيعات:
1. رحب بالزبون بشكل طبيعي وأسأله شنو يريد
2. اشرح مميزات الجهاز بذكاء حسب احتياج الزبون
3. لو قال "غالي": برر القيمة، اذكر الضمان والتوصيل المجاني، قارن بالأسواق
4. لو قال "بكره" أو "أفكر": خوفه بلطف من نفاذ الكمية أو ارتفاع السعر
5. لو قال "مو محتاج": اكشف الحاجة الحقيقية (صحة الأهل، راحة البال)
6. لو قال "اكو توصيل": أكد التوصيل المجاني لكل العراق
7. لو قال "الضمان شنو": اشرح ضمان 7 أيام بوضوح
8. لو قال "قاط" أو "مو مهتم": اسأله شنو اللي خلاه يتردد
9. لو قال "حجزلي" أو "أريد أطلب": اجمع البيانات خطوة بخطوة:
   - الاسم الكامل
   - رقم الموبايل
   - المحافظة
   - العنوان بالتفصيل
10. بعد جمع كل البيانات الأربعة (الاسم، الموبايل، المحافظة، العنوان): أكد الطلب، اشكره، وأخبره بموعد التوصيل (1-3 أيام حسب المحافظة)

مميزات تذكرها دايماً:
- الجهاز يقرأ النتيجة بصوت عالي (مفيد لكبار السن وضعاف البصر)
- دقيق طبياً ومعتمد
- سهل الاستخدام
- تغطي كل العراق بتوصيل مجاني

قواعد مهمة جداً:
- لا تكرر نفس الجملة مرتين. كل رد يكون طبيعي ومختلف حسب سياق المحادثة.
- الردود تكون قصيرة ومباشرة مثل موظف مبيعات حقيقي بالواتساب (2-4 أسطر بالكثير).
- إذا جمعت كل بيانات الطلب الأربعة (الاسم الكامل، رقم الموبايل، المحافظة، العنوان)، في نهاية ردك أضف هذا السطر بالضبط بشكل منفصل:
ORDER_COMPLETE: {"name": "الاسم", "phone": "الرقم", "province": "المحافظة", "address": "العنوان"}
لا تضيف هذا السطر إلا إذا كانت كل المعلومات الأربعة مكتملة فعلاً.`;

// ============ MEMORY (محادثات بسيطة بالذاكرة) ============
const conversations = {};

// ============ GEMINI AI CALL ============
async function askGemini(userId, userMessage) {
  if (!conversations[userId]) {
    conversations[userId] = [];
  }

  conversations[userId].push({ role: "user", parts: [{ text: userMessage }] });

  // keep last 20 messages only
  if (conversations[userId].length > 20) {
    conversations[userId] = conversations[userId].slice(-20);
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: conversations[userId],
      }
    );

    const reply = response.data.candidates[0].content.parts[0].text;
    conversations[userId].push({ role: "model", parts: [{ text: reply }] });

    return reply;
  } catch (err) {
    console.error("Gemini error:", err.response?.data || err.message);
    return "عذراً، صار خطأ مؤقت 😅 جرب مرة ثانية.";
  }
}

// ============ EXTRACT ORDER & SAVE TO SHEETS ============
async function checkAndSaveOrder(reply, userPhone) {
  const match = reply.match(/ORDER_COMPLETE:\s*(\{.*\})/);
  if (!match) return reply;

  try {
    const orderData = JSON.parse(match[1]);
    await saveToGoogleSheets(orderData, userPhone);
    // remove the ORDER_COMPLETE line from what we send to user
    return reply.replace(/ORDER_COMPLETE:\s*\{.*\}/, "").trim();
  } catch (e) {
    console.error("Order parse error:", e.message);
    return reply.replace(/ORDER_COMPLETE:\s*\{.*\}/, "").trim();
  }
}

async function saveToGoogleSheets(orderData, userPhone) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log("Google Sheets not configured, skipping save.");
    return;
  }

  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const today = new Date().toLocaleDateString("ar-IQ");

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          orderData.name || "",
          orderData.phone || userPhone || "",
          orderData.province || "",
          orderData.address || "",
          today,
        ]],
      },
    });

    console.log("Order saved to Google Sheets ✅");
  } catch (err) {
    console.error("Sheets error:", err.message);
  }
}

// ============ WHATSAPP WEBHOOK VERIFICATION ============
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============ WHATSAPP WEBHOOK - INCOMING MESSAGES ============
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // respond fast to Meta

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from; // phone number
    const text = message.text?.body;

    if (!text) return;

    console.log(`Message from ${from}: ${text}`);

    let reply = await askGemini(from, text);
    reply = await checkAndSaveOrder(reply, from);

    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ============ SEND WHATSAPP MESSAGE ============
async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("WhatsApp not configured. Would send:", text);
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Reply sent ✅");
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
  }
}

// ============ TEST ENDPOINT (for browser testing without WhatsApp) ============
app.post("/test", async (req, res) => {
  try {
    const { userId, message } = req.body;
    let reply = await askGemini(userId || "test_user", message);
    reply = await checkAndSaveOrder(reply, userId || "test_user");
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HEALTH CHECK ============
app.get("/", (req, res) => {
  res.send("🤖 Iraqi Sales Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
