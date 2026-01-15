const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL || 1800);

/* =====================
   SEND WHATSAPP TEXT
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
   SEND WHATSAPP INTERACTIVE BUTTONS
===================== */
async function sendWhatsAppButtons(to, text, buttons) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: text
        },
        action: {
          buttons: buttons.map((btn, index) => ({
            type: "reply",
            reply: {
              id: `btn_${index + 1}`,
              title: btn.title
            }
          }))
        }
      }
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
     BACK – REVERSE NAVIGATION
  ===================== */
  if (input === "back" && session?.current_parent_id !== undefined) {
    // 1️⃣ Get current category record
    const [[currentCategory]] = await db.execute(
      `SELECT id, parent_id, category_name
       FROM category
       WHERE id = ? AND is_prod_present = 1`,
      [session.current_parent_id]
    );

    if (!currentCategory) {
      return sendWhatsApp(from, "Type *List* to see categories.");
    }

    // 2️⃣ Fetch list under the parent of current category
    const [rows] = await db.execute(
      `SELECT id, parent_id, category_name
       FROM category
       WHERE parent_id = ? AND is_prod_present = 1`,
      [currentCategory.parent_id]
    );

    if (!rows.length) {
      return sendWhatsApp(from, "No previous category available.");
    }

    // 3️⃣ Update session
    session.current_parent_id = currentCategory.parent_id; // move one level up
    session.products = null;

    if (currentCategory.parent_id === 0) {
      session.step = "category";
      session.categories = {};
      rows.forEach((r, i) => session.categories[i + 1] = r);
      session.subcategories = null;
    } else {
      session.step = "subcategory";
      session.subcategories = {};
      rows.forEach((r, i) => session.subcategories[i + 1] = r);
      session.categories = session.categories || {};
    }

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

    // 4️⃣ Prepare label
    const label = currentCategory.parent_id === 0 ? "*Category List*" : "*Sub Category List*";

    // 5️⃣ Send WhatsApp list
    let msg = `${label}\n\n`;
    rows.forEach((r, i) => {
      msg += `${i + 1}. ${r.category_name}\n`;
    });
    msg += `\nType number to select\nType *back* to go previous`;

    return sendWhatsApp(from, msg);
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
      createdAt: new Date().toISOString(),
      step: "start",
      cart: {},
      current_parent_id: 0 // initialize for back navigation
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
    session.current_parent_id = 0;

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

    session.current_parent_id = selected.id; // update current_parent_id

    const [subs] = await db.execute(
      `SELECT id, category_name, parent_id
       FROM category
       WHERE parent_id = ? AND is_prod_present = 1`,
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
      `SELECT 
          p.id,
          p.productname,
          p.mrp,
          s.name AS scheme_name
       FROM product p
       LEFT JOIN current_pricing_scheme_map cpsm
              ON cpsm.prod_id = p.id
             AND cpsm.tier_id = ?
             AND (
                  (cpsm.start_date IS NULL AND cpsm.end_date IS NULL)
               OR (CURRENT_DATE BETWEEN cpsm.start_date AND cpsm.end_date)
                 )
       LEFT JOIN scheme s
              ON s.id = cpsm.scheme_id
             AND s.is_enable = 1
       WHERE p.is_enabled = 1
         AND p.agid = ?
         AND p.sbid = ?`,
      [
        session.customer_id > 0 ? session.cust_tier_id : -1,
        process.env.AGENCY_ID,
        selected.id
      ]
    );

    session.products = {};
    session.step = "product";

    let msg = `🛒 *Products – ${selected.category_name}*\n\n`;
    products.forEach((p, i) => {
      session.products[i + 1] = p;
      msg += `${i + 1}. ${p.productname} – ₹${p.mrp}${
        p.scheme_name ? ` 🎁 *${p.scheme_name}*` : ""
      }\n`;
    });

    msg += "\nReply product number to add item\nCart | Back | List | Exit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     PRODUCT → QTY
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
     QTY INPUT
  ===================== */
  if (session?.step === "qty" && /^\d+$/.test(input)) {
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

    let msg = `✅ Added *${p.productname}* x${qty}\n\n🛒 *Current Cart*\n`;
    Object.values(session.cart).forEach(i => {
      msg += `• ${i.name} x${i.qty}\n`;
    });

    msg += "\nReply product number to add more\nCart | Back | List | Exit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     CART
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

    msg += "\nType *Order* to place order\nBack | List | Exit";
    return sendWhatsApp(from, msg);
  }

  /* =====================
     ORDER
  ===================== */
  if (input === "order") {
    if (!Object.keys(session.cart).length) {
      return sendWhatsApp(from, "🛒 Cart is empty.");
    }

    let msg = "🧾 *Final Order*\n\n";
    Object.values(session.cart).forEach(p => {
      msg += `• ${p.name} x${p.qty}\n`;
    });

    msg += "\nConfirm order? (Yes / No)";
    session.step = "confirm_order";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    
    // Send interactive buttons for confirmation
    return sendWhatsAppButtons(
      from,
      msg,
      [
        { title: "✅ Yes" },
        { title: "❌ No" }
      ]
    );
  }

  /* =====================
     CONFIRM ORDER (HANDLES BOTH BUTTONS AND MANUAL TYPING)
  ===================== */
  if (session?.step === "confirm_order") {
    // Handle button responses (they come as button IDs)
    const isYesButton = input === "btn_1" || input === "yes";
    const isNoButton = input === "btn_2" || input === "no";
    
    if (isYesButton) {
      const orderNumber = process.env.AGENCY_ID + "_" + Date.now();
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

        const [[orderRow]] = await conn.execute(
          `SELECT id FROM order_master
           WHERE order_number = ?
           AND agency_id = ?
           AND mob_number = ?
           LIMIT 1`,
          [orderNumber, process.env.AGENCY_ID, session.mobile]
        );

        for (const p of Object.values(session.cart)) {
          await conn.execute(
            `INSERT INTO order_slave (order_id, prod_id, quantity)
             VALUES (?, ?, ?)`,
            [orderRow.id, p.id, p.qty]
          );
        }

        await conn.commit();
        await redisClient.del(redisKey);

        return sendWhatsApp(
          from,
          `✅ *Order Placed Successfully!*\n\n🧾 Order No: *${orderNumber}*`
        );
      } catch (err) {
        await conn.rollback();
        console.error(err);
        return sendWhatsApp(from, "❌ Order failed. Please try again.");
      } finally {
        conn.release();
      }
    }

    if (isNoButton) {
      session.step = "product";
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, "❌ Order cancelled.\nBack to products.");
    }
  }

  /* =====================
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.\nList | Exit");
}

module.exports = { handleChat };