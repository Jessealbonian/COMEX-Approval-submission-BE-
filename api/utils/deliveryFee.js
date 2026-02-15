const db = require("../database/db");

// Lazily ensure the orders table has a delivery_fee column (idempotent).
let ensuredDeliveryFeeColumn = false;
async function ensureDeliveryFeeColumnExists() {
  if (ensuredDeliveryFeeColumn) return;
  try {
    const [col] = await new Promise((resolve, reject) => {
      db.query(
        `SELECT COLUMN_NAME 
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_NAME = 'orders' 
           AND COLUMN_NAME = 'delivery_fee' 
           AND TABLE_SCHEMA = DATABASE()`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    if (!col) {
      await new Promise((resolve, reject) => {
        db.query(
          "ALTER TABLE orders ADD COLUMN delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 10",
          (err) => (err ? reject(err) : resolve(null))
        );
      });
    }
    ensuredDeliveryFeeColumn = true;
  } catch (err) {
    console.error("Failed to ensure delivery_fee column exists", err);
    // Do not throw here to avoid blocking checkout; fallback insert will still fail visibly.
  }
}

// Fetch the current delivery fee from canteen_status with a safe fallback.
async function getDeliveryFee() {
  try {
    const [row] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT delivery_fee FROM canteen_status WHERE id = 1",
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const fee =
      row && row.delivery_fee !== undefined && row.delivery_fee !== null
        ? parseFloat(row.delivery_fee)
        : 10.0;

    return Number.isFinite(fee) ? fee : 10.0;
  } catch (err) {
    console.error("Failed to load delivery fee, using fallback", err);
    return 10.0;
  }
}

module.exports = {
  getDeliveryFee,
  ensureDeliveryFeeColumnExists,
};

