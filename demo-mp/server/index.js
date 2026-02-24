// =============================================================================
// server/index.js
// Servidor principal del demo de Mercado Pago (Checkout Pro)
// -----------------------------------------------------------------------------
// Responsabilidades:
//   1. Recibir solicitud del frontend para crear una preferencia de pago.
//   2. Enviar la preferencia a la API de Mercado Pago y devolver el link de pago.
//   3. Recibir y procesar webhooks que MP manda cuando ocurre un evento de pago.
//   4. Exponer un endpoint para que el frontend consulte el estado del pago.
// =============================================================================

// ---------------------------------------------------------------------------
// SECCIÓN: Importaciones y configuración inicial
// ---------------------------------------------------------------------------

// Carga las variables de entorno del archivo .env (MP_ACCESS_TOKEN, PUBLIC_BASE_URL, etc.)
require("dotenv").config();

// Framework web minimalista para Node.js — maneja rutas HTTP, middlewares, etc.
const express = require("express");

// Módulo nativo de Node para generar UUIDs únicos (usados como external_reference)
const crypto = require("crypto");

// Instancia principal de la aplicación Express
const app = express();

// ---------------------------------------------------------------------------
// SECCIÓN: Middlewares globales
// ---------------------------------------------------------------------------

// Permite leer cuerpos de peticiones en formato application/x-www-form-urlencoded
// (MP puede mandar notificaciones en este formato en algunos casos)
app.use(express.urlencoded({ extended: true }));

// Permite leer cuerpos de peticiones en formato application/json
// (el frontend manda JSON al crear la preferencia)
app.use(express.json());

// ---------------------------------------------------------------------------
// SECCIÓN: CORS (Cross-Origin Resource Sharing)
// ---------------------------------------------------------------------------
// Permite que el frontend (diferente origen, ej: localhost:5500) llame al backend (localhost:3001)
// En producción deberías restringir el origen a tu dominio real.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // Las peticiones OPTIONS son "preflight" del navegador — las respondemos de inmediato
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// SECCIÓN: Variables de entorno
// ---------------------------------------------------------------------------

// Puerto donde escucha el servidor (por defecto 3001 si no se define en .env)
const PORT = process.env.PORT || 3001;

// Token de acceso privado de Mercado Pago. Se obtiene en:
// https://www.mercadopago.com.ar/settings/account/credentials
// ⚠️ NUNCA lo expongas en el frontend ni en Git.
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// URL pública del BACKEND (por ejemplo, generada con ngrok apuntando al puerto 3001).
// Mercado Pago necesita esta URL para enviar los webhooks.
// Ejemplo: https://abcd-1234.ngrok-free.app
// ⚠️ NO puede ser localhost; MP no puede alcanzar una URL local.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// URL pública del FRONTEND (opcional). Se usa para construir las back_urls
// de redirección luego del pago.
// Si querés auto_return (redirección automática), esta URL también debe ser pública.
// Ejemplo: https://xxxx.ngrok-free.app
const FRONT_BASE_URL = process.env.FRONT_BASE_URL;

// ---------------------------------------------------------------------------
// SECCIÓN: Base de datos en memoria (demo)
// ---------------------------------------------------------------------------
// En producción reemplazás esto por una base de datos real (PostgreSQL, MongoDB, etc.)

const payments = new Map(); // Estructura: external_reference → objeto de pago

/**
 * Crea un registro de pago nuevo con estado inicial "created".
 * Se llama justo después de crear exitosamente la preferencia en MP.
 *
 * @param {object} param0
 * @param {string} param0.external_reference - UUID único que identifica la orden
 * @param {string} param0.preference_id      - ID de la preferencia devuelto por MP
 * @param {number} param0.amount             - Monto total calculado (quantity * unit_price)
 */
function createPayment({ external_reference, preference_id, amount }) {
  payments.set(external_reference, {
    external_reference,
    preference_id,
    amount,
    status: "created",        // Estado inicial antes de que el usuario pague
    mp_payment_id: null,      // Se llena cuando MP confirma el pago via webhook
    updatedAt: new Date().toISOString(),
  });
  return payments.get(external_reference);
}

/**
 * Actualiza el estado de un pago existente.
 * Incluye idempotencia: si ya está "approved", no se permite bajar a otro estado
 * (por ejemplo, si llega un webhook duplicado o desordenado).
 *
 * @param {string} external_reference - UUID del pago a actualizar
 * @param {object} patch              - Campos a sobreescribir (status, mp_payment_id, etc.)
 */
function updatePayment(external_reference, patch) {
  const curr = payments.get(external_reference);
  if (!curr) return null;

  // Idempotencia: un pago aprobado no puede volver a un estado "menor"
  // Esto evita problemas si MP envía webhooks fuera de orden.
  if (curr.status === "approved" && patch.status && patch.status !== "approved") {
    return curr;
  }

  const next = {
    ...curr,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  payments.set(external_reference, next);
  return next;
}

/**
 * Obtiene el registro de un pago por su external_reference.
 *
 * @param {string} external_reference - UUID del pago
 * @returns {object|null} - El objeto de pago o null si no existe
 */
function getPayment(external_reference) {
  return payments.get(external_reference) || null;
}

// ---------------------------------------------------------------------------
// SECCIÓN: Utilidades
// ---------------------------------------------------------------------------

/**
 * Genera un UUID v4 aleatorio.
 * Se usa como external_reference único por cada orden de pago.
 */
function uuid() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// SECCIÓN: Funciones de comunicación con la API de Mercado Pago
// ---------------------------------------------------------------------------

/**
 * Consulta los detalles de un pago específico a la API de Mercado Pago.
 * Útil para verificar el estado real del pago cuando llega un webhook.
 *
 * @param {string|number} paymentId - ID del pago devuelto por MP
 * @returns {{ ok: boolean, status: number, data: object }}
 */
async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

/**
 * Consulta una merchant_order (orden comercial) a la API de Mercado Pago.
 * Una merchant_order agrupa uno o varios intentos de pago de una misma preferencia.
 *
 * @param {string|number} orderId - ID de la merchant_order
 * @returns {{ ok: boolean, status: number, data: object }}
 */
async function mpGetMerchantOrder(orderId) {
  const r = await fetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// ---------------------------------------------------------------------------
// SECCIÓN: Catálogo de productos de ejemplo
// ---------------------------------------------------------------------------
// Lista de productos tipo almacén que se pueden comprar en este demo.
// Cada producto tiene:
//   - id          : identificador interno del producto
//   - title       : nombre descriptivo que verá el comprador en el checkout de MP
//   - unit_price  : precio unitario en ARS
//   - currency_id : moneda (ARS = Peso Argentino)
//   - category_id : categoría que MP usa para clasificar el ítem (food = alimentos)
// Podés agregar o quitar productos según tu caso de uso.
const PRODUCT_CATALOG = [
  { id: "leche",   title: "Leche entera 1L",       unit_price: 350,  currency_id: "ARS", category_id: "food" },
  { id: "harina",  title: "Harina 0000 1kg",        unit_price: 280,  currency_id: "ARS", category_id: "food" },
  { id: "arroz",   title: "Arroz largo fino 500g",  unit_price: 220,  currency_id: "ARS", category_id: "food" },
  { id: "aceite",  title: "Aceite de girasol 900ml",unit_price: 480,  currency_id: "ARS", category_id: "food" },
  { id: "azucar",  title: "Azúcar blanca 1kg",      unit_price: 260,  currency_id: "ARS", category_id: "food" },
];

// =============================================================================
// SECCIÓN: Rutas (endpoints) de la API
// =============================================================================

// -----------------------------------------------------------
// 1) POST /api/create-preference
//    Crea una preferencia de pago en Mercado Pago y devuelve
//    el link de checkout (init_point / sandbox_init_point).
// -----------------------------------------------------------
app.post("/api/create-preference", async (req, res) => {
  try {
    // -------------------------------------------------------
    // Leemos el cuerpo de la solicitud del frontend.
    // El frontend puede mandar:
    //   - productId  : ID del producto del catálogo (ej: "leche")
    //   - quantity   : cantidad de unidades
    // Si no se manda productId, usamos el primer producto del catálogo por defecto.
    // -------------------------------------------------------
    const { productId, quantity = 1 } = req.body;

    // Buscamos el producto en el catálogo; si no existe, usamos el primero
    const product = PRODUCT_CATALOG.find((p) => p.id === productId) || PRODUCT_CATALOG[0];

    // Validaciones de variables de entorno obligatorias
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en .env" });
    }
    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({
        error: "Falta PUBLIC_BASE_URL en .env (debe ser URL pública tipo ngrok del backend)",
      });
    }

    // Generamos un UUID único que identifica ESTA orden de pago.
    // Lo usamos como external_reference para rastrear el pago en nuestra DB.
    const external_reference = uuid();

    // Calculamos el monto total de la compra
    const amount = Number(quantity) * product.unit_price;

    // -------------------------------------------------------
    // URL de notificación (webhook): MP llamará a esta URL
    // cuando ocurra un evento de pago (aprobado, rechazado, etc.)
    // DEBE ser pública (ngrok u otro tunel/hosting).
    // -------------------------------------------------------
    const notification_url = `${PUBLIC_BASE_URL}/api/webhook`;

    // -------------------------------------------------------
    // back_urls: a dónde redirige MP al usuario luego del pago.
    // Si FRONT_BASE_URL está definido usamos esa URL (pública).
    // Si no, usamos localhost (sólo sirve para pruebas sin auto_return).
    // -------------------------------------------------------
    const back_urls = FRONT_BASE_URL
      ? {
          success: `${FRONT_BASE_URL}/client/index.html?result=success`,
          pending: `${FRONT_BASE_URL}/client/index.html?result=pending`,
          failure: `${FRONT_BASE_URL}/client/index.html?result=failure`,
        }
      : {
          success: "http://127.0.0.1:5500/client/index.html?result=success",
          pending: "http://127.0.0.1:5500/client/index.html?result=pending",
          failure: "http://127.0.0.1:5500/client/index.html?result=failure",
        };

    // ═══════════════════════════════════════════════════════════════════════
    // CAMPOS DE LA PREFERENCIA — todo lo que le enviamos a Mercado Pago
    // Documentación oficial de la API:
    // https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
    // ═══════════════════════════════════════════════════════════════════════
    const preferenceBody = {

      // ── items ──────────────────────────────────────────────────────────
      // Array con los productos/servicios que se van a cobrar.
      // Podés incluir más de un ítem (carrito de compras).
      // OBLIGATORIO: al menos un elemento con title, quantity y unit_price.
      items: [
        {
          // id
          // Tu identificador interno del producto. MP no lo valida ni lo usa
          // para lógica de negocio, pero lo devuelve en los detalles del pago
          // y es útil para rastrear qué producto se vendió.
          id: product.id,

          // title
          // Nombre del producto que verá el comprador en la pantalla del
          // checkout de Mercado Pago. Debe ser claro y descriptivo.
          // Máximo 256 caracteres.
          title: product.title,

          // description
          // Texto adicional sobre el producto. Aparece debajo del title
          // en algunas vistas del checkout. Podés usarlo para aclaraciones
          // (ej: "Sin cargo por envío", "Incluye IVA", etc.).
          description: `Compra de ${product.title} - Demo MP`,

          // picture_url
          // URL pública de la imagen del producto.
          // Si la pasás, MP la muestra en el checkout junto al título.
          // null → no mostramos imagen (sólo para demo).
          picture_url: null,

          // category_id
          // Categoría del ítem según la taxonomía de Mercado Pago.
          // MP la usa para clasificar la transacción internamente.
          // Valores comunes: "food", "electronics", "clothing", "services", etc.
          // Lista completa: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/additional-content/categories
          category_id: product.category_id,

          // quantity
          // Cantidad de unidades del producto. Debe ser un entero >= 1.
          // MP multiplica quantity × unit_price para calcular el subtotal.
          quantity: Number(quantity),

          // unit_price
          // Precio unitario del producto en la moneda indicada (currency_id).
          // IMPORTANTE: debe ser un número con hasta 2 decimales.
          // MP no acepta precios negativos ni cero.
          unit_price: product.unit_price,

          // currency_id
          // Código ISO 4217 de la moneda.
          // Debe coincidir con la moneda de tu cuenta de MP.
          // Ejemplos: "ARS" (Peso Argentino), "BRL" (Real), "USD" (Dólar), etc.
          currency_id: product.currency_id,
        },
      ],

      // ── external_reference ─────────────────────────────────────────────
      // Identificador que VOS definís para esta orden de pago.
      // MP te lo devuelve tal cual en: el webhook, las back_urls y la
      // consulta GET /checkout/preferences/:id.
      // Sirve para vincular la notificación de MP con tu orden interna.
      // En este demo usamos un UUID generado con crypto.randomUUID().
      external_reference,

      // ── notification_url ───────────────────────────────────────────────
      // URL de tu backend donde MP enviará un POST cada vez que cambie
      // el estado del pago (aprobado, rechazado, pendiente, etc.).
      // ⚠️ Debe ser una URL pública accesible desde internet (no localhost).
      // En este demo la generamos con PUBLIC_BASE_URL (ngrok).
      // MP reintenta la notificación varias veces si no recibe un 200.
      notification_url,

      // ── back_urls ──────────────────────────────────────────────────────
      // URLs a las que MP redirige al comprador luego de finalizar el checkout.
      // Son 3 opciones según el resultado:
      //   success → el pago fue aprobado
      //   pending → el pago quedó pendiente (ej: pago en efectivo aún no acreditado)
      //   failure → el pago fue rechazado o cancelado
      // Si el front es localhost, las URLs son locales (auto_return no aplica).
      back_urls,

      // ── auto_return ────────────────────────────────────────────────────
      // Si está en "approved", MP redirige automáticamente al usuario a
      // back_urls.success sin esperrar que haga click en "Volver al sitio".
      // REQUISITO: back_urls.success DEBE ser una URL pública (no localhost).
      // Por eso sólo lo incluimos si FRONT_BASE_URL está definido.
      // Valores posibles: "approved" | "all"  (all = redirige en cualquier caso)
      ...(FRONT_BASE_URL ? { auto_return: "approved" } : {}),

      // ── payer ──────────────────────────────────────────────────────────
      // Datos del pagador. Son opcionales, pero si los proporcionás MP puede
      // pre-completar el formulario del checkout y reducir la fricción.
      // También son útiles para la prevención de fraude.
      payer: {
        // name / surname: nombre y apellido del comprador.
        name: "Comprador",
        surname: "Demo",

        // email: email del pagador.
        // En sandbox, debe ser un email de usuario de prueba de MP
        // (se crean desde el panel de desarrolladores).
        // En producción, podés pasar el email real del usuario logueado.
        email: "test_user_123456789@testuser.com",
      },

      // ── statement_descriptor ───────────────────────────────────────────
      // Nombre que aparece en el resumen de cuenta / tarjeta del comprador
      // cuando se debita el pago. Máximo 22 caracteres.
      // Ayuda al comprador a identificar de dónde vino el cargo.
      statement_descriptor: "DEMO ALMACEN",

      // ── expires ────────────────────────────────────────────────────────
      // Si es true, la preferencia expira en el período definido por
      // expiration_date_from y expiration_date_to (formato ISO 8601).
      // Útil para ofertas por tiempo limitado o reservas de stock.
      // false → la preferencia no tiene vencimiento (persiste 180 días en MP).
      expires: false,
    };

    // -------------------------------------------------------
    // LOG: Mostramos la preferencia COMPLETA por consola antes
    // de enviarla a Mercado Pago para facilitar el debugging.
    // -------------------------------------------------------
    console.log("\n===============================================================");
    console.log("🛒 PREFERENCIA DE PAGO COMPLETA (antes de enviar a MP):");
    console.log("===============================================================");
    console.log(JSON.stringify(preferenceBody, null, 2));
    console.log("===============================================================\n");

    // -------------------------------------------------------
    // Enviamos la preferencia a la API de Mercado Pago vía HTTP POST.
    // -------------------------------------------------------
    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        // Authorization: token privado de tu cuenta de MP.
        // Bearer <token> es el esquema que usa la API de MP para autenticar.
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(preferenceBody),
    });

    // ═══════════════════════════════════════════════════════════════════════
    // RESPUESTA DE MERCADO PAGO — todo lo que nos devuelve al crear la preferencia
    //
    // mpData es el objeto JSON que MP responde. Los campos más importantes son:
    //
    //  id
    //    Identificador único de la preferencia en el sistema de MP.
    //    Formato: "<user_id>-<uuid>" ej: "123456789-abc123..."
    //    Se usa para consultar la preferencia después con GET /checkout/preferences/:id.
    //
    //  init_point
    //    URL del checkout de Mercado Pago en PRODUCCIÓN.
    //    Redirigí al usuario acá cuando estés en vivo.
    //    Ejemplo: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=..."
    //
    //  sandbox_init_point
    //    URL del checkout de Mercado Pago en modo SANDBOX (pruebas).
    //    Usá esta URL mientras estés desarrollando con credenciales de prueba.
    //    Ejemplo: "https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=..."
    //
    //  date_created
    //    Fecha y hora (ISO 8601) en que MP creó la preferencia.
    //    Ejemplo: "2026-02-23T14:30:00.000-03:00"
    //
    //  items
    //    Echo de los ítems que enviaste. MP los devuelve procesados/validados.
    //    Útil para confirmar que MP recibió correctamente los datos.
    //
    //  external_reference
    //    Echo de tu external_reference. Confirmación de que MP lo almacenó.
    //
    //  notification_url
    //    Echo de la URL de webhook. Confirmación de que MP la registró.
    //
    //  back_urls
    //    Echo de las back_urls enviadas.
    //
    //  auto_return
    //    Echo del valor si lo enviaste ("approved" / "all").
    //
    //  payer
    //    Echo de los datos del pagador enviados.
    //
    //  payment_methods
    //    Métodos de pago disponibles para esta preferencia.
    //    Podés haberlos restringido en la preferencia (no lo hacemos en este demo).
    //    Contiene: excluded_payment_methods, excluded_payment_types, installments.
    //
    //  marketplace
    //    Indica si la preferencia está asociada a un marketplace.
    //    Por defecto: "NONE" (pago directo sin marketplace).
    //
    //  marketplace_fee
    //    Comisión del marketplace (0 si no usás marketplace).
    //
    //  collector_id
    //    ID de la cuenta de MP del vendedor que recibe el pago.
    //    Es el ID de la cuenta cuyo MP_ACCESS_TOKEN usaste.
    //
    //  client_id
    //    ID de la aplicación de MP que creó la preferencia.
    //    Corresponde al APP_ID de tus credenciales.
    //
    //  expires / expiration_date_from / expiration_date_to
    //    Echo de la configuración de expiración enviada.
    //
    //  total_amount
    //    Monto total calculado por MP (sum of quantity × unit_price por ítem).
    //    Útil para validar que MP calculó lo mismo que vos.
    //
    //  statement_descriptor
    //    Echo del statement_descriptor enviado.
    //
    //  operation_type
    //    Tipo de operación. Por defecto: "regular_payment".
    //    Otros valores posibles: "money_transfer", "recurring_payment", etc.
    //
    //  differential_pricing
    //    Configuración de precios diferenciales por método de pago (avanzado).
    //    null si no se configuró.
    //
    //  binary_mode
    //    Si es true, el pago sólo puede quedar en "approved" o "rejected"
    //    (nunca "pending"). Por defecto: false.
    //
    //  purpose
    //    Propósito de la preferencia. Por defecto: "onboarding_credits" o vacío.
    //    Usualmente no necesitás tocarlo.
    // ═══════════════════════════════════════════════════════════════════════
    const mpData = await mpRes.json();
    console.log("🟦 MP create preference — HTTP status:", mpRes.status);

    // Si MP respondió con error, lo propagamos al frontend con detalles
    if (!mpRes.ok) {
      console.error("❌ MP respondió con error:", mpData);
      return res.status(400).json({ error: "MP error", details: mpData });
    }

    // Persistimos el pago en nuestra DB en memoria con estado "created"
    createPayment({
      external_reference,
      preference_id: mpData.id,
      amount,
    });

    console.log("✅ Preferencia creada exitosamente:");
    console.log("   preference_id      :", mpData.id);
    console.log("   external_reference :", external_reference);
    console.log("   producto           :", product.title);
    console.log("   cantidad           :", quantity);
    console.log("   total ARS          :", amount);
    console.log("   sandbox_init_point :", mpData.sandbox_init_point);
    console.log("   init_point         :", mpData.init_point);

    // ═══════════════════════════════════════════════════════════════════════
    // RESPUESTA AL FRONTEND — lo que nuestro backend le manda al cliente
    //
    //  external_reference
    //    UUID que generamos nosotros. El frontend lo guarda en localStorage
    //    para luego poder consultar el estado del pago via polling.
    //
    //  preference_id
    //    ID de la preferencia asignado por MP (mpData.id).
    //    El frontend puede usarlo para consultar la preferencia directamente
    //    a MP si fuera necesario (GET /checkout/preferences/:id).
    //
    //  init_point
    //    URL del checkout de MP en PRODUCCIÓN.
    //    El frontend redirige acá cuando se trabaja con credenciales reales.
    //
    //  sandbox_init_point
    //    URL del checkout de MP en SANDBOX (pruebas).
    //    El frontend redirige acá cuando se trabaja con credenciales de prueba.
    //    PRIORIDAD: el frontend usa sandbox_init_point || init_point.
    //
    //  product
    //    Nombre del producto comprado (para mostrar en la UI si querés).
    //
    //  amount
    //    Monto total calculado (quantity × unit_price).
    //    El frontend puede mostrarlo como confirmación antes de redirigir.
    // ═══════════════════════════════════════════════════════════════════════
    return res.json({
      external_reference,
      preference_id: mpData.id,
      init_point: mpData.init_point,
      sandbox_init_point: mpData.sandbox_init_point,
      product: product.title,
      amount,
    });
  } catch (err) {
    console.error("❌ create-preference error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------------------------------------
// 2) POST /api/webhook
//    Endpoint que Mercado Pago llama cuando ocurre un evento
//    relacionado a un pago (aprobado, rechazado, pendiente, etc.)
//
//    MP puede mandar dos tipos de notificaciones:
//      A) type = "payment"        → el pago fue procesado directamente
//      B) type = "merchant_order" → la orden comercial fue actualizada
//         (puede contener uno o más pagos dentro)
//
//    ⚠️ Es FUNDAMENTAL responder 200 INMEDIATAMENTE.
//    Si tardamos más de ~5 segundos, MP considera que falló y reintenta.
//    Por eso el res.sendStatus(200) es lo PRIMERO que hacemos.
// -----------------------------------------------------------
app.post("/api/webhook", async (req, res) => {
  // Respondemos 200 de inmediato para que MP no reintente
  res.sendStatus(200);

  try {
    // Logueamos timestamp y body raw para poder depurar cualquier problema
    console.log("\n🔥 WEBHOOK HIT:", new Date().toISOString());
    console.log("🔥 WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

    if (!MP_ACCESS_TOKEN) {
      console.log("⚠️ Falta MP_ACCESS_TOKEN, no puedo consultar a MP.");
      return;
    }

    // MP envía siempre un type y un data.id
    // type indica qué tipo de recurso cambió
    // data.id es el ID de ese recurso en el sistema de MP
    const type = req.body?.type;
    const dataId = req.body?.data?.id;

    // Si falta alguno de los dos, no podemos procesar el webhook
    if (!type || !dataId) {
      console.log("⚠️ Webhook sin type o sin data.id (no puedo procesar)");
      return;
    }

    // ---------------------------------------------------
    // CASO A: type = "payment"
    // MP nos avisa directamente sobre un pago específico.
    // Consultamos la API de MP para obtener el estado real.
    // ---------------------------------------------------
    if (type === "payment") {
      const { ok, status, data } = await mpGetPayment(dataId);
      if (!ok) {
        console.log("❌ Error consultando payment:", status, data);
        return;
      }

      // status puede ser: approved | pending | rejected | cancelled | refunded | etc.
      const mpStatus = data.status;

      // external_reference es el UUID que nosotros generamos al crear la preferencia
      const external_reference = data.external_reference;

      console.log("✅ PAYMENT recibido:", {
        payment_id: dataId,
        mpStatus,
        external_reference,
      });

      if (!external_reference) {
        console.log("⚠️ payment sin external_reference — no puedo actualizar DB");
        return;
      }

      // Actualizamos el estado en nuestra DB en memoria
      updatePayment(external_reference, {
        status: mpStatus,
        mp_payment_id: String(dataId),
      });

      return;
    }

    // ---------------------------------------------------
    // CASO B: type = "merchant_order"
    // Una "merchant_order" es la orden comercial que agrupa
    // todos los intentos de pago de una misma preferencia.
    // Puede tener 0 o más pagos dentro.
    // Consultamos la orden y luego el primer pago que encontremos.
    // ---------------------------------------------------
    if (type === "merchant_order") {
      const { ok, status, data } = await mpGetMerchantOrder(dataId);
      if (!ok) {
        console.log("❌ Error consultando merchant_order:", status, data);
        return;
      }

      // El campo payments dentro de la merchant_order contiene los intentos de pago
      const paymentsArr = Array.isArray(data.payments) ? data.payments : [];

      // Tomamos el primer pago que tenga ID
      const firstPayment = paymentsArr.find((p) => p?.id);

      console.log("✅ MERCHANT_ORDER recibida:", {
        merchant_order_id: dataId,
        payments_count: paymentsArr.length,
      });

      if (!firstPayment) {
        // Es normal que llegue una merchant_order antes de que haya pagos (el usuario aún no pagó)
        console.log("⚠️ merchant_order sin payments todavía (puede llegar antes del pago)");
        return;
      }

      // Consultamos los detalles del pago real para saber el estado
      const paymentId = firstPayment.id;
      const { ok: okPay, status: stPay, data: payData } = await mpGetPayment(paymentId);
      if (!okPay) {
        console.log("❌ Error consultando payment desde merchant_order:", stPay, payData);
        return;
      }

      const mpStatus = payData.status;
      const external_reference = payData.external_reference;

      console.log("✅ PAYMENT (desde merchant_order):", {
        payment_id: paymentId,
        mpStatus,
        external_reference,
      });

      if (!external_reference) {
        console.log("⚠️ payment sin external_reference — no puedo actualizar DB");
        return;
      }

      // Actualizamos el estado en nuestra DB en memoria
      updatePayment(external_reference, {
        status: mpStatus,
        mp_payment_id: String(paymentId),
      });

      return;
    }

    // Si el type no es ninguno de los anteriores, sólo lo logueamos
    console.log("ℹ️ Webhook type no manejado:", type);
  } catch (err) {
    console.error("❌ webhook error:", err);
  }
});

// -----------------------------------------------------------
// 3) GET /api/payment-status/:external_reference
//    Permite al frontend consultar el estado actual de un pago.
//    El frontend hace polling (pregunta cada N segundos) a este
//    endpoint hasta ver un estado final (approved/rejected/etc.)
// -----------------------------------------------------------
app.get("/api/payment-status/:external_reference", (req, res) => {
  const { external_reference } = req.params;
  const p = getPayment(external_reference);

  // Si no existe en nuestra DB, respondemos 404
  if (!p) return res.status(404).json({ error: "No existe" });

  // Devolvemos el objeto completo con status, mp_payment_id, etc.
  return res.json(p);
});

// -----------------------------------------------------------
// 4) GET /api/products
//    (Extra) Devuelve el catálogo de productos disponibles
//    para que el frontend pueda listarlos dinámicamente.
// -----------------------------------------------------------
app.get("/api/products", (req, res) => {
  // Devolvemos el catálogo completo con todos los campos
  return res.json(PRODUCT_CATALOG);
});

// -----------------------------------------------------------
// 5) GET /health
//    Endpoint de salud (healthcheck).
//    Útil para verificar que el servidor está corriendo.
// -----------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// SECCIÓN: Inicio del servidor
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("=================================================================");
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
  console.log("=================================================================");
  console.log("Variables de entorno:")
  console.log("  PUBLIC_BASE_URL =", PUBLIC_BASE_URL || "⚠️  NO DEFINIDA (webhooks no funcionarán)");
  console.log("  FRONT_BASE_URL  =", FRONT_BASE_URL  || "ℹ️  NO DEFINIDA (auto_return desactivado)");
  console.log("=================================================================");
  console.log("Catálogo de productos disponibles:");
  PRODUCT_CATALOG.forEach((p) =>
    console.log(`  [${p.id}] ${p.title} — ARS $${p.unit_price}`)
  );
  console.log("=================================================================\n");
});