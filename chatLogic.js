const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL);

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
      const sessionData = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString(),
        lastMessage: "hi"
      };

      await redisClient.setEx(
        redisKey,
        SESSION_TTL,
        JSON.stringify(sessionData)
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
      try {
        await redisClient.expire(redisKey, SESSION_TTL);

        const [rows] = await db.execute(
          `
          SELECT id, category_name
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
          const categoryMap = {};

          rows.forEach((row, index) => {
            const num = index + 1;
            msg += `${num}. ${row.category_name}\n`;

            categoryMap[num] = {
              id: row.id,
              name: row.category_name
            };
          });

          msg +=
            `\nReply with category number\n` +
            `Example: Type 1\n` +
            `Type 'Exit' to leave`;

          // update redis session with category map
          const sessionData = JSON.parse(existing);
          sessionData.lastMessage = "list";
          sessionData.categories = categoryMap;

          await redisClient.setEx(
            redisKey,
            SESSION_TTL,
            JSON.stringify(sessionData)
          );

          replyText = msg;
        }
      } catch (err) {
        console.error("DB ERROR:", err.message);
        replyText =
          "Service temporarily unavailable.\nPlease try again later.";
      }
    }
  }

  /* =====================
     CATEGORY NUMBER (1,2,3...)
  ===================== */
  else if (/^\d+$/.test(lowerText)) {
    if (!existing) {
      replyText = "Session expired. Please type 'Hi' to start again.";
    } else {
      const sessionData = JSON.parse(existing);
      const selected = sessionData.categories?.[lowerText];

      if (!selected) {
        replyText =
          "Invalid selection.\nType 'List' to see categories again.";
      } else {
        await redisClient.expire(redisKey, SESSION_TTL);

        // save selected category
        sessionData.selectedCategory = selected;
        sessionData.lastMessage = lowerText;

        await redisClient.setEx(
          redisKey,
          SESSION_TTL,
          JSON.stringify(sessionData)
        );

        replyText =
          `You selected: ${selected.name}\n` +
          `Category ID: ${selected.id}\n\n` +
          `Next step coming soon...\n` +
          `Type 'Exit' to leave.`;
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
