require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  SHOPIFY_STORE,
  SHOPIFY_ADMIN_TOKEN
} = process.env;

if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !VERIFY_TOKEN) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/* ================= MEMORY / SESSION ================= */
const otpStore = new Map();
const otpRateLimit = new Map();
const orderCache = new Map();
const abandonedCarts = {};
const humanTakeover = new Set();
const userSessions = new Map(); // Tracks user language

function getUserLang(from, text) {
  if (userSessions.has(from)) return userSessions.get(from);
  const lang = /hola|quiero|busco|necesito/i.test(text) ? "es" : "en";
  userSessions.set(from, lang);
  return lang;
}

/* ================= UTILITIES ================= */
function formatButtonTitle(title) {
  return !title ? "Option" : title.length > 20 ? title.slice(0, 17) + "…" : title;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ================= WHATSAPP ================= */
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("WhatsApp message error:", err.response?.data || err.message);
  }
}

async function sendWhatsAppButtons(to, text, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: {
            buttons: buttons.slice(0, 3).map(b => ({
              type: "reply",
              reply: { id: b.id, title: formatButtonTitle(b.title) }
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("Button error:", err.response?.data || err.message);
  }
}

/* ================= SHOPIFY ================= */
async function getShopifyProducts(limit = 20) {
  const res = await axios.get(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=${limit}`,
    { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN } }
  );

  return res.data.products.map(p => ({
    id: p.id,
    title: p.title,
    price: p.variants[0].price,
    image: p.image?.src,
    variantId: p.variants[0].id,
    url: `https://${SHOPIFY_STORE}/cart/${p.variants[0].id}:1`
  }));
}

/* ================= AI PRODUCT RECOMMENDER ================= */
async function aiPickProducts(userText, products, mode = "single") {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `ONLY choose products from the list. Return a JSON array of product IDs. Mode: ${mode}`
      },
      {
        role: "user",
        content: `
User request:
"${userText}"

Products:
${products.map(p => `- ${p.id}: ${p.title}`).join("\n")}
`
      }
    ]
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return [];
  }
}

/* ================= PRODUCT SENDER ================= */
async function sendProduct(to, product) {
  if (product.image) {
    await axios.post(
      `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: product.image }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  }

  await sendWhatsAppButtons(
    to,
    `🛍️ *${product.title}*\n💰 ${product.price} COP`,
    [{ id: `buy_${product.id}`, title: "Comprar" }]
  );

  await sendWhatsAppMessage(to, `🛒 Compra aquí:\n${product.url}`);

  abandonedCarts[to] = product;
}

/* ================= MAIN MENU ================= */
async function sendMainMenu(to) {
  const lang = userSessions.get(to) || "en";

  const text = lang === "es"
    ? "👋 Hola! ¿Qué te gustaría hacer hoy?"
    : "👋 Hi! What would you like to do today?";

  const buttons = [
    { id: "browse_products", title: lang === "es" ? "Ver productos" : "Browse products" },
    { id: "check_order", title: lang === "es" ? "Revisar pedido" : "Check order" },
    { id: "human_agent", title: lang === "es" ? "Hablar con agente" : "Talk to agent" },
  ];

  await sendWhatsAppButtons(to, text, buttons);
}

/* ================= AI INTENT CLASSIFIER ================= */
async function classifyIntent(userText) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Classify the user message into one of: [browse_products, check_order, human_agent, unknown]. Respond only with the label."
        },
        { role: "user", content: userText }
      ]
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return "unknown";
  }
}

/* ================= WEBHOOK VERIFY ================= */
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = message.text?.body || "";
    const lang = getUserLang(from, userText);

    if (humanTakeover.has(from)) return res.sendStatus(200);

    // === FIXED BUTTON CLICK HANDLING ===
    let buttonId = null;
    if (message.type === "interactive" && message.interactive?.type === "button_reply") {
      buttonId = message.interactive.button_reply.id;
    }

    if (buttonId) {
      switch (buttonId) {
        case "browse_products":
          {
            const products = await getShopifyProducts();
            const ids = await aiPickProducts("muéstrame productos", products);
            const matches = products.filter(p => ids.includes(p.id)).slice(0, 3);
            for (const p of matches) await sendProduct(from, p);
          }
          break;

        case "check_order":
          await sendWhatsAppMessage(
            from,
            lang === "es" ? "📝 Por favor, proporciona tu número de pedido." : "📝 Please provide your order number."
          );
          break;

        case "human_agent":
          humanTakeover.add(from);
          await sendWhatsAppMessage(
            from,
            lang === "es" ? "👤 Un agente humano continuará la conversación." : "👤 A human agent will assist you."
          );
          break;

        default:
          await sendMainMenu(from);
          break;
      }
      return res.sendStatus(200);
    }

    // === AI INTENT FOR TEXT ===
    const intent = await classifyIntent(userText);

    if (intent === "human_agent") {
      humanTakeover.add(from);
      await sendWhatsAppMessage(
        from,
        lang === "es" ? "👤 Un agente humano continuará la conversación." : "👤 A human agent will assist you."
      );
    } else if (intent === "browse_products") {
      const products = await getShopifyProducts();
      const ids = await aiPickProducts(userText, products);
      const matches = products.filter(p => ids.includes(p.id)).slice(0, 3);
      for (const p of matches) await sendProduct(from, p);
    } else if (intent === "check_order") {
      await sendWhatsAppMessage(
        from,
        lang === "es" ? "📝 Por favor, proporciona tu número de pedido." : "📝 Please provide your order number."
      );
    } else {
      await sendMainMenu(from); // unknown: show menu in correct language
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ================= ABANDONED CART ================= */
setInterval(async () => {
  for (const [user, product] of Object.entries(abandonedCarts)) {
    await sendWhatsAppMessage(
      user,
      `⏰ ¿Aún te interesa *${product.title}*?\n👉 ${product.url}`
    );
    delete abandonedCarts[user];
  }
}, 1000 * 60 * 30);

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));