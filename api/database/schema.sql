CREATE TABLE Users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    phone_no VARCHAR(20),
    role ENUM('student', 'staff', 'volunteer') NOT NULL,
    department ENUM('College of Computer Studies (CCS)', 'College of Business and Accountancy (CBA)', 'College of Allied Health Studies (CAHS)', 'College of Hospitality and Tourism Management (CHTM)', 'College of Education, Arts, and Sciences (CEAS)'),
    status ENUM('active', 'pending', 'approved') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE Categories (
    category_id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE Products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    category_id INT,
    image_path LONGTEXT,
    is_deleted TINYINT(1) NOT NULL DEFAULT FALSE,
    is_visible TINYINT(1) NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES Categories(category_id) ON DELETE SET NULL
);

CREATE TABLE Orders (
    order_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    status ENUM('pending', 'preparing', 'ready', 'on_delivery', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
    delivery_option ENUM('pickup', 'delivery') NOT NULL,
    preferred_time TIME,
    delivery_room VARCHAR(100),
    volunteer_id INT,
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES Users(user_id),
    FOREIGN KEY (volunteer_id) REFERENCES Users(user_id)
);

-- Ensure volunteer_id is properly initialized (NULL = unassigned, > 0 = assigned to specific volunteer)
-- This prevents volunteers from seeing unassigned orders

CREATE TABLE Order_Items (
    order_item_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    price_each DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(product_id)
);

CREATE TABLE Volunteer_Applications (
    application_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- Track volunteer availability
CREATE TABLE IF NOT EXISTS Volunteers (
    user_id INT PRIMARY KEY,
    is_available TINYINT(1) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- Track volunteer delivery assignment offers
CREATE TABLE IF NOT EXISTS Volunteer_Offers (
    offer_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    volunteer_id INT NOT NULL,
    status ENUM('pending', 'accepted', 'declined', 'timed_out') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP NULL DEFAULT NULL,
    expires_at DATETIME NULL,
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_offer_volunteer_status (volunteer_id, status),
    INDEX idx_offer_order_status (order_id, status),
    INDEX idx_offer_expires (expires_at)
);

-- Track canteen status (active/inactive)
CREATE TABLE IF NOT EXISTS Canteen_Status (
    id INT PRIMARY KEY DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by INT,
    FOREIGN KEY (updated_by) REFERENCES Users(user_id) ON DELETE SET NULL
);

-- Insert initial canteen status
INSERT INTO Canteen_Status (id, is_active) VALUES (1, 1) ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO Users (name, email, phone_no, role, password_hash, status) VALUES ('Mellisa Docena', 'mellisa.lacanlale@gmail.com', '09100769255', 'staff', '$2b$10$HVIrZ8DcO9LqLN6dugN.XeMyi0VB/jDNIKZJq2INxY5P1OefL5vwW', 'approved');

-- Insert initial categories
INSERT INTO Categories (category_name) VALUES 
('Rice Meals'),
('Drinks'),
('Sandwiches'),
('Snacks');

-- Database cleanup and maintenance procedures
-- Run these if you have existing data that needs fixing

-- Cleanup any existing orders with invalid volunteer_id values
-- This ensures the volunteer assignment system works correctly
UPDATE Orders 
SET volunteer_id = NULL 
WHERE status IN ('ready', 'on_delivery') 
  AND delivery_option = 'delivery' 
  AND (volunteer_id = 0 OR volunteer_id = '' OR volunteer_id < 0);

-- Verify volunteer assignments are clean
-- This query should return only properly assigned orders (volunteer_id > 0) or unassigned orders (volunteer_id IS NULL)
SELECT 'Verifying volunteer assignments:' as info;
SELECT 
  COUNT(*) as total_delivery_orders,
  COUNT(CASE WHEN volunteer_id IS NULL THEN 1 END) as unassigned_orders,
  COUNT(CASE WHEN volunteer_id IS NOT NULL AND volunteer_id > 0 THEN 1 END) as properly_assigned_orders,
  COUNT(CASE WHEN volunteer_id <= 0 THEN 1 END) as invalid_assigned_orders
FROM Orders 
WHERE status IN ('ready', 'on_delivery') AND delivery_option = 'delivery';
