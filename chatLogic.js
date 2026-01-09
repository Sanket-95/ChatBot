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
    const [[customer]] = await db.execute(
      `SELECT id AS customer_id, cust_tier_id
       FROM customers
       WHERE contact_numbers LIKE ?
       LIMIT 1`,
      [`%${from}%`]
    );

    session = {
      agency: process.env.AGENCY,
      mobile: from,
      customer_id: customer ? customer.customer_id : 0,
      cust_tier_id: customer ? customer.cust_tier_id : null,
      step: "start",
      cart: {},
      createdAt: new Date().toISOString()
    };

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

    return sendWhatsApp(
      from,
      `Welcome to *${process.env.AGENCY}* 👋\n\nType *List* to see categories.\nType *Exit* to leave.`
    );
  }

  if (!session) {
    return sendWhatsApp(from, "Type *Hi* to start.");
  }

  session.cart = session.cart || {};

  /* =====================
     LIST CATEGORIES
  ===================== */
  if (input === "list") {
    const [rows] = await db.execute(
      `SELECT id, category_name
       FROM category
       WHERE parent_id = 0
       AND is_prod_present = 1
       AND id IN (
         SELECT DISTINCT ct_id
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

    msg += "\nReply with number.\nExit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CATEGORY / SUBCATEGORY
  ===================== */
  if (
    (session.step === "category" && session.categories?.[input]) ||
    (session.step === "subcategory" && session.subcategories?.[input])
  ) {
    const selected =
      session.step === "category"
        ? session.categories[input]
        : session.subcategories[input];

    const [subs] = await db.execute(
      `SELECT id, category_name
       FROM category
       WHERE parent_id = ?
       AND is_prod_present = 1`,
      [selected.id]
    );

    if (subs.length) {
      session.subcategories = {};
      session.step = "subcategory";

      let msg = `📂 *${selected.category_name}*\n\n`;
      subs.forEach((r, i) => {
        session.subcategories[i + 1] = r;
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += "\nReply number.\nBack | Exit";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

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

    let msg = `🛒 *Products*\n\n`;
    products.forEach((p, i) => {
      session.products[i + 1] = p;
      msg += `${i + 1}. ${p.productname} – ₹${p.mrp}\n`;
    });

    msg += "\nReply product number\nCart | List | Exit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     PRODUCT → QTY
  ===================== */
  if (session.step === "product" && session.products?.[input]) {
    session.pendingProduct = session.products[input];
    session.step = "qty";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, `Quantity for *${session.pendingProduct.productname}*?`);
  }

  /* =====================
     ADD TO CART
  ===================== */
  if (session.step === "qty" && /^\d+$/.test(input)) {
    const qty = parseInt(input);
    const p = session.pendingProduct;

    session.cart[p.id] = session.cart[p.id] || {
      id: p.id,
      name: p.productname,
      qty: 0
    };

    session.cart[p.id].qty += qty;
    session.pendingProduct = null;
    session.step = "product";

    let msg = `✅ Added *${p.productname}* x${qty}\n\n🛒 Cart:\n`;
    Object.values(session.cart).forEach(i => {
      msg += `• ${i.name} x${i.qty}\n`;
    });

    msg += "\nReply product number\nCart | Order | Exit";

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

    msg += "\nOrder | List | Exit";
    return sendWhatsApp(from, msg);
  }

  /* =====================
     ORDER
  ===================== */
  if (input === "order") {
    if (!Object.keys(session.cart).length) {
      return sendWhatsApp(from, "🛒 Cart is empty.");
    }

    let msg = "🧾 *Confirm Order*\n\n";
    Object.values(session.cart).forEach(p => {
      msg += `• ${p.name} x${p.qty}\n`;
    });

    msg += "\nConfirm? (Yes / No)";
    session.step = "confirm_order";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CONFIRM ORDER
  ===================== */
  if (session.step === "confirm_order") {
    if (input === "yes") {
      const orderNumber = `${process.env.AGENCY_ID}_${Date.now()}`;
      const conn = await db.getConnection();

      try {
        await conn.beginTransaction();

        await conn.execute(
          `INSERT INTO order_master
           (order_number, status, agency_id, customer_id, created_at, mob_number, is_sms)
           VALUES (?, 'pending', ?, ?, NOW(), ?, 0)`,
          [
            orderNumber,
            process.env.AGENCY_ID,
            session.customer_id || 0,
            session.mobile
          ]
        );

        const [[order]] = await conn.execute(
          `SELECT id FROM order_master WHERE order_number = ? LIMIT 1`,
          [orderNumber]
        );

        for (const p of Object.values(session.cart)) {
          await conn.execute(
            `INSERT INTO order_slave (order_id, prod_id, quantity)
             VALUES (?, ?, ?)`,
            [order.id, p.id, p.qty]
          );
        }

        await conn.commit();
        await redisClient.del(redisKey);

        return sendWhatsApp(from, `✅ Order placed!\n🧾 Order No: *${orderNumber}*`);

      } catch (e) {
        await conn.rollback();
        console.error(e);
        return sendWhatsApp(from, "❌ Order failed. Try again.");
      } finally {
        conn.release();
      }
    }

    if (input === "no") {
      session.step = "product";
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, "Order cancelled.");
    }
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.\nList | Exit");
}

module.exports = { handleChat };
