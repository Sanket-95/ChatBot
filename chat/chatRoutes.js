const express = require("express");
const router = express.Router();

// Send a message
router.post("/send", async (req, res) => {
  const redis = req.app.locals.redis;
  const { user, message } = req.body;

  if (!user || !message) return res.status(400).json({ error: "user and message required" });

  await redis.rPush("chat_messages", JSON.stringify({ user, message, time: new Date() }));

  res.json({ status: "message stored" });
});

// Get all messages
router.get("/messages", async (req, res) => {
  const redis = req.app.locals.redis;
  const messages = await redis.lRange("chat_messages", 0, -1);
  res.json(messages.map(m => JSON.parse(m)));
});

module.exports = router;
