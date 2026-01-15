const axios = require("axios");
const db = require("./db");

const SESSION_TTL = Number(process.env.SESSION_TTL || 1800);

/* =====================
   SEND WHATSAPP
===================== */
async function sendWhatsApp(to, text, buttons = null) {
  console.log(`📤 Sending to ${to}: "${text.substring(0, 50)}..."`);
  if (buttons) console.log(`🔼 Buttons: ${buttons.join(", ")}`);

  // WhatsApp only allows 1-3 buttons
  if (buttons && buttons.length > 3) {
    console.log(`⚠️ Too many buttons (${buttons.length}), limiting to 3`);
    buttons = buttons.slice(0, 3);
  }

  const payload = {
    messaging_product: "whatsapp",
    to: to,
  };

  if (buttons && buttons.length > 0) {
    payload.type = "interactive";
    payload.interactive = {
      type: "button",
      body: { text: text },
      action: {
        buttons: buttons.map((btn, index) => ({
          type: "reply",
          reply: {
            id: `btn_${index + 1}`,
            title: btn,
          },
        })),
      },
    };
  } else {
    payload.type = "text";
    payload.text = { body: text };
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`✅ Message sent successfully to ${to}`);
  } catch (error) {
    console.error(`❌ Error sending message:`, error.response?.data || error.message);
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
     GREETING - MUST BE CHECKED BEFORE OTHER COMMANDS
  ===================== */
  if (["hi", "hello", "hey", "hie"].includes(input)) {
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
      current_parent_id: 0
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
     BACK – REVERSE NAVIGATION
  ===================== */
  if (input === "back") {
    console.log(`🔙 Back command detected`);
    
    // If no session, start fresh
    if (!session) {
      console.log(`❌ No session, cannot go back`);
      return sendWhatsApp(from, "Type *Hi* to start.", ["List", "Exit"]);
    }

    // If at start step, show greeting again
    if (session.step === "start") {
      console.log(`🏁 At start, showing greeting again`);
      return sendWhatsApp(
        from,
        `Welcome to *${process.env.AGENCY}* 👋\n\nType *List* to see categories.`,
        ["List", "Exit"]
      );
    }

    // Handle back based on current step
    switch(session.step) {
      case "category":
        // Already at category list, show greeting
        session.step = "start";
        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(
          from,
          `Welcome to *${process.env.AGENCY}* 👋\n\nType *List* to see categories.`,
          ["List", "Exit"]
        );
        
      case "subcategory":
        // Go back to category list
        console.log(`📁 Going back from subcategory to category list`);
        
        const [categories] = await db.execute(
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

        if (!categories.length) {
          return sendWhatsApp(from, "No categories available.");
        }

        session.step = "category";
        session.categories = {};
        session.subcategories = null;
        session.products = null;
        session.current_parent_id = 0;

        categories.forEach((r, i) => {
          session.categories[i + 1] = r;
        });

        let categoryMsg = "📦 *Categories*\n\n";
        categories.forEach((r, i) => {
          categoryMsg += `${i + 1}. ${r.category_name}\n`;
        });
        categoryMsg += "\nType category number.";

        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(from, categoryMsg, ["Back", "Exit"]);
        
      case "product":
        // Go back to subcategory/category list
        console.log(`📁 Going back from product list`);
        
        if (session.current_parent_id === 0) {
          // If at top level, go to category list
          const [categories] = await db.execute(
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

          session.step = "category";
          session.categories = {};
          categories.forEach((r, i) => {
            session.categories[i + 1] = r;
          });
          session.subcategories = null;
          session.products = null;

          let catMsg = "📦 *Categories*\n\n";
          categories.forEach((r, i) => {
            catMsg += `${i + 1}. ${r.category_name}\n`;
          });
          catMsg += "\nType category number.";

          await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
          return sendWhatsApp(from, catMsg, ["Back", "Exit"]);
        } else {
          // Go to subcategory list
          // First, get the parent of the current category
          const [[currentCategory]] = await db.execute(
            `SELECT parent_id FROM category WHERE id = ?`,
            [session.current_parent_id]
          );

          if (!currentCategory) {
            return sendWhatsApp(from, "Cannot go back.");
          }

          const [subs] = await db.execute(
            `SELECT id, category_name, parent_id
             FROM category
             WHERE parent_id = ? AND is_prod_present = 1`,
            [currentCategory.parent_id]
          );

          if (!subs.length) {
            return sendWhatsApp(from, "No previous list available.");
          }

          session.step = "subcategory";
          session.subcategories = {};
          subs.forEach((r, i) => {
            session.subcategories[i + 1] = r;
          });
          session.products = null;
          session.current_parent_id = currentCategory.parent_id;

          let subMsg = `📂 Subcategories\n\n`;
          subs.forEach((r, i) => {
            subMsg += `${i + 1}. ${r.category_name}\n`;
          });
          subMsg += "\nType number to select";

          await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
          return sendWhatsApp(from, subMsg, ["Back", "Exit"]);
        }
        
      case "qty":
        // Go back to product list
        console.log(`📁 Going back from quantity to product list`);
        session.step = "product";
        session.pendingProduct = null;
        
        // Re-send product list if products exist
        if (session.products && Object.keys(session.products).length > 0) {
          let productMsg = `🛒 Products\n\n`;
          Object.values(session.products).forEach((p, i) => {
            productMsg += `${i + 1}. ${p.productname} – ₹${p.mrp}\n`;
          });
          productMsg += "\nReply product number to add item";
          
          await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
          return sendWhatsApp(from, productMsg, ["Cart", "Back", "List", "Exit"]);
        } else {
          // No products, go back further
          return handleChat(from, "back", redisClient);
        }
        
      case "confirm_order":
        // Go back to cart
        console.log(`📁 Going back from order confirmation`);
        session.step = "product";
        
        let cartMsg = "🛒 *Your Cart*\n\n";
        if (!session.cart || Object.keys(session.cart).length === 0) {
          cartMsg += "Cart is empty.";
        } else {
          Object.values(session.cart).forEach(p => {
            cartMsg += `• ${p.name} x${p.qty}\n`;
          });
        }
        cartMsg += "\nType *Order* to place order";
        
        await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
        return sendWhatsApp(from, cartMsg, ["Order", "Back", "List", "Exit"]);
        
      default:
        return sendWhatsApp(from, "Type *List* to see categories.", ["List", "Exit"]);
    }
  }

  /* =====================
     LIST – MAIN CATEGORY
  ===================== */
  if (input === "list") {
    console.log(`📋 List command detected`);
    
    // If no session, create one
    if (!session) {
      console.log(`📝 Creating new session for list command`);
      
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
        step: "category",
        cart: {},
        current_parent_id: 0
      };
    }

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

    if (rows.length === 0) {
      return sendWhatsApp(from, "No categories available at the moment.");
    }

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
     CATEGORY SELECTION
  ===================== */
  if (session?.step === "category" && session.categories?.[input]) {
    const selected = session.categories[input];
    console.log(`🎯 Selected category: ${selected.category_name} (ID: ${selected.id})`);

    session.current_parent_id = selected.id;

    const [subs] = await db.execute(
      `SELECT id, category_name, parent_id
       FROM category
       WHERE parent_id = ? AND is_prod_present = 1`,
      [selected.id]
    );

    console.log(`🔍 Found ${subs.length} subcategories`);

    if (subs.length > 0) {
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
       NO SUBCATEGORIES, SHOW PRODUCTS
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

    if (products.length === 0) {
      return sendWhatsApp(
        from, 
        `No products available in *${selected.category_name}* category.`,
        ["Back", "List", "Exit"]
      );
    }

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
    return sendWhatsApp(from, msg, ["Cart", "Back", "List"]);
  }

  /* =====================
     SUBCATEGORY SELECTION
  ===================== */
  if (session?.step === "subcategory" && session.subcategories?.[input]) {
    const selected = session.subcategories[input];
    console.log(`🎯 Selected subcategory: ${selected.category_name} (ID: ${selected.id})`);

    session.current_parent_id = selected.id;

    console.log(`🛍️ Loading products for subcategory ID: ${selected.id}`);
    
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

    if (products.length === 0) {
      return sendWhatsApp(
        from, 
        `No products available in *${selected.category_name}* subcategory.`,
        ["Back", "List", "Exit"]
      );
    }

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
    return sendWhatsApp(from, msg, ["Cart", "Back", "List"]);
  }

  /* =====================
     PRODUCT SELECTION
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

    if (!session.cart) session.cart = {};
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
    return sendWhatsApp(from, msg, ["Cart", "Back", "List"]);
  }

  /* =====================
     CART
  ===================== */
  if (input === "cart") {
    console.log(`🛒 Cart command detected`);
    
    if (!session) {
      return sendWhatsApp(from, "No session found. Type *Hi* to start.", ["List", "Exit"]);
    }
    
    let msg = "🛒 *Your Cart*\n\n";

    if (!session.cart || Object.keys(session.cart).length === 0) {
      msg += "Cart is empty.";
      console.log(`🛒 Cart is empty`);
    } else {
      Object.values(session.cart).forEach(p => {
        msg += `• ${p.name} x${p.qty}\n`;
      });
      console.log(`🛒 Cart has ${Object.values(session.cart).length} items`);
    }

    msg += "\nType *Order* to place order";
    return sendWhatsApp(from, msg, ["Order", "Back", "List"]);
  }

  /* =====================
     ORDER
  ===================== */
  if (input === "order") {
    console.log(`📦 Order command detected`);
    
    if (!session || !session.cart || Object.keys(session.cart).length === 0) {
      console.log(`❌ Cannot order: cart is empty or no session`);
      return sendWhatsApp(from, "🛒 Cart is empty.", ["Back", "List", "Exit"]);
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
  
  // If in product step and user typed a number, check if it's valid
  if (session?.step === "product" && /^\d+$/.test(input)) {
    const num = parseInt(input);
    if (!session.products || !session.products[num]) {
      return sendWhatsApp(
        from, 
        `Invalid product number. Please select from 1 to ${Object.keys(session.products || {}).length}.`,
        ["Cart", "Back", "List"]
      );
    }
  }
  
  if (session) {
    await redisClient.expire(redisKey, SESSION_TTL);
  }
  
  return sendWhatsApp(from, "Invalid input. Type *Hi* to start or *List* to see categories.", ["List", "Exit"]);
}

module.exports = { handleChat };