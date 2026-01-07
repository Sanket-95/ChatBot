const express = require("express");
const axios = require("axios");
const redis = require("redis");
require("dotenv").config();

const app = express();
app.use(express.json());

/* =========================
   REDIS CLIENT
========================= */
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

redisClient.on("connect", () => {
  console.log("✅ Redis connected");
});

redisClient.on("error", (err) => {
  console.error("❌ Redis error:", err);
});

(async () => {
  await redisClient.connect();
})();

/* =========================
   WEBHOOK VERIFICATION
========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =========================
   MESSAGE HANDLER
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from; // mobile number
    const text = message.text?.body?.toLowerCase();

    // Only greeting messages
    const greetings = ["hi", "hello", "hie", "hey"];

    if (!text || !greetings.includes(text)) {
      return res.sendStatus(200);
    }

    const redisKey = `session:${process.env.AGENCY}:${from}`;

    const existingSession = await redisClient.get(redisKey);

    let replyMessage = "";

    if (existingSession) {
      replyMessage = `Hello ${from}, session already available in redis`;
    } else {
      const sessionObject = {
        agency: process.env.AGENCY,
        mobile: from,
        startedAt: new Date().toISOString(),
        step: 1
      };

      await redisClient.setEx(
        redisKey,
        Number(process.env.SESSION_TTL),
        JSON.stringify(sessionObject)
      );

      replyMessage = `Hello ${from}, you are added in redis`;
    }

    // Send WhatsApp reply
    await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: replyMessage }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({
    status: "Bot running",
    agency: process.env.AGENCY
  });
});

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`🚀 WhatsApp bot running on port ${process.env.PORT}`);
});
