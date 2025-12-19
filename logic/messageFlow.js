const redisService = require("../services/redisService");
const dbService = require("../services/dbService");
const whatsappService = require("../services/whatsappService");

async function handleIncomingMessage(mobile, text) {
  console.log("🔁 Checking session for:", mobile);

  const sessionExists = await redisService.hasSession(mobile);

  if (!sessionExists) {
    console.log("🆕 New chat detected");

    // Create Redis session (2 hours)
    await redisService.createSession(mobile);

    // Get categories
    const categories = await dbService.getMainCategories();

    let reply = `👋 Welcome to ${process.env.AGENCY_NAME}\n\n`;
    reply += "📦 Please select a category:\n";

    categories.forEach((cat, index) => {
      reply += `${index + 1}. ${cat.name}\n`;
    });

    await whatsappService.sendMessage(mobile, reply);
  } else {
    console.log("♻️ Existing session (logic will come later)");
  }
}

module.exports = { handleIncomingMessage };
