const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");
const { createLog } = require("./logs");
const { recordInventoryLog } = require("../utils/inventoryLogs");
const { getDeliveryFee, ensureDeliveryFeeColumnExists } = require("../utils/deliveryFee");

// Helper: start a transaction (promise-based)
function beginTransaction() {
  return new Promise((resolve, reject) => {
    db.beginTransaction((err) => (err ? reject(err) : resolve()));
  });
}

function commit() {
  return new Promise((resolve, reject) => {
    db.commit((err) => (err ? reject(err) : resolve()));
  });
}

function rollback() {
  return new Promise((resolve) => {
    db.rollback(() => resolve());
  });
}

// POST /orders/checkout - create order, reduce stock
router.post(
  "/checkout",
  authGuard,
  requireRole("student", "volunteer"),
  async (req, res) => {
    const { items, delivery_option, delivery_room } = req.body;
    let { preferred_time } = req.body;

    // Check if canteen is active
    try {
      const [canteenStatus] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT is_active FROM canteen_status WHERE id = 1",
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      if (!canteenStatus || !canteenStatus.is_active) {
        return res.status(403).json({
          message: "Canteen is currently inactive and not accepting orders",
        });
      }
    } catch (err) {
      console.error("Error checking canteen status:", err);
      return res
        .status(500)
        .json({ message: "Failed to check canteen status" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items to checkout" });
    }
    if (!["pickup", "delivery"].includes(delivery_option)) {
      return res.status(400).json({ message: "Invalid delivery option" });
    }
    // Normalize preferred_time: accept 'HH:MM', 'HH:MM:SS', or 'hh:mm AM'
    const normalizeTime = (input) => {
      if (!input) return null;
      try {
        // Already TIME-like
        if (/^\d{2}:\d{2}(:\d{2})?$/.test(input)) {
          return input.length === 5 ? input + ":00" : input;
        }
        // Label like '08:30 AM'
        const m = input.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (m) {
          let h = parseInt(m[1], 10);
          const min = m[2];
          const ampm = m[3].toUpperCase();
          if (ampm === "PM" && h !== 12) h += 12;
          if (ampm === "AM" && h === 12) h = 0;
          const hh = h.toString().padStart(2, "0");
          return `${hh}:${min}:00`;
        }
      } catch (_) {}
      return null;
    };
    preferred_time = normalizeTime(preferred_time);
    try {
      await beginTransaction();
      await ensureDeliveryFeeColumnExists();

      const productSnapshots = new Map();

      // Validate stock
      for (const item of items) {
        const quantity = Number(item.quantity) || 0;

        const [row] = await new Promise((resolve, reject) => {
          db.query(
            "SELECT stock, price, product_name FROM products WHERE product_id = ?",
            [item.product_id],
            (err, rows) => {
              if (err) return reject(err);
              resolve(rows);
            }
          );
        });
        if (!row) {
          await rollback();
          return res
            .status(404)
            .json({ message: `Product not found: ${item.product_id}` });
        }
        if (row.stock < quantity) {
          await rollback();
          return res.status(400).json({
            message: `Insufficient stock for product ${item.product_id}`,
          });
        }
        // default the price_each to current price if not sent
        if (!item.price_each) item.price_each = Number(row.price);

        if (!productSnapshots.has(item.product_id)) {
          productSnapshots.set(item.product_id, {
            productName: row.product_name,
            remainingStock: Number(row.stock) || 0,
          });
        }

        item.quantity = quantity;
      }

      // Create order
      // Capture delivery fee at time of checkout so historical orders are not affected by future changes.
      const currentDeliveryFee = await getDeliveryFee();
      const delivery_fee_value =
        delivery_option === "delivery" ? currentDeliveryFee : 0;

      const orderInsert = await new Promise((resolve, reject) => {
        const q =
          "INSERT INTO orders (student_id, status, delivery_option, preferred_time, delivery_room, delivery_fee) VALUES (?, ?, ?, ?, ?, ?)";
        db.query(
          q,
          [
            req.user.id,
            "pending",
            delivery_option,
            preferred_time || null,
            delivery_room || null,
            delivery_fee_value,
          ],
          (err, result) => {
            if (err) return reject(err);
            resolve(result);
          }
        );
      });

      const orderId = orderInsert.insertId;

      // Insert items and reduce stock
      for (const item of items) {
        await new Promise((resolve, reject) => {
          const q =
            "INSERT INTO order_items (order_id, product_id, quantity, price_each) VALUES (?, ?, ?, ?)";
          db.query(
            q,
            [orderId, item.product_id, item.quantity, item.price_each],
            (err) => {
              if (err) return reject(err);
              resolve(null);
            }
          );
        });
        await new Promise((resolve, reject) => {
          const q =
            "UPDATE products SET stock = stock - ? WHERE product_id = ?";
          db.query(q, [item.quantity, item.product_id], (err) => {
            if (err) return reject(err);
            resolve(null);
          });
        });

        const snapshot = productSnapshots.get(item.product_id);
        let finalStock = null;
        let productName = item.product_name;

        if (snapshot) {
          finalStock = (snapshot.remainingStock || 0) - item.quantity;
          snapshot.remainingStock = finalStock;
          productName = snapshot.productName || productName;
        }

        recordInventoryLog({
          productId: item.product_id,
          productName:
            productName ||
            `Product ID ${String(item.product_id).padStart(3, "0")}`,
          actionType: "issued",
          quantityChange: -Math.abs(item.quantity || 0),
          finalStock,
          userId: req.user?.id || null,
          userName: req.user?.name || null,
        });
      }

      await commit();

      // Log the order creation
      const itemDetails = items
        .map(
          (item) =>
            `${item.quantity}x ${
              item.product_name || `Product ID ${item.product_id}`
            }`
        )
        .join(", ");
      await createLog(
        req.user.id,
        req.user.name,
        req.user.role,
        "ORDER_CREATED",
        `Order #${orderId} created with items: ${itemDetails}. Delivery: ${delivery_option}${
          delivery_room ? ` to ${delivery_room}` : ""
        }`
      );

      return res.status(201).json({ order_id: orderId });
    } catch (err) {
      console.error("Checkout failed", err);
      await rollback();
      return res.status(500).json({ message: "Checkout failed" });
    }
  }
);

// GET /orders/my - list current student's orders with items
router.get(
  "/my",
  authGuard,
  requireRole("student", "volunteer"),
  async (req, res) => {
    try {
      const orders = await new Promise((resolve, reject) => {
        const q =
          "SELECT * FROM orders WHERE student_id = ? ORDER BY created_at DESC";
        db.query(q, [req.user.id], (err, rows) =>
          err ? reject(err) : resolve(rows)
        );
      });
      const orderIds = orders.map((o) => o.order_id);
      let items = [];
      if (orderIds.length > 0) {
        items = await new Promise((resolve, reject) => {
          const q = `SELECT oi.*, p.product_name, c.category_name
                   FROM order_items oi
                   JOIN products p ON p.product_id = oi.product_id
                   LEFT JOIN categories c ON c.category_id = p.category_id
                   WHERE oi.order_id IN (?)`;
          db.query(q, [orderIds], (err, rows) =>
            err ? reject(err) : resolve(rows)
          );
        });
      }
      const orderIdToItems = new Map();
      for (const it of items) {
        if (!orderIdToItems.has(it.order_id))
          orderIdToItems.set(it.order_id, []);
        orderIdToItems.get(it.order_id).push(it);
      }
      const withSummary = orders.map((o) => {
        const its = orderIdToItems.get(o.order_id) || [];
        const subtotal = its.reduce(
          (s, it) => (s += Number(it.price_each) * Number(it.quantity)),
          0
        );
        const delivery_fee =
          o.delivery_fee !== undefined && o.delivery_fee !== null
            ? Number(o.delivery_fee)
            : o.delivery_option === "delivery"
            ? 10
            : 0;
        const total = subtotal + delivery_fee;
        return { ...o, items: its, summary: { subtotal, delivery_fee, total } };
      });
      return res.json(withSummary);
    } catch (err) {
      console.error("Failed to load orders", err);
      return res.status(500).json({ message: "Failed to load orders" });
    }
  }
);

// Staff: list orders
router.get("/", authGuard, requireRole("staff"), async (req, res) => {
  try {
    // Mark any expired pending offers as timed out before returning data
    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE volunteer_offers 
         SET status = 'timed_out', responded_at = IF(responded_at IS NULL, NOW(), responded_at)
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
        (err) => (err ? reject(err) : resolve(null))
      );
    });

    const orders = await new Promise((resolve, reject) => {
      const q = `SELECT o.*, u.name, u.email, u.department, u.phone_no
                 , vuser.name AS volunteer_name
                 , vo.offer_id AS current_offer_id
                 , vo.offer_status AS current_offer_status
                 , vo.offer_volunteer_id
                 , vo.offer_volunteer_name
                 , vo.offer_created_at
                 , vo.expires_at AS offer_expires_at
                 FROM orders o 
                 JOIN users u ON u.user_id = o.student_id
                 LEFT JOIN users vuser ON vuser.user_id = o.volunteer_id
                 LEFT JOIN (
                   SELECT vo.order_id,
                          vo.offer_id,
                          vo.status AS offer_status,
                          vo.volunteer_id AS offer_volunteer_id,
                          vo.created_at AS offer_created_at,
                          vo.expires_at,
                          vu.name AS offer_volunteer_name
                   FROM volunteer_offers vo
                   JOIN (
                     SELECT order_id, MAX(created_at) AS latest_created
                     FROM volunteer_offers
                     GROUP BY order_id
                   ) latest ON latest.order_id = vo.order_id AND latest.latest_created = vo.created_at
                   LEFT JOIN users vu ON vu.user_id = vo.volunteer_id
                 ) vo ON vo.order_id = o.order_id
                 ORDER BY o.created_at DESC`;
      db.query(q, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    return res.json(orders);
  } catch (err) {
    console.error("Failed to list orders", err);
    return res.status(500).json({ message: "Failed to list orders" });
  }
});

// Volunteers: list orders that need pickup/delivery (ready or on_delivery) - ONLY assigned to this volunteer
router.get(
  "/for-delivery",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    try {
      const orders = await new Promise((resolve, reject) => {
        const q = `SELECT o.*, u.name, u.email, u.department, u.phone_no
                 FROM orders o JOIN users u ON u.user_id = o.student_id
                 WHERE o.status IN ('ready','on_delivery') AND o.delivery_option = 'delivery' AND o.volunteer_id = ? AND o.volunteer_id > 0
                 ORDER BY o.created_at DESC`;
        db.query(q, [req.user.id], (err, rows) =>
          err ? reject(err) : resolve(rows)
        );
      });
      return res.json(orders);
    } catch (err) {
      console.error("Failed to list for-delivery orders", err);
      return res.status(500).json({ message: "Failed to list orders" });
    }
  }
);

// Volunteers: get order details (same as staff but limited fields ok to reuse) - ONLY if assigned to this volunteer
router.get(
  "/for-delivery/:id",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    const { id } = req.params;
    try {
      const [order] = await new Promise((resolve, reject) => {
        const q = `SELECT o.*, u.name, u.email, u.department, u.phone_no
                 FROM orders o JOIN users u ON u.user_id = o.student_id
                 WHERE o.order_id = ? AND o.volunteer_id = ? AND o.volunteer_id > 0`;
        db.query(q, [id, req.user.id], (err, rows) =>
          err ? reject(err) : resolve(rows)
        );
      });
      if (!order)
        return res
          .status(404)
          .json({ message: "Order not found or not assigned to you" });
      const items = await new Promise((resolve, reject) => {
        const q = `SELECT oi.*, p.product_name, c.category_name
                 FROM order_items oi
                 JOIN products p ON p.product_id = oi.product_id
                 LEFT JOIN categories c ON c.category_id = p.category_id
                 WHERE oi.order_id = ?`;
        db.query(q, [id], (err, rows) => (err ? reject(err) : resolve(rows)));
      });
      const subtotal = items.reduce(
        (s, it) => (s += Number(it.price_each) * Number(it.quantity)),
        0
      );
      const delivery_fee =
        order.delivery_fee !== undefined && order.delivery_fee !== null
          ? Number(order.delivery_fee)
          : order.delivery_option === "delivery"
          ? 10
          : 0;
      const total = subtotal + delivery_fee;
      return res.json({
        ...order,
        items,
        summary: { subtotal, delivery_fee, total },
      });
    } catch (err) {
      console.error("Failed to get order", err);
      return res.status(500).json({ message: "Failed to get order" });
    }
  }
);

// Volunteers: mark delivered (only allowed transition from ready/on_delivery to delivered) - ONLY if assigned to this volunteer
router.put(
  "/:id/complete",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    const { id } = req.params;
    const { amount_given } = req.body;

    // Validate amount_given is provided
    if (!amount_given || amount_given <= 0) {
      return res.status(400).json({
        message:
          "Amount given is required and must be greater than 0 when completing an order",
      });
    }

    // Validate amount_given is a valid number
    const amountGivenNum = parseFloat(amount_given);
    if (isNaN(amountGivenNum) || amountGivenNum <= 0) {
      return res.status(400).json({
        message: "Amount given must be a valid positive number",
      });
    }

    try {
      const [order] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT status, delivery_option, delivery_fee FROM orders WHERE order_id = ? AND volunteer_id = ? AND volunteer_id > 0",
          [id, req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      if (!order)
        return res
          .status(404)
          .json({ message: "Order not found or not assigned to you" });
      if (!["ready", "on_delivery"].includes(order.status)) {
        return res
          .status(400)
          .json({ message: "Order is not ready for completion" });
      }

      // Get order items to calculate total
      const items = await new Promise((resolve, reject) => {
        db.query(
          "SELECT * FROM order_items WHERE order_id = ?",
          [id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      const subtotal = items.reduce(
        (s, it) => (s += Number(it.price_each) * Number(it.quantity)),
        0
      );
      const delivery_fee =
        order.delivery_fee !== undefined && order.delivery_fee !== null
          ? Number(order.delivery_fee)
          : order.delivery_option === "delivery"
          ? 10
          : 0;
      const total = subtotal + delivery_fee;
      const change = amountGivenNum - total;

      if (change < 0) {
        return res.status(400).json({
          message: `Amount given (₱${amountGivenNum.toFixed(
            2
          )}) is less than the total order amount (₱${total.toFixed(2)})`,
        });
      }

      await new Promise((resolve, reject) => {
        db.query(
          "UPDATE orders SET status = ?, amount_given = ?, `change` = ? WHERE order_id = ?",
          ["delivered", amountGivenNum, change, id],
          (err) => (err ? reject(err) : resolve(null))
        );
      });
      return res.json({ message: "Order marked as completed", change: change });
    } catch (err) {
      console.error("Failed to complete order", err);
      return res.status(500).json({ message: "Failed to complete order" });
    }
  }
);

// Staff: order details with items and student info
router.get("/:id", authGuard, requireRole("staff"), async (req, res) => {
  const { id } = req.params;
  try {
    const [order] = await new Promise((resolve, reject) => {
      const q = `SELECT o.*, u.name, u.email, u.department, u.phone_no
                 FROM orders o JOIN users u ON u.user_id = o.student_id
                 WHERE o.order_id = ?`;
      db.query(q, [id], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    const items = await new Promise((resolve, reject) => {
      const q = `SELECT oi.*, p.product_name, c.category_name
                 FROM order_items oi
                 JOIN products p ON p.product_id = oi.product_id
                 LEFT JOIN categories c ON c.category_id = p.category_id
                 WHERE oi.order_id = ?`;
      db.query(q, [id], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    const subtotal = items.reduce(
      (s, it) => (s += Number(it.price_each) * Number(it.quantity)),
      0
    );
    const delivery_fee =
      order.delivery_fee !== undefined && order.delivery_fee !== null
        ? Number(order.delivery_fee)
        : order.delivery_option === "delivery"
        ? 10
        : 0;
    const total = subtotal + delivery_fee;
    return res.json({
      ...order,
      items,
      summary: { subtotal, delivery_fee, total },
    });
  } catch (err) {
    console.error("Failed to get order", err);
    return res.status(500).json({ message: "Failed to get order" });
  }
});

// Staff: update status
router.put("/:id/status", authGuard, requireRole("staff"), async (req, res) => {
  const { id } = req.params;
  const { status, amount_given, cancellation_reason } = req.body;
  const allowed = [
    "pending",
    "preparing",
    "ready",
    "on_delivery",
    "delivered",
    "cancelled",
  ];
  if (!allowed.includes(status))
    return res.status(400).json({ message: "Invalid status" });

  const cancellationReason =
    typeof cancellation_reason === "string" ? cancellation_reason.trim() : "";

  // Validate amount_given when status is 'delivered'
  if (status === "delivered") {
    if (!amount_given || amount_given <= 0) {
      return res.status(400).json({
        message:
          "Amount given is required and must be greater than 0 when completing an order",
      });
    }

    // Validate amount_given is a valid number
    const amountGivenNum = parseFloat(amount_given);
    if (isNaN(amountGivenNum) || amountGivenNum <= 0) {
      return res.status(400).json({
        message: "Amount given must be a valid positive number",
      });
    }

    // Get order total to calculate change
    const items = await new Promise((resolve, reject) => {
      db.query(
        "SELECT oi.*, o.delivery_option, o.delivery_fee FROM order_items oi JOIN orders o ON o.order_id = oi.order_id WHERE oi.order_id = ?",
        [id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    }).catch((err) => {
      console.error("Failed to get order items", err);
      return [];
    });

    if (items.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const subtotal = items.reduce(
      (s, it) => (s += Number(it.price_each) * Number(it.quantity)),
      0
    );
    const delivery_fee =
      items[0].delivery_fee !== undefined && items[0].delivery_fee !== null
        ? Number(items[0].delivery_fee)
        : items[0].delivery_option === "delivery"
        ? 10
        : 0;
    const total = subtotal + delivery_fee;
    const change = amountGivenNum - total;

    if (change < 0) {
      return res.status(400).json({
        message: `Amount given (₱${amountGivenNum.toFixed(
          2
        )}) is less than the total order amount (₱${total.toFixed(2)})`,
      });
    }

    // Update order with status, amount_given, and change
    await new Promise((resolve, reject) => {
      db.query(
        "UPDATE orders SET status = ?, amount_given = ?, `change` = ?, cancellation_reason = NULL WHERE order_id = ?",
        [status, amountGivenNum, change, id],
        (err, result) => {
          if (err) return reject(err);
          if (result.affectedRows === 0)
            return reject(new Error("Order not found"));
          resolve(null);
        }
      );
    });

    // Add a log entry for the status change
    const logDetails = `Staff updated order #${id} status to ${status}. Amount given: ₱${amountGivenNum.toFixed(
      2
    )}, Change: ₱${change.toFixed(2)}.`;

    await createLog(
      req.user.id,
      req.user.name,
      req.user.role,
      "ORDER_STATUS_UPDATED",
      logDetails
    );

    return res.json({ message: "Status updated", change: change });
  }

  try {
    if (status === "cancelled") {
      if (!cancellationReason) {
        return res.status(400).json({
          message: "Cancellation reason is required when cancelling an order",
        });
      }

      await beginTransaction();

      // Check current order status before cancelling
      const [order] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT status FROM orders WHERE order_id = ?",
          [id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      if (!order) {
        await rollback();
        return res.status(404).json({ message: "Order not found" });
      }

      // Prevent cancelling an order that is already delivered or cancelled
      if (["delivered", "cancelled"].includes(order.status)) {
        await rollback();
        return res.status(400).json({
          message: `Cannot cancel an order that is already ${order.status}`,
        });
      }

      // Get order items and restock them
      const items = await new Promise((resolve, reject) => {
        db.query(
          "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
          [id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      for (const item of items) {
        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE products SET stock = stock + ? WHERE product_id = ?",
            [item.quantity, item.product_id],
            (err) => (err ? reject(err) : resolve(null))
          );
        });
      }
      await new Promise((resolve, reject) => {
        db.query(
          "UPDATE orders SET status = ?, cancellation_reason = ?, amount_given = NULL, `change` = NULL WHERE order_id = ?",
          [status, cancellationReason, id],
          (err, result) => {
            if (err) return reject(err);
            if (result.affectedRows === 0)
              return reject(new Error("Order not found"));
            resolve(null);
          }
        );
      });

      await commit();
    } else {
      // Update order status for all non-cancelled cases (non-delivered)
      await new Promise((resolve, reject) => {
        db.query(
          "UPDATE orders SET status = ?, cancellation_reason = NULL WHERE order_id = ?",
          [status, id],
          (err, result) => {
            if (err) return reject(err);
            if (result.affectedRows === 0)
              return reject(new Error("Order not found"));
            resolve(null);
          }
        );
      });
    }

    // Add a log entry for the status change
    const logAction =
      status === "cancelled" ? "ORDER_CANCELLED" : "ORDER_STATUS_UPDATED";
    const logDetails =
      status === "cancelled"
        ? `Staff cancelled order #${id} and restocked items. Reason: ${cancellationReason}`
        : `Staff updated order #${id} status to ${status}.`;

    await createLog(
      req.user.id,
      req.user.name,
      req.user.role,
      logAction,
      logDetails
    );

    return res.json({ message: "Status updated" });
  } catch (err) {
    if (status === "cancelled") {
      await rollback();
    }
    console.error("Failed to update status", err);
    return res.status(500).json({ message: "Failed to update status" });
  }
});

module.exports = router;
