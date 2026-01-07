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

// Auto connect Redis on server start
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
   WHATSAPP MESSAGE HANDLER
========================= */
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from; // mobile number
    const text = message.text?.body?.toLowerCase();

    const greetings = ["hi", "hello", "hie", "hey"];

    if (!text || !greetings.includes(text)) {
      return res.sendStatus(200);
    }

    const redisKey = `session:${process.env.AGENCY}:${from}`;
    const existing = await redisClient.get(redisKey);

    let replyText = "";

    if (existing) {
      // Already in Redis → Just reply list message
      replyText = `Type 'List' to see the product list.`;
    } else {
      // First time → Add to Redis and send welcome + list message
      const sessionData = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString(),
        lastMessage: text
      };

      await redisClient.setEx(
        redisKey,
        Number(process.env.SESSION_TTL),
        JSON.stringify(sessionData)
      );

      replyText = `Welcome to ${process.env.AGENCY}! \nType 'List' to see the product list.`;
    }

    // Send WhatsApp reply
    await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: replyText }
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
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

/* =========================
   REDIS VIEW (BROWSER)
========================= */

// Store demo data
app.get("/redis/store", async (req, res) => {
  const data = {
    server: "157.245.109.223",
    app: "whatsapp-bot",
    status: "Redis Working",
    time: new Date()
  };

  await redisClient.set("redis_test_data", JSON.stringify(data));

  res.json({ message: "Data stored", data });
});

// Get demo data
app.get("/redis/get", async (req, res) => {
  const data = await redisClient.get("redis_test_data");
  if (!data) return res.status(404).json({ error: "No data found" });
  res.json(JSON.parse(data));
});

// View all WhatsApp sessions
app.get("/redis/sessions", async (req, res) => {
  const keys = await redisClient.keys(`session:${process.env.AGENCY}:*`);
  const result = [];

  for (const key of keys) {
    const data = await redisClient.get(key);
    const ttl = await redisClient.ttl(key);
    result.push({
      key,
      ttl,
      data: JSON.parse(data)
    });
  }

  res.json(result);
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Server running",
    agency: process.env.AGENCY
  });
});

/* =========================
   START SERVER
========================= */
app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});
