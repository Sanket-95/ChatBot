const axios = require("axios");

const SESSION_TTL = 1800; // 30 minutes

async function handleChat(from, text, redisClient) {
  const lowerText = text?.toLowerCase();
  if (!lowerText) return null;

  const redisKey = `session:${process.env.AGENCY}:${from}`;
  const existing = await redisClient.get(redisKey);

  let replyText = "";

  // GREETINGS
  const greetings = ["hi", "hello", "hie", "hey"];
  if (greetings.includes(lowerText)) {
    if (existing) {
      replyText = `Type 'List' to see the product list.\nType 'Exit' to leave the session.`;
      // Reset TTL on new message
      await redisClient.expire(redisKey, SESSION_TTL);
    } else {
      const sessionData = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString(),
        lastMessage: text
      };
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(sessionData));
      replyText = `Welcome to ${process.env.AGENCY}!\nType 'List' to see the product list.\nType 'Exit' to leave the session.`;
    }
  }

  // LIST COMMAND
  else if (lowerText === "list") {
    replyText = "📃 Product List:\n1. Product A\n2. Product B\n3. Product C\nType 'Exit' to leave the session.";
    if (existing) await redisClient.expire(redisKey, SESSION_TTL);
  }

  // EXIT COMMAND
  else if (lowerText === "exit") {
    if (existing) await redisClient.del(redisKey);
    replyText = "Your session has been ended. Send 'Hi' to start again.";
  }

  // OTHER MESSAGES
  else {
    replyText = "Sorry, I didn't understand. Type 'List' to see products.\nType 'Exit' to leave the session.";
    if (existing) await redisClient.expire(redisKey, SESSION_TTL);
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

  return replyText;
}

module.exports = { handleChat };
