const axios = require("axios");
const db = require("./db");

const SESSION_TTL = 1800; // 30 minutes

async function handleChat(from, text, redisClient) {
  const lowerText = text?.toLowerCase();
  if (!lowerText) return;

  const redisKey = `session:${process.env.AGENCY}:${from}`;
  const existing = await redisClient.get(redisKey);

  let replyText = "";

  /* =====================
     GREETINGS
  ===================== */
  const greetings = ["hi", "hello", "hie", "hey"];

  if (greetings.includes(lowerText)) {
    if (!existing) {
      await redisClient.setEx(
        redisKey,
        SESSION_TTL,
        JSON.stringify({
          agency: process.env.AGENCY,
          mobile: from,
          createdAt: new Date(),
          lastMessage: text
        })
      );

      replyText =
        `Welcome to ${process.env.AGENCY}!\n` +
        `Type 'List' to see categories.\n` +
        `Type 'Exit' to leave the session.`;
    } else {
      await redisClient.expire(redisKey, SESSION_TTL);
      replyText =
        `Type 'List' to see categories.\n` +
        `Type 'Exit' to leave the session.`;
    }
  }

  /* =====================
     LIST (DATABASE)
  ===================== */
  else if (lowerText === "list") {
    if (!existing) {
      replyText = "Session expired. Please type 'Hi' to start again.";
    } else {
      await redisClient.expire(redisKey, SESSION_TTL);

      const [rows] = await db.execute(
        `
        SELECT DISTINCT(category_name)
        FROM category
        WHERE parent_id = 0
        AND id IN (
          SELECT DISTINCT(ct_id)
          FROM agency_categories
          WHERE ag_id = ?
        )
        `,
        [process.env.AGENCY_ID]
      );

      if (rows.length === 0) {
        replyText = "No categories available at the moment.";
      } else {
        let msg = "📦 Categories:\n\n";
        rows.forEach((row, index) => {
          msg += `${index + 1}. ${row.category_name}\n`;
        });

        msg += `\nType 'Exit' to leave the session.`;
        replyText = msg;
      }
    }
  }

  /* =====================
     EXIT
  ===================== */
  else if (lowerText === "exit") {
    if (existing) await redisClient.del(redisKey);
    replyText = "Session ended. Type 'Hi' to start again.";
  }

  /* =====================
     FALLBACK
  ===================== */
  else {
    if (existing) await redisClient.expire(redisKey, SESSION_TTL);
    replyText =
      "Invalid option.\nType 'List' to see categories.\nType 'Exit' to leave.";
  }

  /* =====================
     SEND WHATSAPP MESSAGE
  ===================== */
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
}

module.exports = { handleChat };
