const express = require("express");
const router = express.Router();

// Store demo data
router.get("/store", async (req, res) => {
  const data = { server: "157.245.109.223", app: "whatsapp-bot", status: "Redis Working", time: new Date() };
  await req.app.locals.redisClient.set("redis_test_data", JSON.stringify(data));
  res.json({ message: "Data stored", data });
});

// Get demo data
router.get("/get", async (req, res) => {
  const data = await req.app.locals.redisClient.get("redis_test_data");
  if (!data) return res.status(404).json({ error: "No data found" });
  res.json(JSON.parse(data));
});

// View WhatsApp sessions
router.get("/sessions", async (req, res) => {
  const keys = await req.app.locals.redisClient.keys(`session:${process.env.AGENCY}:*`);
  const result = [];
  for (const key of keys) {
    const data = await req.app.locals.redisClient.get(key);
    const ttl = await req.app.locals.redisClient.ttl(key);
    result.push({ key, ttl, data: JSON.parse(data) });
  }
  res.json(result);
});

module.exports = router;
