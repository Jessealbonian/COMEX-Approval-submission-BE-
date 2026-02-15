const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");

// GET /api/dashboard/stats - Get dashboard statistics for staff
router.get(
  "/dashboard/stats",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      // Get pending orders count (including "pending" and "preparing" statuses)
      const [pendingOrders] = await new Promise((resolve, reject) => {
        db.query(
          'SELECT COUNT(*) as count FROM orders WHERE status IN ("pending", "preparing")',
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get ready for pickup orders count (including "ready" and "Ready For Pickup/Delivery")
      const [readyOrders] = await new Promise((resolve, reject) => {
        db.query(
          'SELECT COUNT(*) as count FROM orders WHERE status IN ("ready", "Ready For Pickup/Delivery")',
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get active menu items count
      const [activeItems] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT COUNT(*) as count FROM products WHERE is_deleted = FALSE OR is_deleted IS NULL",
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get low stock items count (stock <= 5)
      const [lowStockItems] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT COUNT(*) as count FROM products WHERE stock <= 5 AND (is_deleted = FALSE OR is_deleted IS NULL)",
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get active volunteers count
      const [activeVolunteers] = await new Promise((resolve, reject) => {
        db.query(
          "SELECT COUNT(*) as count FROM volunteers WHERE is_available = 1",
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get today's deliveries count
      const [todayDeliveries] = await new Promise((resolve, reject) => {
        db.query(
          'SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE() AND delivery_option = "delivery"',
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get today's revenue and orders count
      const [todayStats] = await new Promise((resolve, reject) => {
        db.query(
          `
        SELECT 
          COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue_items,
          COALESCE(SUM(CASE WHEN o.delivery_option = "delivery" THEN COALESCE(o.delivery_fee,0) ELSE 0 END), 0) as revenue_delivery,
          COUNT(DISTINCT o.order_id) as order_count
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        WHERE DATE(o.created_at) = CURDATE() 
        AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
      `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get top selling category today
      const [topCategory] = await new Promise((resolve, reject) => {
        db.query(
          `
        SELECT c.category_name, COUNT(*) as count
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN products p ON oi.product_id = p.product_id
        JOIN categories c ON p.category_id = c.category_id
        WHERE DATE(o.created_at) = CURDATE() 
        AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
        GROUP BY c.category_id, c.category_name
        ORDER BY count DESC
        LIMIT 1
      `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get top selling item today
      const [topItem] = await new Promise((resolve, reject) => {
        db.query(
          `
        SELECT p.product_name, COUNT(*) as count
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN products p ON oi.product_id = p.product_id
        WHERE DATE(o.created_at) = CURDATE() 
        AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
        GROUP BY p.product_id, p.product_name
        ORDER BY count DESC
        LIMIT 1
      `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const todayRev =
        parseFloat(todayStats.revenue_items) +
        parseFloat(todayStats.revenue_delivery);
      const todayOrderCount = parseInt(todayStats.order_count);
      const todayRevenueWithDelivery = todayRev;
      const topCategoryName =
        topCategory && topCategory.length > 0
          ? topCategory[0].category_name
          : "None";
      const topItemName =
        topItem && topItem.length > 0 ? topItem[0].product_name : "None";

      return res.json({
        pendingOrders: pendingOrders.count,
        readyOrders: readyOrders.count,
        activeItems: activeItems.count,
        lowStockItems: lowStockItems.count,
        activeVolunteers: activeVolunteers.count,
        todayDeliveries: todayDeliveries.count,
        todayRevenue: todayRevenueWithDelivery,
        todayOrders: todayOrderCount,
        topSellingCategory: topCategoryName,
        topSellingItem: topItemName,
      });
    } catch (err) {
      console.error("Failed to get dashboard stats", err);
      return res
        .status(500)
        .json({ message: "Failed to get dashboard statistics" });
    }
  }
);

// GET /api/canteen/status - Get canteen status
router.get("/canteen/status", async (req, res) => {
  try {
    const [status] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT is_active, delivery_fee FROM canteen_status WHERE id = 1",
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });

    return res.json({
      isActive: !!status?.is_active,
      deliveryFee: status?.delivery_fee
        ? parseFloat(status.delivery_fee)
        : 10.0,
    });
  } catch (err) {
    console.error("Failed to get canteen status", err);
    return res.status(500).json({ message: "Failed to get canteen status" });
  }
});

// GET /api/delivery-fee - Get delivery fee (public endpoint for students)
router.get("/delivery-fee", async (req, res) => {
  try {
    const [status] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT delivery_fee FROM canteen_status WHERE id = 1",
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });

    return res.json({
      deliveryFee: status?.delivery_fee
        ? parseFloat(status.delivery_fee)
        : 10.0,
    });
  } catch (err) {
    console.error("Failed to get delivery fee", err);
    return res.status(500).json({ message: "Failed to get delivery fee" });
  }
});

// PUT /api/delivery-fee - Update delivery fee (staff only)
router.put(
  "/delivery-fee",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    const { deliveryFee } = req.body;

    if (typeof deliveryFee !== "number" || deliveryFee < 0) {
      return res
        .status(400)
        .json({ message: "deliveryFee must be a non-negative number" });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          "UPDATE canteen_status SET delivery_fee = ?, updated_by = ? WHERE id = 1",
          [deliveryFee, req.user.id],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      return res.json({
        message: "Delivery fee updated successfully",
        deliveryFee,
      });
    } catch (err) {
      console.error("Failed to update delivery fee", err);
      return res.status(500).json({ message: "Failed to update delivery fee" });
    }
  }
);

// PUT /api/canteen/status - Update canteen status (staff only)
router.put(
  "/canteen/status",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be a boolean" });
    }

    try {
      // If setting to inactive, check for pending orders
      if (!isActive) {
        const [pendingOrders] = await new Promise((resolve, reject) => {
          db.query(
            'SELECT COUNT(*) as count FROM orders WHERE status IN ("pending", "preparing", "ready", "Ready For Pickup/Delivery")',
            (err, rows) => {
              if (err) return reject(err);
              resolve(rows);
            }
          );
        });

        if (pendingOrders.count > 0) {
          // Cancel all pending orders
          await new Promise((resolve, reject) => {
            db.query(
              'UPDATE orders SET status = "cancelled" WHERE status IN ("pending", "preparing", "ready", "Ready For Pickup/Delivery")',
              (err) => {
                if (err) return reject(err);
                resolve();
              }
            );
          });
        }
      }

      // Update canteen status
      await new Promise((resolve, reject) => {
        db.query(
          "UPDATE canteen_status SET is_active = ?, updated_by = ? WHERE id = 1",
          [isActive ? 1 : 0, req.user.id],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      return res.json({
        message: isActive
          ? "Canteen is now active and accepting orders"
          : "Canteen is now inactive and not accepting orders",
        isActive,
      });
    } catch (err) {
      console.error("Failed to update canteen status", err);
      return res
        .status(500)
        .json({ message: "Failed to update canteen status" });
    }
  }
);

// GET /api/dashboard/analytics - Get time-based analytics data
router.get(
  "/dashboard/analytics",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const { period = "daily", range = 7 } = req.query;

      let dateCondition = "";
      let groupBy = "";
      let dateFormat = "";

      switch (period) {
        case "daily":
          dateCondition = `DATE(o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ${range} DAY)`;
          groupBy = "DATE(o.created_at)";
          dateFormat = "%Y-%m-%d";
          break;
        case "weekly":
          dateCondition = `DATE(o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ${range} WEEK)`;
          groupBy = "YEARWEEK(o.created_at)";
          dateFormat = "%Y-W%u";
          break;
        case "monthly":
          dateCondition = `DATE(o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ${range} MONTH)`;
          groupBy = "DATE_FORMAT(o.created_at, '%Y-%m')";
          dateFormat = "%Y-%m";
          break;
        case "yearly":
          dateCondition = `DATE(o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ${range} YEAR)`;
          groupBy = "YEAR(o.created_at)";
          dateFormat = "%Y";
          break;
        default:
          return res.status(400).json({
            message: "Invalid period. Use: daily, weekly, monthly, yearly",
          });
      }

      // Get revenue trends
      const revenueData = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            ${groupBy} as period,
            COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue_items,
            COALESCE(SUM(CASE WHEN o.delivery_option = 'delivery' THEN COALESCE(o.delivery_fee,0) ELSE 0 END), 0) as revenue_delivery,
            COUNT(DISTINCT o.order_id) as order_count
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          WHERE ${dateCondition}
          AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
          GROUP BY ${groupBy}
          ORDER BY period ASC
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get top categories for the period
      const categoryData = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            c.category_name,
            COUNT(*) as count,
            COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          JOIN categories c ON p.category_id = c.category_id
          WHERE ${dateCondition}
          AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
          GROUP BY c.category_id, c.category_name
          ORDER BY count DESC
          LIMIT 10
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      // Get top items for the period
      const itemData = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            p.product_name,
            COUNT(*) as count,
            COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          WHERE ${dateCondition}
          AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
          GROUP BY p.product_id, p.product_name
          ORDER BY count DESC
          LIMIT 10
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      return res.json({
        period,
        range: parseInt(range),
        revenue: revenueData.map((item) => ({
          period: item.period,
          revenue:
            parseFloat(item.revenue_items) +
            parseFloat(item.revenue_delivery),
          orders: parseInt(item.order_count),
        })),
        categories: categoryData.map((item) => ({
          name: item.category_name,
          count: parseInt(item.count),
          revenue: parseFloat(item.revenue),
        })),
        items: itemData.map((item) => ({
          name: item.product_name,
          count: parseInt(item.count),
          revenue: parseFloat(item.revenue),
        })),
      });
    } catch (err) {
      console.error("Failed to get analytics data", err);
      return res.status(500).json({ message: "Failed to get analytics data" });
    }
  }
);

// GET /api/dashboard/report - Generate comprehensive report data
router.get(
  "/dashboard/report",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const {
        period = "daily",
        startDate,
        endDate,
        targetDate,
        targetWeek,
        targetMonth,
        targetYear,
      } = req.query;

      let dateCondition = "";
      let dateRange = "";
      let daysDiff = 1;

      // Helper: format date range label
      const fmt = (d) =>
        new Date(d).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });

      // Helper: ISO week start/end calculator (Monday-Sunday)
      const getIsoWeekRange = (weekNumber, yearNumber) => {
        const simple = new Date(
          Date.UTC(yearNumber, 0, 1 + (weekNumber - 1) * 7)
        );
        const dayOfWeek = simple.getUTCDay() || 7; // Sunday => 7
        const monday = new Date(simple);
        monday.setUTCDate(simple.getUTCDate() - dayOfWeek + 1);
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        return { start: monday, end: sunday };
      };

      // Build date condition in priority order: custom range > specific target > default by period
      if (startDate && endDate) {
        dateCondition = `DATE(o.created_at) BETWEEN '${startDate}' AND '${endDate}'`;
        const start = new Date(startDate);
        const end = new Date(endDate);
        daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
        dateRange = `${fmt(start)} - ${fmt(end)}`;
      } else if (period === "daily" && targetDate) {
        dateCondition = `DATE(o.created_at) = '${targetDate}'`;
        daysDiff = 1;
        dateRange = fmt(targetDate);
      } else if (period === "weekly" && targetWeek) {
        // targetWeek format: YYYY-Www
        const parts = String(targetWeek).split("-W");
        const y = parseInt(parts[0], 10);
        const w = parseInt(parts[1], 10);
        if (!isNaN(y) && !isNaN(w)) {
          const { start, end } = getIsoWeekRange(w, y);
          const startStr = start.toISOString().slice(0, 10);
          const endStr = end.toISOString().slice(0, 10);
          dateCondition = `DATE(o.created_at) BETWEEN '${startStr}' AND '${endStr}'`;
          daysDiff = 7;
          dateRange = `${fmt(start)} - ${fmt(end)}`;
        }
      } else if (period === "monthly" && targetMonth) {
        // targetMonth format: YYYY-MM
        const [yStr, mStr] = String(targetMonth).split("-");
        const y = parseInt(yStr, 10);
        const m = parseInt(mStr, 10);
        if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
          const first = new Date(Date.UTC(y, m - 1, 1));
          const last = new Date(Date.UTC(y, m, 0));
          const firstStr = first.toISOString().slice(0, 10);
          const lastStr = last.toISOString().slice(0, 10);
          dateCondition = `DATE(o.created_at) BETWEEN '${firstStr}' AND '${lastStr}'`;
          daysDiff = last.getUTCDate();
          dateRange = `${fmt(first)} - ${fmt(last)}`;
        }
      } else if (period === "yearly" && targetYear) {
        const y = parseInt(String(targetYear), 10);
        if (!isNaN(y)) {
          const first = new Date(Date.UTC(y, 0, 1));
          const last = new Date(Date.UTC(y, 11, 31));
          const firstStr = first.toISOString().slice(0, 10);
          const lastStr = last.toISOString().slice(0, 10);
          dateCondition = `DATE(o.created_at) BETWEEN '${firstStr}' AND '${lastStr}'`;
          // Compute days in year (365 or 366)
          daysDiff = Math.round((last - first) / (1000 * 60 * 60 * 24)) + 1;
          dateRange = `${fmt(first)} - ${fmt(last)}`;
        }
      } else {
        // Default window based on period
        let range = 30;
        switch (period) {
          case "daily":
            range = 30;
            break;
          case "weekly":
            range = 12 * 7; // ~3 months
            break;
          case "monthly":
            range = 365; // 1 year
            break;
          case "yearly":
            range = 365 * 3; // 3 years
            break;
        }
        dateCondition = `DATE(o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ${range} DAY)`;
        daysDiff = range;
        const endD = new Date();
        const startD = new Date(endD.getTime() - range * 24 * 60 * 60 * 1000);
        dateRange = `${fmt(startD)} - ${fmt(endD)}`;
      }

      // Get total revenue and order counts
      const [orderStats] = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            COALESCE(SUM(CASE WHEN o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery') 
              THEN oi.price_each * oi.quantity ELSE 0 END), 0) as total_revenue_items,
            COALESCE(SUM(CASE WHEN o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery') 
              AND o.delivery_option = 'delivery' THEN COALESCE(o.delivery_fee,0) ELSE 0 END), 0) as total_revenue_delivery,
            COUNT(DISTINCT o.order_id) as total_orders,
            COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN o.order_id END) as completed_orders,
            COUNT(DISTINCT CASE WHEN o.status = 'cancelled' THEN o.order_id END) as cancelled_orders,
            COUNT(DISTINCT CASE WHEN o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery') 
              AND o.delivery_option = 'delivery' THEN o.order_id END) as delivery_orders
          FROM orders o
          LEFT JOIN order_items oi ON o.order_id = oi.order_id
          WHERE ${dateCondition}
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const totalRevenue =
        (parseFloat(orderStats.total_revenue_items) || 0) +
        (parseFloat(orderStats.total_revenue_delivery) || 0);
      const totalOrders = parseInt(orderStats.total_orders) || 0;
      const completedOrders = parseInt(orderStats.completed_orders) || 0;
      const cancelledOrders = parseInt(orderStats.cancelled_orders) || 0;
      const averageDailySales = daysDiff > 0 ? totalRevenue / daysDiff : 0;

      // Get top category
      const topCategoryResult = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            c.category_name as name,
            SUM(oi.quantity) as quantity,
            COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          JOIN categories c ON p.category_id = c.category_id
          WHERE ${dateCondition}
          AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
          GROUP BY c.category_id, c.category_name
          ORDER BY revenue DESC
          LIMIT 1
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const topCategory =
        topCategoryResult.length > 0
          ? {
              name: topCategoryResult[0].name,
              quantity: parseInt(topCategoryResult[0].quantity) || 0,
              revenue: parseFloat(topCategoryResult[0].revenue) || 0,
            }
          : {
              name: "No data available",
              quantity: 0,
              revenue: 0,
            };

      // Get top item
      const topItemResult = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            p.product_name as name,
            SUM(oi.quantity) as quantity,
            COALESCE(SUM(oi.price_each * oi.quantity), 0) as revenue
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          JOIN products p ON oi.product_id = p.product_id
          WHERE ${dateCondition}
          AND o.status IN ('delivered', 'ready', 'Ready For Pickup/Delivery', 'on_delivery')
          GROUP BY p.product_id, p.product_name
          ORDER BY revenue DESC
          LIMIT 1
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const topItem =
        topItemResult.length > 0
          ? {
              name: topItemResult[0].name,
              quantity: parseInt(topItemResult[0].quantity) || 0,
              revenue: parseFloat(topItemResult[0].revenue) || 0,
            }
          : {
              name: "No data available",
              quantity: 0,
              revenue: 0,
            };

      // Get volunteer statistics (no JOIN to avoid table case issues)
      const [volunteerStats] = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            COUNT(DISTINCT o.order_id) as total_deliveries,
            COUNT(DISTINCT CASE WHEN o.volunteer_id IS NOT NULL AND o.volunteer_id > 0 THEN o.volunteer_id END) as active_volunteers
          FROM orders o
          WHERE ${dateCondition}
          AND o.delivery_option = 'delivery'
          AND o.status IN ('delivered', 'on_delivery')
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const totalDeliveries = parseInt(volunteerStats.total_deliveries) || 0;
      const activeVolunteers = parseInt(volunteerStats.active_volunteers) || 0;

      // Calculate average delivery time (simplified - you may want to add actual delivery time tracking)
      const averageDeliveryTime = "15-20 min"; // Default estimate

      const orderDetails = await new Promise((resolve, reject) => {
        db.query(
          `
          SELECT 
            o.order_id,
            o.created_at,
            o.status,
            oi.product_id,
            oi.quantity,
            oi.price_each,
            (oi.price_each * oi.quantity) AS line_total,
            p.product_name,
            p.category_id,
            c.category_name
          FROM orders o
          JOIN order_items oi ON o.order_id = oi.order_id
          LEFT JOIN products p ON oi.product_id = p.product_id
          LEFT JOIN categories c ON p.category_id = c.category_id
          WHERE ${dateCondition}
          ORDER BY o.created_at DESC, o.order_id DESC, oi.product_id ASC
        `,
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });

      const orderBreakdown = orderDetails.map((row) => ({
        orderId: row.order_id,
        orderDate: row.created_at,
        productId: row.product_id,
        productName:
          row.product_name ||
          `Product ID ${String(row.product_id || "").padStart(3, "0")}`,
        quantity: Number(row.quantity) || 0,
        price: Number(row.price_each) || 0,
        total: Number(row.line_total) || 0,
        categoryId: row.category_id,
        categoryName: row.category_name,
      }));

      return res.json({
        period,
        dateRange,
        totalRevenue,
        totalOrders,
        completedOrders,
        cancelledOrders,
        averageDailySales,
        topCategory,
        topItem,
        volunteerStats: {
          totalDeliveries,
          activeVolunteers,
          averageDeliveryTime,
        },
        orders: orderBreakdown,
      });
    } catch (err) {
      console.error("Failed to generate report", err);
      return res
        .status(500)
        .json({ message: "Failed to generate report data" });
    }
  }
);

module.exports = router;
