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
  ====================== */
  if (input === "exit") {
    await redisClient.del(redisKey);
    return sendWhatsApp(from, "Session ended.\nType *Hi* to start again.");
  }

  /* =====================
     GREETINGS
  ====================== */
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
    session.step = "start";
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
  ====================== */
  if (input === "list") {
    if (!session) {
      return sendWhatsApp(from, "Session expired.\nType *Hi* to start again.");
    }

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
     BACK
  ====================== */
  if (input === "back" && session) {
    if (session.step === "subcategory") {
      // Go to parent category
      const parent = session.selectedCategory;
      if (parent?.parent_id === 0) {
        session.step = "category";
        session.subcategories = null;
        session.selectedSubcategory = null;
        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(from, "📦 Categories\nType number to continue.");
      } else {
        // Fetch parent category info from DB
        const [parentRows] = await db.execute(
          "SELECT id, category_name, parent_id FROM category WHERE id = ?",
          [parent.id]
        );
        if (parentRows.length > 0) {
          const parentCat = parentRows[0];
          session.subcategories = {};
          session.step = "subcategory";
          await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

          let msg = `📂 ${parentCat.category_name} – Subcategories\n\n`;
          session.subcategories = {};
          const [subs] = await db.execute(
            "SELECT id, category_name, parent_id FROM category WHERE parent_id = ?",
            [parentCat.id]
          );
          subs.forEach((r, i) => {
            session.subcategories[i + 1] = { id: r.id, name: r.category_name, parent_id: r.parent_id };
            msg += `${i + 1}. ${r.category_name}\n`;
          });
          msg += `\nType number.\nType *Exit* to leave.`;
          await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
          return sendWhatsApp(from, msg);
        }
      }
    } else if (session.step === "product") {
      // Back to subcategory
      if (session.selectedSubcategory) {
        session.step = "subcategory";
        session.products = null;
        session.selectedProductParent = null;
        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(from, "⬅️ Back to Subcategories.\nType number to continue.");
      } else if (session.selectedCategory) {
        session.step = "category";
        session.subcategories = null;
        session.products = null;
        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(from, "⬅️ Back to Categories.\nType number to continue.");
      }
    }
  }

  /* =====================
     CATEGORY / SUBCATEGORY → PRODUCTS
  ====================== */
  if ((session?.step === "category" && session.categories?.[input]) ||
      (session?.step === "subcategory" && session.subcategories?.[input])) {

    let selected;
    if (session.step === "category") selected = session.categories[input];
    else selected = session.subcategories[input];

    if (session.step === "category") session.selectedCategory = selected;
    else session.selectedSubcategory = selected;

    // Fetch subcategories
    const [subRows] = await db.execute(
      "SELECT id, category_name, parent_id FROM category WHERE parent_id = ?",
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
      session.products = null;
      session.step = "subcategory";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    // No subcategories → show products
    const [products] = await db.execute(
      "SELECT productname, mrp FROM product WHERE is_enabled = 1 AND agid = ? AND sbid = ?",
      [process.env.AGENCY_ID, selected.id]
    );

    const productObj = {};
    products.forEach((p, i) => {
      productObj[i + 1] = { name: p.productname, mrp: p.mrp };
    });

    let msg = `🛒 *Products – ${selected.name}*\n\n`;
    if (!products.length) msg += "No products available.\n";
    else products.forEach(p => msg += `• ${p.productname} – ₹${p.mrp}\n`);

    msg += `\nType *Add <num> <qty>* to add to cart.` +
           `\nType *Remove <num>* to remove.` +
           `\nType *Cart* to view your cart.` +
           `\nType *Exit* to leave.`;

    session.products = productObj;
    session.selectedProductParent = selected;
    session.cart = session.cart || {};
    session.step = "product";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     ADD / REMOVE / CART
  ====================== */
  if (session?.step === "product" && session.products) {
    // Add: Add <num> <qty>
    if (input.startsWith("add ")) {
      const parts = input.split(" ");
      const num = parts[1];
      const qty = parseInt(parts[2]) || 1;
      if (!session.products[num]) {
        return sendWhatsApp(from, "Invalid product number.");
      }
      session.cart[num] = session.cart[num] ? session.cart[num] + qty : qty;
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `${session.products[num].name} added x${qty}.\nType *Cart* to view cart.`);
    }

    // Remove: Remove <num>
    if (input.startsWith("remove ")) {
      const parts = input.split(" ");
      const num = parts[1];
      if (!session.cart[num]) {
        return sendWhatsApp(from, "Product not in cart.");
      }
      delete session.cart[num];
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, `Removed ${session.products[num].name} from cart.`);
    }

    // View Cart
    if (input === "cart") {
      let msg = "🛒 *Your Cart*\n\n";
      if (!Object.keys(session.cart).length) msg += "Cart is empty.\n";
      else {
        for (const num in session.cart) {
          const p = session.products[num];
          msg += `• ${p.name} x${session.cart[num]}\n`;
        }
      }
      msg += "\nType *Add <num> <qty>*, *Remove <num>*, or *Exit*.";
      return sendWhatsApp(from, msg);
    }
  }

  /* =====================
     FALLBACK
  ====================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(
    from,
    "Invalid option.\nType *List* to see categories.\nType *Exit* to leave."
  );
}

module.exports = { handleChat };
