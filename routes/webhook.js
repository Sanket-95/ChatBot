const express = require("express");
const router = express.Router();
const { handleChat } = require("../chatLogic");

// Webhook GET (verification)
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook POST (incoming WhatsApp messages)
router.post("/", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    
    if (!message) return res.sendStatus(200);

    const from = message.from;
    let text = "";

    // Handle different message types
    if (message.type === "text") {
      text = message.text?.body || "";
    } else if (message.type === "interactive") {
      // Handle button responses
      const buttonResponse = message.interactive?.button_reply;
      if (buttonResponse) {
        text = buttonResponse.id; // This will be "btn_1" or "btn_2"
      }
    }

    await handleChat(from, text, req.app.locals.redisClient);
    res.sendStatus(200);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

module.exports = router;