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
    return sendWhatsApp(from, "✅ Session ended.\nType *Hi* to start again.");
  }

  /* =====================
     GREETING
  ===================== */
  if (["hi", "hello", "hie", "hey"].includes(input)) {
    if (!session) {
      session = {
        agency: process.env.AGENCY,
        mobile: from,
        createdAt: new Date().toISOString()
      };
    }

    session.step = "start";
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
      return sendWhatsApp(from, "⚠️ Session expired.\nType *Hi* to start again.");
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

    if (!rows.length) return sendWhatsApp(from, "No categories available.");

    const categories = {};
    let msg = "📦 *Categories*\n\n";

    rows.forEach((r, i) => {
      categories[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
      msg += `${i + 1}. ${r.category_name}\n`;
    });

    msg += `\nType category number.\nType *Exit* to leave.`;

    session.step = "category";
    session.categories = categories;
    session.selectedCategory = null;
    session.subcategories = null;
    session.selectedSubcategory = null;
    session.products = null;

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CATEGORY SELECTION
  ===================== */
  if (session?.step === "category" && session.categories?.[input]) {
    const selected = session.categories[input];
    session.selectedCategory = selected;

    const [subRows] = await db.execute(
      `SELECT id, category_name, parent_id FROM category WHERE parent_id = ?`,
      [selected.id]
    );

    // If subcategories exist
    if (subRows.length > 0) {
      const subs = {};
      let msg = `📂 *${selected.name} – Subcategories*\n\n`;
      subRows.forEach((r, i) => {
        subs[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
        msg += `${i + 1}. ${r.category_name}\n`;
      });
      msg += `\nType number.\nType *Exit* to leave.`;

      session.subcategories = subs;
      session.step = "subcategory";
      session.selectedSubcategory = null;
      session.products = null;

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    // No subcategories → show products
    const [products] = await db.execute(
      `SELECT productname, mrp FROM product WHERE is_enabled = 1 AND agid = ? AND sbid = ?`,
      [process.env.AGENCY_ID, selected.id]
    );

    const productObj = {};
    products.forEach((p, i) => {
      productObj[i + 1] = { name: p.productname, mrp: p.mrp };
    });

    let msg = `🛒 *Products – ${selected.name}*\n\n`;
    if (!products.length) msg += "No products available.\n";
    else products.forEach(p => msg += `• ${p.productname} – ₹${p.mrp}\n`);

    msg += `\nType *Add <num> <qty>* to add to cart.\nType *Remove <num>* to remove.\nType *Cart* to view.\nType *Exit* to leave.`;

    session.step = "product";
    session.products = productObj;
    session.selectedProductParent = selected;
    session.cart = session.cart || {};

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     SUBCATEGORY SELECTION
  ===================== */
  if (session?.step === "subcategory" && session.subcategories?.[input]) {
    const selectedSub = session.subcategories[input];
    session.selectedSubcategory = selectedSub;

    const [subSubRows] = await db.execute(
      `SELECT id, category_name, parent_id FROM category WHERE parent_id = ?`,
      [selectedSub.id]
    );

    // Sub-subcategories exist
    if (subSubRows.length > 0) {
      const subs = {};
      let msg = `📂 *${selectedSub.name} – Subcategories*\n\n`;
      subSubRows.forEach((r, i) => {
        subs[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
        msg += `${i + 1}. ${r.category_name}\n`;
      });
      msg += `\nType number.\nType *Exit* to leave.`;

      session.subcategories = subs;
      session.selectedSubcategory = null;
      session.products = null;
      session.step = "subcategory";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    // No further subcategories → show products
    const [products] = await db.execute(
      `SELECT productname, mrp FROM product WHERE is_enabled = 1 AND agid = ? AND sbid = ?`,
      [process.env.AGENCY_ID, selectedSub.id]
    );

    const productObj = {};
    products.forEach((p, i) => {
      productObj[i + 1] = { name: p.productname, mrp: p.mrp };
    });

    let msg = `🛒 *Products – ${selectedSub.name}*\n\n`;
    if (!products.length) msg += "No products available.\n";
    else products.forEach(p => msg += `• ${p.productname} – ₹${p.mrp}\n`);

    msg += `\nType *Add <num> <qty>* to add to cart.\nType *Remove <num>* to remove.\nType *Cart* to view.\nType *Exit* to leave.`;

    session.step = "product";
    session.products = productObj;
    session.selectedProductParent = selectedSub;
    session.cart = session.cart || {};

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CART LOGIC
  ===================== */
  if (session?.step === "product") {
    // Show cart
    if (input === "cart") {
      if (!session.cart || Object.keys(session.cart).length === 0) {
        return sendWhatsApp(from, "🛒 Cart is empty.\nType *Add <num> <qty>* to add products.");
      }
      let msg = "🛒 *Your Cart*\n\n";
      Object.keys(session.cart).forEach(key => {
        const p = session.cart[key];
        msg += `${key}. ${p.name} – Qty: ${p.qty}\n`;
      });
      msg += `\nType *Add <num> <qty>*, *Remove <num>* or *Exit* to leave.`;
      return sendWhatsApp(from, msg);
    }

    // Add to cart
    if (input.startsWith("add ")) {
      const parts = input.split(" ");
      const num = parts[1];
      const qty = Number(parts[2] || 1);

      if (!session.products?.[num]) {
        return sendWhatsApp(from, "Invalid product number.");
      }

      session.cart[num] = session.cart[num] || { ...session.products[num], qty: 0 };
      session.cart[num].qty += qty;

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `✅ Added ${qty} x ${session.products[num].name} to cart.`);
    }

    // Remove from cart
    if (input.startsWith("remove ")) {
      const parts = input.split(" ");
      const num = parts[1];
      if (!session.cart?.[num]) return sendWhatsApp(from, "Product not in cart.");

      delete session.cart[num];
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `❌ Removed product ${num} from cart.`);
    }
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(
    from,
    "⚠️ Invalid input.\nType *List* to see categories.\nType *Exit* to leave."
  );
}

module.exports = { handleChat };
