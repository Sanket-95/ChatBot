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
    console.log("📩 Received webhook payload:", JSON.stringify(req.body, null, 2));
    
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      console.log("❌ No message found in payload");
      return res.sendStatus(200);
    }

    const from = message.from;
    console.log(`📞 Message from: ${from}`);
    console.log(`📦 Message type: ${message.type}`);

    let text = "";

    // Handle different message types
    if (message.type === "text") {
      text = message.text?.body;
      console.log(`📝 Text message: "${text}"`);
    } else if (message.type === "interactive") {
      // Handle button clicks
      if (message.interactive?.type === "button_reply") {
        text = message.interactive.button_reply?.title;
        console.log(`🔼 Button click: "${text}"`);
      } else {
        console.log(`❓ Unknown interactive type: ${message.interactive?.type}`);
      }
    } else {
      console.log(`🚫 Unsupported message type: ${message.type}`);
    }

    if (text) {
      await handleChat(from, text, req.app.locals.redisClient);
    } else {
      console.log("❌ No text content to process");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    console.error("Error stack:", err.stack);
    res.sendStatus(500);
  }
});

module.exports = router;