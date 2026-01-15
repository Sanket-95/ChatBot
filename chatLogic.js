const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL || 1800);

/* =====================
   SEND WHATSAPP
===================== */
async function sendWhatsApp(to, text, buttons = null) {
  console.log(`📤 Sending to ${to}: "${text.substring(0, 50)}..."`);
  if (buttons) console.log(`🔼 Buttons: ${buttons.join(", ")}`);

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: buttons ? "interactive" : "text"
  };

  if (buttons) {
    payload.interactive = {
      type: "button",
      body: {
        text: text
      },
      action: {
        buttons: buttons.map((btn, index) => ({
          type: "reply",
          reply: {
            id: `btn_${index + 1}`,
            title: btn
          }
        }))
      }
    };
  } else {
    payload.text = {
      body: text
    };
  }

  console.log("📤 Sending payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log(`✅ Message sent successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error sending message:`, error.response?.data || error.message);
    throw error;
  }
}

/* =====================
   CHAT HANDLER
===================== */
async function handleChat(from, text, redisClient) {
  console.log(`\n=== HANDLING CHAT ===`);
  console.log(`📞 From: ${from}`);
  console.log(`📝 Input: "${text}"`);
  
  const inputRaw = text?.trim();
  if (!inputRaw) {
    console.log(`❌ No input text`);
    return;
  }

  const input = inputRaw.toLowerCase();
  console.log(`🔍 Processed input: "${input}"`);
  
  const redisKey = `session:${process.env.AGENCY}:${from}`;
  console.log(`🗝️ Redis key: ${redisKey}`);
  
  const existing = await redisClient.get(redisKey);
  let session = existing ? JSON.parse(existing) : null;
  
  console.log(`📊 Session exists: ${!!session}`);
  if (session) {
    console.log(`📋 Session step: ${session.step}`);
    console.log(`🛒 Cart items: ${Object.keys(session.cart || {}).length}`);
  }

  /* =====================
     EXIT
  ===================== */
  if (input === "exit") {
    console.log(`🚪 Exit command detected`);
    await redisClient.del(redisKey);
    return sendWhatsApp(from, "Session ended.\nType *Hi* to start again.");
  }

  /* =====================
     BACK – REVERSE NAVIGATION
  ===================== */
  if (input === "back" && session?.current_parent_id !== undefined) {
    console.log(`🔙 Back command detected, current_parent_id: ${session.current_parent_id}`);
    
    // 1️⃣ Get current category record
    const [[currentCategory]] = await db.execute(
      `SELECT id, parent_id, category_name
       FROM category
       WHERE id = ? AND is_prod_present = 1`,
      [session.current_parent_id]
    );

    if (!currentCategory) {
      console.log(`❌ No current category found`);
      return sendWhatsApp(from, "Type *List* to see categories.");
    }

    console.log(`📂 Current category: ${currentCategory.category_name} (ID: ${currentCategory.id}, Parent: ${currentCategory.parent_id})`);

    // 2️⃣ Fetch list under the parent of current category
    const [rows] = await db.execute(
      `SELECT id, parent_id, category_name
       FROM category
       WHERE parent_id = ? AND is_prod_present = 1`,
      [currentCategory.parent_id]
    );

    console.log(`📋 Found ${rows.length} items in parent category`);

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
      console.log(`📁 Moved to category level`);
    } else {
      session.step = "subcategory";
      session.subcategories = {};
      rows.forEach((r, i) => session.subcategories[i + 1] = r);
      session.categories = session.categories || {};
      console.log(`📁 Moved to subcategory level`);
    }

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));

    // 4️⃣ Prepare label
    const label = currentCategory.parent_id === 0 ? "*Category List*" : "*Sub Category List*";
    console.log(`🏷️ Label: ${label}`);

    // 5️⃣ Send WhatsApp list with buttons
    let msg = `${label}\n\n`;
    rows.forEach((r, i) => {
      msg += `${i + 1}. ${r.category_name}\n`;
    });
    msg += `\nType number to select`;

    console.log(`📤 Sending back navigation response`);
    return sendWhatsApp(from, msg, ["Back", "Exit"]);
  }

  /* =====================
     GREETING
  ===================== */
  if (["hi", "hello", "hey"].includes(input)) {
    console.log(`👋 Greeting detected: "${input}"`);

    const [[customer]] = await db.execute(
      `SELECT id AS customer_id, cust_tier_id
       FROM customers
       WHERE contact_numbers LIKE ?
       LIMIT 1`,
      [`%${from}%`]
    );

    console.log(`👤 Customer found: ${!!customer}, ID: ${customer?.customer_id || 'none'}`);

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
    console.log(`💾 New session created, step: ${session.step}`);

    return sendWhatsApp(
      from,
      `Welcome to *${process.env.AGENCY}* 👋\n\nType *List* to see categories.`,
      ["List", "Exit"]
    );
  }

  /* =====================
     LIST – MAIN CATEGORY
  ===================== */
  if (input === "list") {
    console.log(`📋 List command detected`);

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

    console.log(`📦 Found ${rows.length} categories`);

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

    msg += "\nType category number.";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    console.log(`💾 Session updated, step: ${session.step}`);
    return sendWhatsApp(from, msg, ["Back", "Exit"]);
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

    console.log(`🎯 Selected: ${selected.category_name} (ID: ${selected.id}, Step: ${session.step})`);

    session.current_parent_id = selected.id; // update current_parent_id

    const [subs] = await db.execute(
      `SELECT id, category_name, parent_id
       FROM category
       WHERE parent_id = ? AND is_prod_present = 1`,
      [selected.id]
    );

    console.log(`🔍 Found ${subs.length} subcategories`);

    if (subs.length) {
      session.subcategories = {};
      session.step = "subcategory";

      let msg = `📂 *${selected.category_name} – Subcategories*\n\n`;
      subs.forEach((r, i) => {
        session.subcategories[i + 1] = r;
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += "\nType number.";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      console.log(`💾 Session updated, step: ${session.step}`);
      return sendWhatsApp(from, msg, ["Back", "Exit"]);
    }

    /* =====================
       PRODUCTS
    ===================== */
    console.log(`🛍️ Loading products for category ID: ${selected.id}`);
    
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

    console.log(`📊 Found ${products.length} products`);

    session.products = {};
    session.step = "product";

    let msg = `🛒 *Products – ${selected.category_name}*\n\n`;
    products.forEach((p, i) => {
      session.products[i + 1] = p;
      msg += `${i + 1}. ${p.productname} – ₹${p.mrp}${
        p.scheme_name ? ` 🎁 *${p.scheme_name}*` : ""
      }\n`;
    });

    msg += "\nReply product number to add item";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    console.log(`💾 Session updated, step: ${session.step}, products: ${Object.keys(session.products).length}`);
    return sendWhatsApp(from, msg, ["Cart", "Back", "List", "Exit"]);
  }

  /* =====================
     PRODUCT → QTY
  ===================== */
  if (session?.step === "product" && session.products?.[input]) {
    const product = session.products[input];
    console.log(`🛍️ Product selected: ${product.productname} (Index: ${input})`);
    
    session.pendingProduct = product;
    session.step = "qty";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    console.log(`💾 Session updated, step: ${session.step}, pending product: ${session.pendingProduct.productname}`);
    
    return sendWhatsApp(
      from,
      `How many *${session.pendingProduct.productname}*?\nReply with quantity.`,
      ["Back", "Exit"]
    );
  }

  /* =====================
     QTY INPUT
  ===================== */
  if (session?.step === "qty" && /^\d+$/.test(input)) {
    const qty = parseInt(input);
    const p = session.pendingProduct;
    
    console.log(`🔢 Quantity entered: ${qty} for ${p.productname}`);

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

    msg += "\nReply product number to add more";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    console.log(`💾 Session updated, step: ${session.step}, cart items: ${Object.values(session.cart).length}`);
    return sendWhatsApp(from, msg, ["Cart", "Back", "List", "Exit"]);
  }

  /* =====================
     CART
  ===================== */
  if (input === "cart") {
    console.log(`🛒 Cart command detected`);
    
    let msg = "🛒 *Your Cart*\n\n";

    if (!Object.keys(session.cart).length) {
      msg += "Cart is empty.";
      console.log(`🛒 Cart is empty`);
    } else {
      Object.values(session.cart).forEach(p => {
        msg += `• ${p.name} x${p.qty}\n`;
      });
      console.log(`🛒 Cart has ${Object.values(session.cart).length} items`);
    }

    msg += "\nType *Order* to place order";
    return sendWhatsApp(from, msg, ["Order", "Back", "List", "Exit"]);
  }

  /* =====================
     ORDER
  ===================== */
  if (input === "order") {
    console.log(`📦 Order command detected`);
    
    if (!Object.keys(session.cart).length) {
      console.log(`❌ Cannot order: cart is empty`);
      return sendWhatsApp(from, "🛒 Cart is empty.");
    }

    let msg = "🧾 *Final Order*\n\n";
    Object.values(session.cart).forEach(p => {
      msg += `• ${p.name} x${p.qty}\n`;
    });

    msg += "\nConfirm order?";
    session.step = "confirm_order";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    console.log(`💾 Session updated, step: ${session.step}, confirming order`);
    return sendWhatsApp(from, msg, ["Yes", "No"]);
  }

  /* =====================
     CONFIRM ORDER
  ===================== */
  if (session?.step === "confirm_order") {
    console.log(`✅ Confirm order response: "${input}"`);
    
    if (input === "yes") {
      console.log(`🔄 Processing order...`);
      
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

        console.log(`✅ Order placed successfully: ${orderNumber}`);
        return sendWhatsApp(
          from,
          `✅ *Order Placed Successfully!*\n\n🧾 Order No: *${orderNumber}*`
        );
      } catch (err) {
        await conn.rollback();
        console.error(`❌ Order failed:`, err);
        return sendWhatsApp(from, "❌ Order failed. Please try again.");
      } finally {
        conn.release();
      }
    }

    if (input === "no") {
      console.log(`❌ Order cancelled by user`);
      session.step = "product";
      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, "❌ Order cancelled.\nBack to products.", ["Back", "List", "Exit"]);
    }
  }

  /* =====================
     FALLBACK
  ===================== */
  console.log(`🤷 No matching command for: "${input}", step: ${session?.step || 'no session'}`);
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.", ["List", "Exit"]);
}

module.exports = { handleChat };