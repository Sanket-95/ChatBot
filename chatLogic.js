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
  if (["hi", "hello", "hie", "hey"].includes(input)) {
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

    session.categories = {};
    session.subcategories = null;
    session.products = null;
    session.step = "category";

    let msg = "📦 *Categories*\n\n";
    rows.forEach((r, i) => {
      session.categories[i + 1] = {
        id: r.id,
        name: r.category_name,
        parent_id: r.parent_id
      };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType category number.\nType *Exit* to leave.`;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CATEGORY / SUBCATEGORY SELECTION
  ===================== */
  if (
    (session?.step === "category" && session.categories?.[input]) ||
    (session?.step === "subcategory" && session.subcategories?.[input])
  ) {
    const selected =
      session.step === "category"
        ? session.categories[input]
        : session.subcategories[input];

    // Check for subcategories
    const [subRows] = await db.execute(
      `SELECT id, category_name, parent_id FROM category WHERE parent_id = ?`,
      [selected.id]
    );

    if (subRows.length > 0) {
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

      msg += `\nType number.\nType *Back* | *Exit*`;

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    /* =====================
       PRODUCTS (FINAL STAGE)
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

    if (!products.length) {
      msg += "No products available.\n";
    } else {
      products.forEach((p, i) => {
        session.products[i + 1] = {
          id: p.id,
          name: p.productname,
          mrp: p.mrp
        };
        msg += `${i + 1}. ${p.productname} – ₹${p.mrp}\n`;
      });
    }

    msg +=
      `\nCommands:\n` +
      `Add <number> <qty>\n` +
      `Remove <number>\n` +
      `Cart\n` +
      `Bill\n` +
      `Exit`;

    session.cart = session.cart || {};

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CART COMMANDS
  ===================== */
  if (session?.step === "product") {
    // ADD
    if (input.startsWith("add ")) {
      const [, num, qtyRaw] = input.split(" ");
      const qty = parseInt(qtyRaw) || 1;
      const product = session.products?.[num];

      if (!product) {
        return sendWhatsApp(from, "❌ Invalid product number.");
      }

      const pid = product.id;
      if (!session.cart[pid]) {
        session.cart[pid] = {
          name: product.name,
          mrp: product.mrp,
          qty
        };
      } else {
        session.cart[pid].qty += qty;
      }

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `✅ ${product.name} added x${qty}`);
    }

    // REMOVE
    if (input.startsWith("remove ")) {
      const [, num] = input.split(" ");
      const product = session.products?.[num];

      if (!product || !session.cart[product.id]) {
        return sendWhatsApp(from, "❌ Product not in cart.");
      }

      delete session.cart[product.id];
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `🗑️ Removed ${product.name}`);
    }

    // CART VIEW
    if (input === "cart") {
      let msg = "🛒 *Your Cart*\n\n";

      if (!Object.keys(session.cart).length) {
        msg += "Cart is empty.";
      } else {
        Object.values(session.cart).forEach(p => {
          msg += `• ${p.name} x${p.qty}\n`;
        });
      }

      msg += `\nType Add / Remove / Bill / Exit`;
      return sendWhatsApp(from, msg);
    }

    // BILL (NO TOTAL)
    if (input === "bill") {
      if (!Object.keys(session.cart).length) {
        return sendWhatsApp(from, "🧾 Cart is empty.");
      }

      let msg = "🧾 *Final Items*\n\n";
      Object.values(session.cart).forEach(p => {
        msg += `• ${p.name} x${p.qty}\n`;
      });

      msg += "\nThank you 😊";
      return sendWhatsApp(from, msg);
    }
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
