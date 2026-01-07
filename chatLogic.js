const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL || 1800);

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
    if (!session) {
      session = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString(),
        step: "start"
      };
    }

    session.lastMessage = input;
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

    if (!rows.length) {
      return sendWhatsApp(from, "No categories available.");
    }

    const categories = {};
    let msg = "📦 *Categories*\n\n";

    rows.forEach((r, i) => {
      categories[i + 1] = { id: r.id, name: r.category_name };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType category number.\nType *Exit* to leave.`;

    session.step = "category";
    session.categories = categories;
    delete session.subcategories;
    delete session.selectedCategory;
    delete session.selectedSubcategory;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     BACK
  ===================== */
  if (input === "back" && session) {
    if (session.step === "subcategory") {
      session.step = "category";
      delete session.subcategories;
      delete session.selectedCategory;
    } else if (session.step === "product") {
      session.step = "subcategory";
      delete session.selectedSubcategory;
    }

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, "⬅️ Went back.\nType number to continue.");
  }

  /* =====================
     CATEGORY SELECTION
  ===================== */
  if (session?.step === "category" && session.categories?.[input]) {
    const selected = session.categories[input];
    session.selectedCategory = selected;

    const [rows] = await db.execute(
      `SELECT id, category_name FROM category WHERE parent_id = ?`,
      [selected.id]
    );

    // No subcategories → show products
    if (!rows.length) {
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

      products.forEach(p => {
        msg += `• ${p.productname} – ₹${p.mrp}\n`;
      });

      msg += `\nType *Back* or *Exit*`;

      session.step = "product";
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    // Subcategories exist
    const subs = {};
    let msg = `📂 *${selected.name} – Subcategories*\n\n`;

    rows.forEach((r, i) => {
      subs[i + 1] = { id: r.id, name: r.category_name };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType number.\nType *Back* | *Exit*`;

    session.subcategories = subs;
    session.step = "subcategory";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     SUBCATEGORY SELECTION
  ===================== */
  if (session?.step === "subcategory" && session.subcategories?.[input]) {
    const selectedSub = session.subcategories[input];
    session.selectedSubcategory = selectedSub;

    const [products] = await db.execute(
      `
      SELECT productname, mrp
      FROM product
      WHERE is_enabled = 1
      AND agid = ?
      AND sbid = ?
      `,
      [process.env.AGENCY_ID, selectedSub.id]
    );

    let msg = `🛒 *Products – ${selectedSub.name}*\n\n`;

    products.forEach(p => {
      msg += `• ${p.productname} – ₹${p.mrp}\n`;
    });

    msg += `\nType *Back* or *Exit*`;

    session.step = "product";
    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(
    from,
    "Invalid option.\nType *List* to see categories.\nType *Exit* to leave."
  );
}

module.exports = { handleChat };
