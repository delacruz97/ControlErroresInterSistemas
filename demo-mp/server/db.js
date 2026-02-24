// =============================================================================
// server/db.js
// Capa de persistencia en memoria (demo / desarrollo)
// -----------------------------------------------------------------------------
// En producción reemplazarías este módulo por una base de datos real:
//   - PostgreSQL / MySQL   → usando Prisma, Sequelize, pg, etc.
//   - MongoDB              → usando Mongoose o el driver nativo
//   - Redis                → para almacenamiento temporal rápido
//
// Actualmente guarda los pagos en un Map de JavaScript (RAM).
// Eso significa que los datos se pierden cuando reinicias el servidor.
// Para este demo alcanza y sobra.
// =============================================================================

// ---------------------------------------------------------------------------
// SECCIÓN: Almacenamiento principal
// ---------------------------------------------------------------------------

// Map es una estructura clave-valor de JavaScript.
// Clave   : external_reference (UUID único por pago)
// Valor   : objeto con todos los datos del pago
//
// Ciclo de vida del status de un pago:
//   created   → el usuario inició el proceso (preferencia creada)
//   pending   → el pago está pendiente de acreditación (ej: transferencia)
//   approved  → el pago fue aprobado y acreditado
//   rejected  → el pago fue rechazado (fondos insuficientes, etc.)
//   cancelled → el usuario canceló el pago
//   failed    → error genérico en el proceso de pago
const payments = new Map();

// ---------------------------------------------------------------------------
// SECCIÓN: Funciones de acceso a datos (CRUD simplificado)
// ---------------------------------------------------------------------------

/**
 * createPayment — Crea un nuevo registro de pago en la DB.
 * -------------------------------------------------------------
 * Se llama DESPUÉS de que Mercado Pago responde OK a la creación
 * de la preferencia. En este momento el usuario aún NO pagó, por
 * eso el estado inicial es "created".
 *
 * @param {object} param0
 * @param {string} param0.external_reference
 *   UUID único que generamos nosotros para identificar la orden.
 *   MP lo devuelve en el webhook y en las back_urls.
 * @param {string} param0.preference_id
 *   ID de la preferencia que asignó MP al crearla.
 * @param {number} param0.amount
 *   Monto total de la compra (quantity × unit_price).
 *
 * @returns {object} El objeto de pago recién creado.
 */
function createPayment({ external_reference, preference_id, amount }) {
  payments.set(external_reference, {
    external_reference,  // Nuestra referencia interna (UUID)
    preference_id,       // ID de la preferencia en el sistema de MP
    amount,              // Monto total en ARS
    status: "created",   // Estado inicial; cambia cuando MP envía webhook
    mp_payment_id: null, // ID del pago en MP; se llena al recibir el webhook
    updatedAt: new Date().toISOString(), // Timestamp de la última modificación
  });

  return payments.get(external_reference);
}

/**
 * updatePayment — Actualiza campos de un pago existente.
 * -------------------------------------------------------------
 * Se llama cuando llega un webhook de MP con el nuevo estado del pago.
 *
 * Incluye una regla de idempotencia:
 *   Si el pago ya está en "approved", NO lo actualizamos a otro estado.
 *   Esto previene race conditions si los webhooks llegan en desorden.
 *
 * @param {string} external_reference - UUID del pago a actualizar.
 * @param {object} patch              - Campos a sobreescribir.
 *   Ejemplo: { status: "approved", mp_payment_id: "123456789" }
 *
 * @returns {object|null} El objeto de pago actualizado, o null si no existe.
 */
function updatePayment(external_reference, patch) {
  // Si no existe el pago, devolvemos null
  const curr = payments.get(external_reference);
  if (!curr) return null;

  // Regla de idempotencia:
  // Un pago "approved" no puede retroceder a otro estado.
  // Esto protege contra webhooks tardíos o duplicados.
  if (curr.status === "approved" && patch.status && patch.status !== "approved") {
    console.log(
      `⚠️  Idempotencia: pago ${external_reference} ya está approved, ignorando patch`,
      patch
    );
    return curr;
  }

  // Construimos el nuevo objeto mezclando el registro actual con el patch
  const next = {
    ...curr,
    ...patch,
    updatedAt: new Date().toISOString(), // Actualizamos el timestamp
  };

  payments.set(external_reference, next);
  return next;
}

/**
 * getPayment — Obtiene los datos de un pago por su external_reference.
 * -------------------------------------------------------------
 * Lo usa el endpoint GET /api/payment-status/:external_reference
 * para que el frontend pueda consultar el estado actual del pago.
 *
 * @param {string} external_reference - UUID del pago.
 * @returns {object|null} El objeto de pago, o null si no existe.
 */
function getPayment(external_reference) {
  return payments.get(external_reference) || null;
}

// ---------------------------------------------------------------------------
// SECCIÓN: Exportaciones
// ---------------------------------------------------------------------------
// Exportamos las tres funciones para que index.js pueda usarlas.
module.exports = { createPayment, updatePayment, getPayment };
