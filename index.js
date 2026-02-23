import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

/* ================= ENV ================= */
const {
  PORT = 3000,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  SHOPIFY_STORE,
  SHOPIFY_ADMIN_TOKEN,
  OPENAI_API_KEY
} = process.env;

/* ================= OPENAI ================= */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ================= MEMORY ================= */
const abandonedCarts = {};
const humanTakeover = new Set();

/* ================= HELPERS ================= */
const formatButtonTitle = t =>
  !t ? "Option" : t.length > 20 ? t.slice(0, 17) + "…" : t;

const detectLanguage = text =>
  /hola|quiero|busco|necesito/i.test(text) ? "es" : "en";

/* ================= WHATSAPP ================= */
async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function sendWhatsAppButtons(to, body, buttons) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: formatButtonTitle(b.title) }
          }))
        }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
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

/* ================= AI RECOMMENDER ================= */
async function aiPickProducts(userText, products, mode = "single") {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a shopping assistant.
ONLY select from the list.
Mode: ${mode}
Return ONLY a JSON array of product IDs.
`
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

/* ================= PRODUCT CARD ================= */
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
    `🛍️ *${product.title}*\n💰 ${product.price}`,
    [{ id: `buy_${product.id}`, title: "Comprar" }]
  );

  await sendWhatsAppMessage(to, `🛒 ${product.url}`);

  abandonedCarts[to] = product;
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
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg?.text) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text.body.toLowerCase();
    const lang = detectLanguage(text);

    if (humanTakeover.has(from)) return res.sendStatus(200);

    if (/agent|agente|human/i.test(text)) {
      humanTakeover.add(from);
      await sendWhatsAppMessage(
        from,
        lang === "es"
          ? "👤 Un agente humano continuará."
          : "👤 A human agent will assist you."
      );
      return res.sendStatus(200);
    }

    const products = await getShopifyProducts();

    // Outfit bundles
    if (/outfit|conjunto|combinar/i.test(text)) {
      const ids = await aiPickProducts(text, products, "bundle");
      for (const p of products.filter(x => ids.includes(x.id)).slice(0, 3)) {
        await sendProduct(from, p);
      }
      return res.sendStatus(200);
    }

    // Normal intent
    if (/quiero|busco|need|want|camisa|shirt|pants|hoodie/i.test(text)) {
      const ids = await aiPickProducts(text, products);
      for (const p of products.filter(x => ids.includes(x.id)).slice(0, 3)) {
        await sendProduct(from, p);
      }
      return res.sendStatus(200);
    }

    await sendWhatsAppMessage(
      from,
      lang === "es"
        ? "👋 Puedo ayudarte a encontrar ropa y accesorios."
        : "👋 I can help you find clothes and accessories."
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(200);
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
app.listen(PORT, () =>
  console.log(`✅ WhatsApp AI Bot running on ${PORT}`)
);