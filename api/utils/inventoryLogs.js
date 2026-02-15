const db = require("../database/db");

let inventoryLogTableEnsured = false;

const ensureInventoryLogTable = () => {
  if (inventoryLogTableEnsured) {
    return Promise.resolve();
  }

  const query = `
    CREATE TABLE IF NOT EXISTS inventory_logs (
      log_id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NULL,
      product_name VARCHAR(255) NOT NULL,
      action_type VARCHAR(50) NOT NULL,
      quantity_change INT NOT NULL,
      final_stock INT NULL,
      user_id INT NULL,
      user_name VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_inventory_logs_product
        FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON DELETE SET NULL,
      CONSTRAINT fk_inventory_logs_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE SET NULL
    ) ENGINE=InnoDB`;

  return new Promise((resolve, reject) => {
    db.query(query, (error) => {
      if (error) {
        return reject(error);
      }
      inventoryLogTableEnsured = true;
      resolve();
    });
  });
};

const recordInventoryLog = async ({
  productId = null,
  productName = null,
  actionType,
  quantityChange,
  finalStock = null,
  userId = null,
  userName = null,
}) => {
  try {
    await ensureInventoryLogTable();

    const insertQuery = `
      INSERT INTO inventory_logs
        (product_id, product_name, action_type, quantity_change, final_stock, user_id, user_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    return await new Promise((resolve, reject) => {
      db.query(
        insertQuery,
        [
          productId,
          productName,
          actionType,
          quantityChange,
          finalStock,
          userId,
          userName,
        ],
        (error) => {
          if (error) {
            return reject(error);
          }
          resolve();
        }
      );
    });
  } catch (error) {
    console.error("Error recording inventory log:", error);
  }
};

module.exports = {
  ensureInventoryLogTable,
  recordInventoryLog,
};

