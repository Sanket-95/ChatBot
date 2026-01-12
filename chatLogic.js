// Back option FIXED using parent_id (SAFE PATCH)
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
      `SELECT id, parent_id, category_name
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

    msg += "\nType category number.\nExit";

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, msg);
  }

  /* =====================
     BACK (SAFE)
  ===================== */
  if (input === "back" && session) {
    if (session.step === "subcategory") {
      session.step = "category";
      session.subcategories = null;
    } else if (session.step === "product") {
      session.step = session.lastParentId === 0 ? "category" : "subcategory";
      session.products = null;
    } else if (session.step === "qty") {
      session.step = "product";
      session.pendingProduct = null;
    }

    await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
    return sendWhatsApp(from, "⬅️ Back\nType number again.");
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

    session.lastParentId = selected.parent_id;

    const [subs] = await db.execute(
      `SELECT id, parent_id, category_name
       FROM category
       WHERE parent_id = ?
       AND is_prod_present = 1`,
      [selected.id]
    );

    if (subs.length) {
      session.subcategories = {};
      session.step = "subcategory";

      let msg =
        selected.parent_id === 0
          ? `📂 *${selected.category_name} – Subcategories*\n\n`
          : `📂 *${selected.category_name}*\n\n`;

      subs.forEach((r, i) => {
        session.subcategories[i + 1] = r;
        msg += `${i + 1}. ${r.category_name}\n`;
      });

      msg += "\nType number.";
      if (selected.parent_id > 0) msg += "\nBack";
      msg += "\nExit";

      await redisClient.setEx(redisKey, SESSION_TTL, JSON.stringify(session));
      return sendWhatsApp(from, msg);
    }

    /* =====================
       PRODUCTS (UNCHANGED)
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
      msg += `${i + 1}. ${p.productname} – ₹${p.mrp}`;
      if (p.scheme_name) msg += ` 🎁 *${p.scheme_name}*`;
      msg += "\n";
    });

    msg += "\nReply product number\nBack | List | Exit";

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
     FALLBACK
  ===================== */
  await redisClient.expire(redisKey, SESSION_TTL);
  return sendWhatsApp(from, "Invalid input.\nList | Exit");
}

module.exports = { handleChat };
