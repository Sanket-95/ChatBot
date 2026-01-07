const express = require("express");
const router = express.Router();

// Send a chat message
router.post("/send", async (req, res) => {
  try {
    const redis = req.app.locals.redis;
    const { user, message } = req.body;

    if (!user || !message) {
      return res.status(400).json({ error: "user and message required" });
    }

    await redis.rPush("chat_messages", JSON.stringify({
      user,
      message,
      time: new Date()
    }));

    res.json({ status: "message stored" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Redis write failed" });
  }
});

// Get all chat messages
router.get("/messages", async (req, res) => {
  try {
    const redis = req.app.locals.redis;
    const messages = await redis.lRange("chat_messages", 0, -1);
    res.json(messages.map(m => JSON.parse(m)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Redis read failed" });
  }
});

module.exports = router;
