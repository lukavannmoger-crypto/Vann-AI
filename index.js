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

// ---------------- OTP, Rate-limit & Cache ----------------
const otpStore = new Map();
const otpRateLimit = new Map();
const orderCache = new Map();

// ---------------- Helpers ----------------
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getKey(user, lookupValue) {
  return `${user}_${lookupValue}`;
}

function canSendOTP(user, lookupValue) {
  const now = Date.now();
  const key = getKey(user, lookupValue);
  const record = otpRateLimit.get(key);
  if (!record || now > record.resetTime) {
    otpRateLimit.set(key, { count: 1, resetTime: now + 15 * 60 * 1000 });
    return true;
  }
  if (record.count >= 3) return false;
  record.count += 1;
  return true;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of otpStore) if (record.expires < now) otpStore.delete(key);
  for (const [key, record] of otpRateLimit) if (record.resetTime < now) otpRateLimit.delete(key);
  for (const [key, record] of orderCache) if (record.expires < now) orderCache.delete(key);
}, 60 * 1000);

function isEmail(text) { return /\S+@\S+\.\S+/.test(text); }
function isPhone(text) { return /^[+]?[\d\s\-]{8,15}$/.test(text); }
function maskEmail(email) { const [name, domain] = email.split("@"); return name[0]+"***@"+domain; }
function maskPhone(phone) { const clean = phone.replace(/\D/g,""); return "******"+clean.slice(-4); }

function formatOrder(order) {
  if (!order) return "❌ No hay datos del pedido.";
  const maskedEmail = order.email ? maskEmail(order.email) : "N/A";
  const maskedPhone = order.phone ? maskPhone(order.phone) : "N/A";
  return `📦 Pedido ${order.name}
💳 Estado pago: ${order.financial_status}
🚚 Estado envío: ${order.fulfillment_status || "Procesando"}
📧 Email: ${maskedEmail}
📱 Teléfono: ${maskedPhone}
📅 Fecha: ${new Date(order.created_at).toLocaleDateString("es-CO")}`;
}

// ---------------- Shopify ----------------
async function getOrderStatusByNumber(orderNumber) {
  try {
    const clean = orderNumber.replace("#","").trim();
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=${clean}&status=any`;
    const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN } });
    const order = res.data.orders?.[0];
    if(!order) return "❌ Pedido no encontrado.";
    return formatOrder(order);
  } catch (err) {
    console.error(err.response?.data || err.message);
    return "⚠️ No se pudo obtener el pedido. Intenta más tarde.";
  }
}

async function getOrderStatusByEmail(email) {
  try {
    if(orderCache.has(email)) return orderCache.get(email).data;
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?email=${email}&status=any`;
    const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN } });
    const order = res.data.orders?.[0];
    if(!order) return "❌ No hay pedidos para este email.";
    const formatted = formatOrder(order);
    orderCache.set(email, { data: formatted, expires: Date.now() + 5*60*1000 });
    return formatted;
  } catch(err) {
    console.error(err.response?.data || err.message);
    return "⚠️ No se pudo obtener el pedido. Intenta más tarde.";
  }
}

async function getOrderStatusByPhone(phone) {
  try {
    if(orderCache.has(phone)) return orderCache.get(phone).data;
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=any`;
    const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN } });
    const cleanPhone = phone.replace(/\D/g,"");
    const order = res.data.orders.find(o => o.phone && o.phone.replace(/\D/g,"").includes(cleanPhone));
    if(!order) return "❌ No hay pedidos para este teléfono.";
    const formatted = formatOrder(order);
    orderCache.set(phone, { data: formatted, expires: Date.now() + 5*60*1000 });
    return formatted;
  } catch(err) {
    console.error(err.response?.data || err.message);
    return "⚠️ No se pudo obtener el pedido. Intenta más tarde.";
  }
}

// ---------------- OTP ----------------
async function requestOTP(user, lookupValue, lookupType) {
  const key = getKey(user, lookupValue);
  if(!canSendOTP(user, lookupValue)) return "⛔ Demasiadas solicitudes de código. Intenta en 15 minutos.";
  const otp = generateOTP();
  otpStore.set(key, { otp, expires: Date.now() + 5*60*1000, lookupType, lookupValue });
  return `🔐 Tu código de verificación es: *${otp}*\nExpira en 5 minutos.\n\n*Habeas Data*: tus datos son usados solo para seguimiento de pedidos.`;
}

async function verifyOTP(user, lookupValue, enteredOtp) {
  const key = getKey(user, lookupValue);
  const record = otpStore.get(key);
  if(!record) return "❌ No hay solicitud de verificación. Intenta de nuevo.";
  if(Date.now() > record.expires) { otpStore.delete(key); return "⌛ Código expirado. Solicita uno nuevo."; }
  if(record.otp !== enteredOtp) return "❌ Código incorrecto. Intenta de nuevo.";
  otpStore.delete(key);

  let result;
  if(record.lookupType==="email") result = await getOrderStatusByEmail(record.lookupValue);
  if(record.lookupType==="phone") result = await getOrderStatusByPhone(record.lookupValue);

  const upsell = `🔥 ¡Oferta especial! Mira nuestros productos destacados: https://${SHOPIFY_STORE}/collections/all`;
  result += `\n\n${upsell}`;

  orderCache.set(lookupValue, { data: result, expires: Date.now() + 5*60*1000 });
  return result;
}

// ---------------- WhatsApp Buttons ----------------
function formatButtonTitle(title) {
  return title.length > 20 ? title.slice(0, 17) + "…" : title;
}

async function sendWhatsAppButtons(to, text, buttons) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: { buttons: buttons.slice(0,3).map(b=>({type:"reply",reply:{id:b.id,title:formatButtonTitle(b.title)}})) }
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`, payload,
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" } });
  } catch(err) {
    console.error("Error sending WhatsApp buttons:", err.response?.data||err.message);
  }
}

async function sendMainMenu(to) {
  const buttons = [
    { id: "check_order", title: "📦 Consultar Pedido" },
    { id: "browse_products", title: "🛍️ Ver Productos" },
    { id: "help", title: "❓ Ayuda" },
  ];
  await sendWhatsAppButtons(to, "¡Hola! ¿Qué deseas hacer? 🤩", buttons);
}

// ---------------- Products ----------------
async function sendProductsList(to) {
  try {
    const res = await axios.get(`https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=5`,
      { headers:{ "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN }});
    const products = res.data.products || [];
    if(!products.length) return sendWhatsAppMessage(to,"❌ No se encontraron productos.");

    const buttons = products.map((p,i)=>{
      let title = p.title.length > 12 ? p.title.slice(0,12) + "…" : p.title;
      title = `${title} 💰${p.variants[0].price}`;
      title = formatButtonTitle(title);
      return { id:`product_${i}`, title };
    });

    await sendWhatsAppButtons(to,"🛍️ Mira nuestros productos destacados:", buttons);
  } catch(err) {
    console.error("Error sending product list:", err.response?.data||err.message);
  }
}

async function sendProductDetail(to, selectedId) {
  try {
    const index = parseInt(selectedId.split("_")[1],10);
    const res = await axios.get(`https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=5`,
      { headers:{ "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN }});
    const product = res.data.products[index];
    if(!product) return sendWhatsAppMessage(to,"⚠️ Producto no encontrado.");

    const price = product.variants[0].price;
    const checkoutUrl = `https://${SHOPIFY_STORE}/cart/${product.variants[0].id}:1`;
    const buttons = [{ id:"buy_now", title: "Comprar 🛒" }];

    const payload = {
      messaging_product:"whatsapp",
      to,
      type:"interactive",
      interactive:{
        type:"button",
        body:{ text:`🛍️ ${product.title}\n💰 Precio: ${price} COP` },
        action:{ buttons: buttons.map(b => ({ id: b.id, title: formatButtonTitle(b.title) })) }
      }
    };

    await axios.post(`https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`, payload,
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json"}});
    await sendWhatsAppMessage(to, `Compra aquí: ${checkoutUrl}`);
  } catch(err) {
    console.error("Error product detail:", err.response?.data||err.message);
    await sendWhatsAppMessage(to,"⚠️ No se pudo obtener detalles del producto.");
  }
}

// ---------------- Simple WhatsApp message ----------------
async function sendWhatsAppMessage(to,message){
  try{
    await axios.post(`https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product:"whatsapp", to, text:{ body:message }},
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json"}});
  }catch(err){
    console.error("Error sending WhatsApp message:", err.response?.data||err.message);
  }
}

// ---------------- OpenAI fallback ----------------
async function askAI(userMessage){
  const completion = await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      { role:"system", content:"Eres un asistente de WhatsApp vendedor para Colombia. Usa emojis, lenguaje amigable y precios en COP." },
      { role:"user", content:userMessage }
    ]
  });
  return completion.choices[0].message.content;
}

// ---------------- Webhook ----------------
app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"];
  const token=req.query["hub.verify_token"];
  const challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN){
    console.log("Webhook verificado");
    res.status(200).send(challenge);
  }else{
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req,res)=>{
  try{
    const message=req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!message) return res.sendStatus(200);

    const from = message.from;
    const userText = message.text?.body || "";
    const lower = userText.toLowerCase();

    const interactive = message?.interactive;
    if(interactive?.type==="button_reply"){
      const btnId = interactive.button_reply.id;
      if(btnId==="check_order") await sendWhatsAppMessage(from,"Por favor comparte tu número de pedido (#1234), email o teléfono usado.");
      else if(btnId==="browse_products") await sendProductsList(from);
      else if(btnId==="help") await sendWhatsAppMessage(from,"Puedo ayudarte a rastrear pedidos, ver productos y responder preguntas.");
      else if(btnId==="buy_now") await sendWhatsAppMessage(from,"¡Gracias por tu compra! 🛒");
      return res.sendStatus(200);
    }

    let reply;
    if(lower.includes("menu")||lower.includes("hola")||lower.includes("hi")||lower.includes("hello")){
      await sendMainMenu(from); return res.sendStatus(200);
    }else if(lower.includes("pedido")||lower.includes("tracking")||lower.includes("track")){
      reply = "Por favor comparte tu número de pedido (#1234), email o teléfono usado.";
    }else if(isEmail(userText)||isPhone(userText)){
      const lookupType = isEmail(userText)?"email":"phone";
      reply = await requestOTP(from,userText.trim(),lookupType);
    }else if(/^\d{6}$/.test(userText.trim())){
      let found=false;
      for(const key of otpStore.keys()){
        if(key.startsWith(from+"_")){
          const lookupValue=key.split("_")[1];
          reply = await verifyOTP(from,lookupValue,userText.trim());
          found=true; break;
        }
      }
      if(!found) reply="❌ No hay OTP activo. Solicita uno nuevo.";
    }else if(userText.trim().startsWith("#")){
      reply = await getOrderStatusByNumber(userText.trim());
    }else if(lower.includes("mostrar")||lower.includes("producto")||lower.includes("catalogo")){
      await sendProductsList(from); return res.sendStatus(200);
    }else if(userText.startsWith("product_")){
      await sendProductDetail(from,userText); return res.sendStatus(200);
    }else{
      reply = await askAI(userText);
    }

    if(reply) await sendWhatsAppMessage(from,reply);
    res.sendStatus(200);
  }catch(err){
    console.error(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));