const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");
const { createLog } = require("./logs");

// Offer configuration
const OFFER_TIMEOUT_MINUTES = 2; // auto-timeout window for unanswered offers
const ACTIVE_ORDER_STATUSES = ["pending", "preparing", "ready", "on_delivery"];

async function expireStaleOffersForOrder(orderId) {
  if (!orderId) return;
  try {
    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE volunteer_offers 
         SET status = 'timed_out', responded_at = IF(responded_at IS NULL, NOW(), responded_at)
         WHERE order_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
        [orderId],
        (err) => (err ? reject(err) : resolve(null))
      );
    });
  } catch (err) {
    console.error("Failed to expire stale offers for order", err);
  }
}

async function expireStaleOffersForVolunteer(volunteerId) {
  if (!volunteerId) return;
  try {
    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE volunteer_offers 
         SET status = 'timed_out', responded_at = IF(responded_at IS NULL, NOW(), responded_at)
         WHERE volunteer_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
        [volunteerId],
        (err) => (err ? reject(err) : resolve(null))
      );
    });
  } catch (err) {
    console.error("Failed to expire stale offers for volunteer", err);
  }
}

async function volunteerHasActivePersonalOrders(volunteerId) {
  if (!volunteerId) return false;
  const [row] = await new Promise((resolve, reject) => {
    db.query(
      `SELECT COUNT(*) AS cnt 
       FROM orders 
       WHERE student_id = ? AND status IN (?)`,
      [volunteerId, ACTIVE_ORDER_STATUSES],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
  return Number(row?.cnt || 0) > 0;
}

// Student/Volunteer: get my volunteer status and application
router.get(
  "/me",
  authGuard,
  requireRole("student", "volunteer"),
  async (req, res) => {
    try {
      const [user] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT user_id, role, status FROM users WHERE user_id = ?",
          [req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      let availability = null;
      let availabilityStartTime = null;
      let availabilityEndTime = null;
      if (user && user.role === "volunteer") {
        const [v] = await new Promise((resolve, reject) => {
          db.query(
            "SELECT is_available, availability_start_time, availability_end_time FROM volunteers WHERE user_id = ?",
            [req.user.id],
            (err, rows) => (err ? reject(err) : resolve(rows))
          );
        });
        availability = v ? !!v.is_available : false;
        availabilityStartTime = v?.availability_start_time || null;
        availabilityEndTime = v?.availability_end_time || null;
      }
      const [app] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT status FROM volunteer_applications WHERE user_id = ? ORDER BY applied_at DESC LIMIT 1",
          [req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      return res.json({
        role: user?.role,
        status: user?.status,
        is_available: availability,
        application_status: app?.status || null,
        availability_start_time: availabilityStartTime,
        availability_end_time: availabilityEndTime,
      });
    } catch (err) {
      console.error("Me failed", err);
      return res.status(500).json({ message: "Failed to load" });
    }
  }
);

// Student: apply to become volunteer
router.post("/apply", authGuard, requireRole("student"), async (req, res) => {
  try {
    // Insert application if none pending/existing
    const existing = await new Promise((resolve, reject) => {
      db.query(
        'SELECT * FROM volunteer_applications WHERE user_id = ? AND status = "pending"',
        [req.user.id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    if (existing.length > 0) {
      return res
        .status(400)
        .json({ message: "You already have a pending application." });
    }
    await new Promise((resolve, reject) => {
      db.query(
        'INSERT INTO volunteer_applications (user_id, status) VALUES (?, "pending")',
        [req.user.id],
        (err) => (err ? reject(err) : resolve(null))
      );
    });
    return res.status(201).json({ message: "Application submitted." });
  } catch (err) {
    console.error("Apply volunteer failed", err);
    return res.status(500).json({ message: "Failed to apply" });
  }
});

// Staff: list applications
router.get(
  "/applications",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const rows = await new Promise((resolve, reject) => {
        const q = `SELECT va.application_id, va.status, va.applied_at, u.user_id, u.name, u.email, u.department, u.phone_no
                 FROM volunteer_applications va JOIN users u ON u.user_id = va.user_id
                 ORDER BY va.applied_at DESC`;
        db.query(q, (err, rows) => (err ? reject(err) : resolve(rows)));
      });
      return res.json(rows);
    } catch (err) {
      console.error("Failed to list applications", err);
      return res.status(500).json({ message: "Failed to list applications" });
    }
  }
);

// Staff: approve
router.put(
  "/applications/:id/approve",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    const { id } = req.params;
    try {
      const [app] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT * FROM volunteer_applications WHERE application_id = ?",
          [id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      if (!app)
        return res.status(404).json({ message: "Application not found" });
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE volunteer_applications SET status = "approved" WHERE application_id = ?',
          [id],
          (err) => (err ? reject(err) : resolve(null))
        );
      });
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE users SET role = "volunteer", status = "approved" WHERE user_id = ?',
          [app.user_id],
          (err) => (err ? reject(err) : resolve(null))
        );
      });
      // Ensure volunteer availability record exists
      await new Promise((resolve, reject) => {
        db.query(
          "INSERT IGNORE INTO volunteers (user_id, is_available) VALUES (?, 0)",
          [app.user_id],
          (err) => (err ? reject(err) : resolve(null))
        );
      });
      // Log the volunteer approval
      await createLog(
        req.user.id,
        req.user.name,
        req.user.role,
        "VOLUNTEER_APPROVED",
        `Volunteer application approved for user ID ${app.user_id}`
      );

      return res.json({ message: "Application approved" });
    } catch (err) {
      console.error("Approve failed", err);
      return res.status(500).json({ message: "Failed to approve" });
    }
  }
);

// Staff: reject
router.put(
  "/applications/:id/reject",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    const { id } = req.params;
    try {
      const [app] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT * FROM volunteer_applications WHERE application_id = ?",
          [id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      if (!app)
        return res.status(404).json({ message: "Application not found" });
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE volunteer_applications SET status = "rejected" WHERE application_id = ?',
          [id],
          (err) => (err ? reject(err) : resolve(null))
        );
      });
      // Log the volunteer rejection
      await createLog(
        req.user.id,
        req.user.name,
        req.user.role,
        "VOLUNTEER_REJECTED",
        `Volunteer application rejected for user ID ${app.user_id}`
      );

      return res.json({ message: "Application rejected" });
    } catch (err) {
      console.error("Reject failed", err);
      return res.status(500).json({ message: "Failed to reject" });
    }
  }
);

// Volunteer: toggle availability
router.put(
  "/availability",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    const { is_available, availability_start_time, availability_end_time } = req.body;
    const val = is_available ? 1 : 0;
    
    // Log the incoming data for debugging
    console.log("Updating availability:", {
      user_id: req.user.id,
      is_available: val,
      availability_start_time,
      availability_end_time
    });
    
    try {
      await new Promise((resolve, reject) => {
        db.query(
          "INSERT INTO volunteers (user_id, is_available, availability_start_time, availability_end_time) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), availability_start_time = VALUES(availability_start_time), availability_end_time = VALUES(availability_end_time)",
          [req.user.id, val, availability_start_time || null, availability_end_time || null],
          (err, result) => {
            if (err) {
              console.error("Database query error:", err);
              console.error("Error code:", err.code);
              console.error("Error SQL state:", err.sqlState);
              console.error("Error message:", err.message);
              reject(err);
            } else {
              console.log("Database update successful");
              resolve(result);
            }
          }
        );
      });
      
      // Fetch the updated values from database to ensure accuracy
      const [updated] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT is_available, availability_start_time, availability_end_time FROM volunteers WHERE user_id = ?",
          [req.user.id],
          (err, rows) => {
            if (err) {
              console.error("Error fetching updated values:", err);
              reject(err);
            } else {
              console.log("Fetched updated values:", rows[0]);
              resolve(rows);
            }
          }
        );
      });
      
      return res.json({ 
        message: "Availability updated", 
        is_available: updated ? !!updated.is_available : false,
        availability_start_time: updated?.availability_start_time || null,
        availability_end_time: updated?.availability_end_time || null
      });
    } catch (err) {
      console.error("Availability update failed:", err);
      console.error("Full error object:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
      return res.status(500).json({ 
        message: "Failed to update availability",
        error: err.message || "Unknown error",
        code: err.code
      });
    }
  }
);

// Public: check if there is at least one available volunteer
router.get("/available", async (req, res) => {
  try {
    const [row] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as cnt FROM volunteers WHERE is_available = 1",
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    return res.json({ availableCount: row.cnt });
  } catch (err) {
    console.error("Check available failed", err);
    return res.status(500).json({ message: "Failed to check availability" });
  }
});

// Staff: list available volunteers
router.get("/list", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.query(
        "SELECT v.user_id, v.is_available, v.availability_start_time, v.availability_end_time, u.name, u.email, u.phone_no, u.department FROM volunteers v JOIN users u ON u.user_id = v.user_id WHERE v.is_available = 1",
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    return res.json(rows);
  } catch (err) {
    console.error("List volunteers failed", err);
    return res.status(500).json({ message: "Failed to list volunteers" });
  }
});

// Staff: assign a volunteer to an order with delivery
router.put("/assign", authGuard, requireRole("staff"), async (req, res) => {
  const { order_id, volunteer_id } = req.body;
  if (!order_id || !volunteer_id)
    return res
      .status(400)
      .json({ message: "order_id and volunteer_id required" });
  try {
    await expireStaleOffersForOrder(order_id);

    // validate order is delivery and unassigned
    const [order] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT delivery_option, status, volunteer_id FROM orders WHERE order_id = ?",
        [order_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.delivery_option !== "delivery")
      return res.status(400).json({ message: "Order is not for delivery" });
    if (order.volunteer_id && Number(order.volunteer_id) > 0) {
      return res
        .status(400)
        .json({ message: "Order is already assigned to a volunteer" });
    }
    if (
      !["ready", "on_delivery"].includes((order.status || "").toLowerCase())
    ) {
      return res
        .status(400)
        .json({
          message: "Order must be ready for delivery before sending offers",
        });
    }

    // validate volunteer availability
    const [volunteer] = await new Promise((resolve, reject) => {
      db.query(
        `SELECT v.is_available, u.name 
         FROM volunteers v 
         JOIN users u ON u.user_id = v.user_id 
         WHERE v.user_id = ?`,
        [volunteer_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    if (!volunteer)
      return res.status(404).json({ message: "Volunteer not found" });
    if (!volunteer.is_available) {
      return res
        .status(400)
        .json({ message: "Volunteer is not marked as available" });
    }
    const hasActivePersonalOrders = await volunteerHasActivePersonalOrders(
      volunteer_id
    );
    if (hasActivePersonalOrders) {
      return res.status(400).json({
        message:
          "Volunteer has active personal orders and cannot accept deliveries right now",
      });
    }

    // block if there's already a pending (non-expired) offer for this order
    const [existingOffer] = await new Promise((resolve, reject) => {
      db.query(
        `SELECT offer_id, status, expires_at 
         FROM volunteer_offers 
         WHERE order_id = ? AND status = 'pending' 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [order_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    if (existingOffer) {
      return res.status(400).json({
        message: "An offer is already pending for this order",
        offer_id: existingOffer.offer_id,
        expires_at: existingOffer.expires_at,
      });
    }

    // create a new offer instead of immediate assignment
    await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO volunteer_offers (order_id, volunteer_id, status, expires_at)
         VALUES (?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [order_id, volunteer_id, OFFER_TIMEOUT_MINUTES],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });

    await createLog(
      req.user.id,
      req.user.name,
      req.user.role,
      "VOLUNTEER_OFFER_SENT",
      `Offer sent to volunteer ${volunteer_id} for order #${order_id}`
    );

    return res.json({
      message: "Offer sent to volunteer",
      expires_in_minutes: OFFER_TIMEOUT_MINUTES,
    });
  } catch (err) {
    console.error("Assign volunteer failed", err);
    return res.status(500).json({ message: "Failed to assign volunteer" });
  }
});

// Volunteers: fetch the latest pending offer (if any) for the logged-in volunteer
router.get(
  "/offers/mine",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    try {
      await expireStaleOffersForVolunteer(req.user.id);

      const [offer] = await new Promise((resolve, reject) => {
        db.query(
          `SELECT vo.*, o.delivery_option, o.delivery_fee, o.preferred_time, o.delivery_room, o.status AS order_status,
                  u.name AS student_name, u.phone_no AS student_phone
           FROM volunteer_offers vo
           JOIN orders o ON o.order_id = vo.order_id
           JOIN users u ON u.user_id = o.student_id
           WHERE vo.volunteer_id = ? AND vo.status = 'pending'
           ORDER BY vo.created_at DESC
           LIMIT 1`,
          [req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      if (!offer) {
        return res.json(null);
      }

      // Fetch concise item summary and totals
      const items = await new Promise((resolve, reject) => {
        db.query(
          `SELECT oi.quantity, oi.price_each, p.product_name 
           FROM order_items oi 
           JOIN products p ON p.product_id = oi.product_id 
           WHERE oi.order_id = ?`,
          [offer.order_id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      const subtotal = items.reduce(
        (sum, it) => sum + Number(it.price_each) * Number(it.quantity),
        0
      );
      const delivery_fee =
        offer.delivery_fee !== undefined && offer.delivery_fee !== null
          ? Number(offer.delivery_fee)
          : offer.delivery_option === "delivery"
          ? 10
          : 0;
      const total = subtotal + delivery_fee;

      return res.json({
        ...offer,
        items,
        summary: { subtotal, delivery_fee, total },
      });
    } catch (err) {
      console.error("Failed to load volunteer offer", err);
      return res.status(500).json({ message: "Failed to load offer" });
    }
  }
);

// Volunteers: accept or decline an offer
router.put(
  "/offers/:id/respond",
  authGuard,
  requireRole("volunteer"),
  async (req, res) => {
    const { id } = req.params;
    const { action } = req.body || {};
    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ message: "Invalid action" });
    }

    try {
      await expireStaleOffersForVolunteer(req.user.id);

      const [offer] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT * FROM volunteer_offers WHERE offer_id = ? AND volunteer_id = ?",
          [id, req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      if (!offer) return res.status(404).json({ message: "Offer not found" });

      if (offer.status !== "pending") {
        return res.status(400).json({
          message: `Offer is already ${offer.status}`,
          status: offer.status,
        });
      }

      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        await expireStaleOffersForVolunteer(req.user.id);
        return res
          .status(400)
          .json({
            message: "Offer has already timed out",
            status: "timed_out",
          });
      }

      // Decline flow
      if (action === "decline") {
        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE volunteer_offers SET status = 'declined', responded_at = NOW() WHERE offer_id = ?",
            [id],
            (err) => (err ? reject(err) : resolve(null))
          );
        });

        await createLog(
          req.user.id,
          req.user.name,
          req.user.role,
          "VOLUNTEER_OFFER_DECLINED",
          `Volunteer declined offer ${id} for order #${offer.order_id}`
        );

        return res.json({ message: "Offer declined" });
      }

      // Accept flow
      const [volRow] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT is_available FROM volunteers WHERE user_id = ?",
          [req.user.id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      if (!volRow || !volRow.is_available) {
        return res
          .status(400)
          .json({ message: "You are not marked as available for delivery" });
      }

      const hasActivePersonalOrders = await volunteerHasActivePersonalOrders(
        req.user.id
      );
      if (hasActivePersonalOrders) {
        return res.status(400).json({
          message:
            "You still have active personal orders and cannot accept this delivery",
        });
      }

      // Ensure order is still eligible and unassigned
      const [order] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT status, delivery_option, volunteer_id FROM orders WHERE order_id = ?",
          [offer.order_id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }
      if (order.volunteer_id && Number(order.volunteer_id) > 0) {
        return res.status(400).json({
          message: "Order was already assigned to another volunteer",
        });
      }
      if (
        order.delivery_option !== "delivery" ||
        !["ready", "on_delivery"].includes((order.status || "").toLowerCase())
      ) {
        return res.status(400).json({
          message: "Order is not eligible for delivery assignment",
        });
      }

      // Assign atomically: accept offer and set volunteer_id on order
      await new Promise((resolve, reject) => {
        db.beginTransaction((err) => (err ? reject(err) : resolve(null)));
      });

      try {
        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE orders SET volunteer_id = ? WHERE order_id = ?",
            [req.user.id, offer.order_id],
            (err) => (err ? reject(err) : resolve(null))
          );
        });

        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE volunteer_offers SET status = 'accepted', responded_at = NOW() WHERE offer_id = ?",
            [id],
            (err) => (err ? reject(err) : resolve(null))
          );
        });

        // Time out any other pending offers for the same order
        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE volunteer_offers SET status = 'timed_out', responded_at = NOW() WHERE order_id = ? AND status = 'pending' AND offer_id <> ?",
            [offer.order_id, id],
            (err) => (err ? reject(err) : resolve(null))
          );
        });

        await new Promise((resolve, reject) => {
          db.commit((err) => (err ? reject(err) : resolve(null)));
        });
      } catch (err) {
        await new Promise((resolve) => db.rollback(() => resolve(null)));
        throw err;
      }

      await createLog(
        req.user.id,
        req.user.name,
        req.user.role,
        "VOLUNTEER_OFFER_ACCEPTED",
        `Volunteer accepted offer ${id} for order #${offer.order_id}`
      );

      return res.json({ message: "Offer accepted and order assigned" });
    } catch (err) {
      console.error("Failed to respond to offer", err);
      return res.status(500).json({ message: "Failed to process response" });
    }
  }
);

module.exports = router;

