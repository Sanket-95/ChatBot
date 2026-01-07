const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL || 1800);

/* =====================
   SEND WHATSAPP
===================== */
async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* =====================
   CHAT HANDLER
===================== */
async function handleChat(from, text, redisClient) {
  const input = text?.trim().toLowerCase();
  if (!input) return;

  const redisKey = `session:${process.env.AGENCY}:${from}`;
  const existing = await redisClient.get(redisKey);
  let session = existing ? JSON.parse(existing) : null;

  /* =====================
     EXIT
  ===================== */
  if (input === "exit") {
    await redisClient.del(redisKey);
    return sendWhatsApp(from, "Session ended.\nType *Hi* to start again.");
  }

  /* =====================
     GREETING
  ===================== */
  if (["hi", "hello", "hie", "hey"].includes(input)) {
    session = {
      agency: process.env.AGENCY,
      mobile: from,
      createdAt: new Date().toISOString(),
      path: [], // keep track of hierarchy
      step: "start"
    };

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

    return sendWhatsApp(
      from,
      `Welcome to *${process.env.AGENCY}* 👋\n\n` +
      `Type *List* to see categories.\n` +
      `Type *Exit* to leave.`
    );
  }

  /* =====================
     LIST – MAIN CATEGORY
  ===================== */
  if (input === "list") {
    if (!session) {
      return sendWhatsApp(from, "Session expired.\nType *Hi* to start again.");
    }

    const [rows] = await db.execute(
      `
      SELECT id, category_name, parent_id
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

    if (!rows.length) {
      return sendWhatsApp(from, "No categories available.");
    }

    const categories = {};
    let msg = "📦 *Categories*\n\n";

    rows.forEach((r, i) => {
      categories[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType category number.\nType *Exit* to leave.`;

    session.step = "category";
    session.categories = categories;
    session.subcategories = null;
    session.path = [];
    session.selectedId = null;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     BACK
  ===================== */
  if (input === "back" && session) {
    if (session.path.length > 0) {
      session.path.pop(); // go back one level
      session.selectedId = session.path[session.path.length - 1] || null;
    }

    session.step = session.path.length === 0 ? "category" : "subcategory";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, "⬅️ Back.\nType number to continue.");
  }

  /* =====================
     SELECTION (CATEGORY OR SUBCATEGORY)
  ===================== */
  let currentLevel = session.step === "category" ? session.categories : session.subcategories;

  if (currentLevel?.[input]) {
    const selected = currentLevel[input];
    session.selectedId = selected.id;
    session.path.push(selected.id);

    // Check for subcategories
    const [subRows] = await db.execute(
      `SELECT id, category_name, parent_id FROM category WHERE parent_id = ?`,
      [selected.id]
    );

    if (subRows.length > 0) {
      const subs = {};
      let msg = `📂 *${selected.name} – Subcategories*\n\n`;
      subRows.forEach((r, i) => {
        subs[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += `\nType number.\nType *Back* | *Exit*`;

      session.subcategories = subs;
      session.step = "subcategory";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    // No subcategories → show products
    const [products] = await db.execute(
      `
      SELECT productname, mrp
      FROM product
      WHERE is_enabled = 1
      AND agid = ?
      AND sbid = ?
      `,
      [process.env.AGENCY_ID, selected.id]
    );

    let msg = `🛒 *Products – ${selected.name}*\n\n`;
    if (!products.length) msg += "No products available.\n";
    else products.forEach(p => {
      msg += `• ${p.productname} – ₹${p.mrp}\n`;
    });
    msg += `\nType *Back* | *Exit*`;

    session.step = "product";
    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     FALLBACK
  ===================== */
  return sendWhatsApp(
    from,
    "Invalid option.\nType *List* to see categories.\nType *Exit* to leave."
  );
}

module.exports = { handleChat };
