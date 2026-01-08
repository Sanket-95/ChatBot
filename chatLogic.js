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
  const inputRaw = text?.trim();
  if (!inputRaw) return;

  const input = inputRaw.toLowerCase();
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
  if (["hi", "hello", "hey"].includes(input)) {
    session = {
      agency: process.env.AGENCY,
      mobile: from,
      createdAt: new Date().toISOString(),
      step: "start",
      cart: {}
    };

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

    return sendWhatsApp(
      from,
      `Welcome to *${process.env.AGENCY}* 👋\n\nType *List* to see categories.\nType *Exit* to leave.`
    );
  }

  /* =====================
     LIST – MAIN CATEGORY
  ===================== */
  if (input === "list") {
    const [rows] = await db.execute(
      `SELECT id, category_name, parent_id
       FROM category
       WHERE parent_id = 0
       AND id IN (
         SELECT DISTINCT(ct_id)
         FROM agency_categories
         WHERE ag_id = ?
       )`,
      [process.env.AGENCY_ID]
    );

    session.categories = {};
    session.subcategories = null;
    session.products = null;
    session.step = "category";

    let msg = "📦 *Categories*\n\n";
    rows.forEach((r, i) => {
      session.categories[i + 1] = r;
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += "\nType category number.\nExit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CATEGORY / SUBCATEGORY
  ===================== */
  if (
    (session?.step === "category" && session.categories?.[input]) ||
    (session?.step === "subcategory" && session.subcategories?.[input])
  ) {
    const selected =
      session.step === "category"
        ? session.categories[input]
        : session.subcategories[input];

    const [subs] = await db.execute(
      "SELECT id, category_name, parent_id FROM category WHERE parent_id = ?",
      [selected.id]
    );

    if (subs.length) {
      session.subcategories = {};
      session.step = "subcategory";

      let msg = `📂 *${selected.category_name} – Subcategories*\n\n`;
      subs.forEach((r, i) => {
        session.subcategories[i + 1] = r;
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += "\nType number.\nBack | Exit";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    /* =====================
       PRODUCTS
    ===================== */
    const [products] = await db.execute(
      `SELECT id, productname, mrp
       FROM product
       WHERE is_enabled = 1
       AND agid = ?
       AND sbid = ?`,
      [process.env.AGENCY_ID, selected.id]
    );

    session.products = {};
    session.step = "product";

    let msg = `🛒 *Products – ${selected.category_name}*\n\n`;
    products.forEach((p, i) => {
      session.products[i + 1] = p;
      msg += `${i + 1}. ${p.productname} – ₹${p.mrp}\n`;
    });

    msg +=
      `\n👉 Reply with *product number* to add item\n\n` +
      `Options:\nCart | Back | List | Exit`;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     PRODUCT NUMBER → ASK QTY
  ===================== */
  if (session?.step === "product" && session.products?.[input]) {
    session.pendingProduct = session.products[input];
    session.step = "qty";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(
      from,
      `How many *${session.pendingProduct.productname}*?\nReply with quantity.\nBack | Exit`
    );
  }

  /* =====================
     QUANTITY INPUT
  ===================== */
  if (session?.step === "qty" && /^\d+$/.test(input)) {
    const qty = parseInt(input);
    const p = session.pendingProduct;

    session.cart[p.id] = session.cart[p.id] || {
      name: p.productname,
      qty: 0
    };
    session.cart[p.id].qty += qty;

    session.pendingProduct = null;
    session.step = "product";

    let msg = `✅ Added *${p.productname}* x${qty}\n\n🛒 *Current Cart*\n`;
    Object.values(session.cart).forEach(i => {
      msg += `• ${i.name} x${i.qty}\n`;
    });

    msg +=
      `\nReply product number to add more\n` +
      `Cart | Back | List | Exit`;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CART VIEW
  ===================== */
  if (input === "cart") {
    let msg = "🛒 *Your Cart*\n\n";

    if (!Object.keys(session.cart).length) {
      msg += "Cart is empty.";
    } else {
      Object.values(session.cart).forEach(p => {
        msg += `• ${p.name} x${p.qty}\n`;
      });
    }

    msg += "\nOptions:\nBack | List | Exit";
    return sendWhatsApp(from, msg);
  }

  /* =====================
     BACK
  ===================== */
  if (input === "back" && session) {
    session.step = "product";
    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, "⬅️ Back\nReply product number.");
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.\nList | Exit");
}

module.exports = { handleChat };
