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
    return sendWhatsApp(from, "👋 Session ended.\nType *Hi* to start again.");
  }

  /* =====================
     GREETING
  ===================== */
  if (["hi", "hello", "hie", "hey"].includes(input)) {
    session = {
      agency: process.env.AGENCY,
      mobile: from,
      createdAt: new Date().toISOString(),
      step: "start",
      cart: {},
      path: []
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

    session.categories = {};
    session.subcategories = null;
    session.products = null;
    session.step = "category";
    session.path = [];

    let msg = "📦 *Categories*\n\n";
    rows.forEach((r, i) => {
      session.categories[i + 1] = {
        id: r.id,
        name: r.category_name,
        parent_id: r.parent_id
      };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType number.\nType *Exit*`;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     BACK LOGIC
  ===================== */
  if (input === "back" && session) {
    session.path.pop();

    if (session.step === "product") {
      session.step = "subcategory";
    } else if (session.step === "subcategory") {
      session.step = "category";
    }

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, "⬅️ Back\nType *List* to continue.");
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

    session.path.push(selected.id);

    const [subRows] = await db.execute(
      `SELECT id, category_name, parent_id FROM category WHERE parent_id = ?`,
      [selected.id]
    );

    if (subRows.length) {
      session.subcategories = {};
      session.step = "subcategory";

      let msg = `📂 *${selected.name} – Subcategories*\n\n`;
      subRows.forEach((r, i) => {
        session.subcategories[i + 1] = {
          id: r.id,
          name: r.category_name,
          parent_id: r.parent_id
        };
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += `\nType number\nBack | Exit`;

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    /* =====================
       PRODUCTS
    ===================== */
    const [products] = await db.execute(
      `
      SELECT id, productname, mrp
      FROM product
      WHERE is_enabled = 1
      AND agid = ?
      AND sbid = ?
      `,
      [process.env.AGENCY_ID, selected.id]
    );

    session.products = {};
    session.step = "product";

    let msg = `🛒 *Products – ${selected.name}*\n\n`;
    products.forEach((p, i) => {
      session.products[i + 1] = {
        id: p.id,
        name: p.productname,
        mrp: p.mrp
      };
      msg += `${i + 1}. ${p.productname}\n`;
    });

    msg += `\nCommands:\nAdd <no> <qty>\nCart\nBack | Exit`;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     PRODUCT & CART
  ===================== */
  if (session?.step === "product") {
    if (input.startsWith("add ")) {
      const [, num, qtyRaw] = input.split(" ");
      const qty = parseInt(qtyRaw) || 1;
      const product = session.products[num];

      if (!product) return sendWhatsApp(from, "❌ Invalid product.");

      session.cart[product.id] = session.cart[product.id] || {
        name: product.name,
        qty: 0
      };
      session.cart[product.id].qty += qty;

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `✅ Added ${product.name} x${qty}`);
    }

    if (input === "cart") {
      let msg = "🧺 *Your Cart*\n\n";
      const items = Object.values(session.cart);

      if (!items.length) msg += "Cart is empty.";
      else items.forEach(i => (msg += `• ${i.name} x${i.qty}\n`));

      msg += `\nAdd | Remove <no> | Back | Exit`;
      return sendWhatsApp(from, msg);
    }

    if (input.startsWith("remove ")) {
      const [, num] = input.split(" ");
      const keys = Object.keys(session.cart);
      const pid = keys[num - 1];

      if (!pid) return sendWhatsApp(from, "❌ Invalid item.");

      delete session.cart[pid];
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, "🗑️ Item removed.");
    }
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.\nType *List* or *Exit*.");
}

module.exports = { handleChat };
