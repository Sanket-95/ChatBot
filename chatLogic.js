const axios = require("axios");

/**
 * Handle WhatsApp chat messages
 * @param {string} from - user phone number
 * @param {string} text - user message text
 * @param {RedisClient} redisClient - redis instance
 */
async function handleChat(from, text, redisClient) {
  const greetings = ["hi", "hello", "hie", "hey"];
  const lowerText = text?.toLowerCase();

  if (!lowerText) return null;

  const redisKey = `session:${process.env.AGENCY}:${from}`;
  const existing = await redisClient.get(redisKey);

  let replyText = "";

  if (greetings.includes(lowerText)) {
    if (existing) {
      replyText = `Type 'List' to see the product list.`;
    } else {
      const sessionData = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString(),
        lastMessage: text
      };

      await redisClient.setEx(redisKey, Number(process.env.SESSION_TTL), JSON.stringify(sessionData));
      replyText = `Welcome to ${process.env.AGENCY}!\nType 'List' to see the product list.`;
    }
  } 
  // Example: more Q&A logic
  else if (lowerText === "list") {
    replyText = "📃 Product List:\n1. Product A\n2. Product B\n3. Product C";
  } 
  else {
    replyText = "Sorry, I didn't understand. Type 'List' to see products.";
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
