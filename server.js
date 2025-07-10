// Imports
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { log } = require("console");
const cron = require("node-cron");
const { sendNotificationToPassengers } = require("./notification");

// App setup
const app = express();
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.json());
app.use(cors());

// File upload configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const filename = Date.now() + ext;
    cb(null, filename);
  },
});
const upload = multer({ storage: storage });

// MySQL connection
const db = mysql.createPool({
  host: "db4free.net",
  user: "mohamadev",
  password: "database123",
  database: "transportationdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true,
});

const connection = db.promise();

async function updateTripStatuses() {
  try {
    await connection.query(`
      UPDATE trip
      SET STATUS_TRIP = 'Complete'
      WHERE 
        CONCAT(
          CASE 
            WHEN RETURN_TIME < DEPARTURE_TIME THEN TRIP_DATE
            ELSE TRIP_DATE
          END, 
          ' ',
          RETURN_TIME
        ) < DATE_ADD(NOW(), INTERVAL 3 HOUR)
        AND STATUS_TRIP NOT IN ('Cancelled', 'Complete')
    `);

    await connection.query(`
      UPDATE trip
      SET STATUS_TRIP = 'Active'
      WHERE 
        CONCAT(TRIP_DATE, ' ', DEPARTURE_TIME) <= DATE_ADD(NOW(), INTERVAL 3 HOUR)
        AND CONCAT(
          CASE 
            WHEN RETURN_TIME < DEPARTURE_TIME THEN DATE_ADD(TRIP_DATE, INTERVAL 1 DAY)
            ELSE TRIP_DATE
          END, 
          ' ',
          RETURN_TIME
        ) >= DATE_ADD(NOW(), INTERVAL 3 HOUR)
        AND STATUS_TRIP NOT IN ('Cancelled', 'Complete')
    `);

    await connection.query(`
      UPDATE trip t
      JOIN (
        SELECT TRIP_ID, COUNT(*) AS bookedSeats FROM book GROUP BY TRIP_ID
      ) b ON b.TRIP_ID = t.TRIP_ID
      JOIN driver_captin_trip dct ON dct.TRIP_ID = t.TRIP_ID
      JOIN bus bs ON bs.BUS_ID = dct.BUS_ID
      SET t.STATUS_TRIP = 'Full'
      WHERE b.bookedSeats >= bs.CAPACITY
        AND t.STATUS_TRIP NOT IN ('Cancelled', 'Complete', 'Active')
    `);

    await connection.query(`
      UPDATE trip
      SET STATUS_TRIP = 'Cancelled'
      WHERE STATUS_TRIP NOT IN ('Complete', 'Cancelled', 'Active')
        AND CONCAT(TRIP_DATE, ' ', DEPARTURE_TIME) <= DATE_ADD(DATE_ADD(NOW(), INTERVAL 3 HOUR), INTERVAL 5 MINUTE)
        AND TRIP_ID NOT IN (SELECT DISTINCT TRIP_ID FROM book)
    `);

    await connection.query(`
      UPDATE trip
      SET STATUS_TRIP = 'Pending'
      WHERE STATUS_TRIP NOT IN ('Full', 'Active', 'Complete', 'Cancelled')
    `);
  } catch (error) {
    console.error("Error updating trip statuses:", error);
  }
}

cron.schedule("* * * * *", () => {
  updateTripStatuses();
});

// Generate defaulte password
function generateRandomPassword(length = 10) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "husseintabel733@gmail.com",
    pass: "sjqm gzpm aztz sxyq", // App password
  },
});

// Manager login
app.post("/managerLogin", (req, res) => {
  const { email, password } = req.body;
  const sql = `SELECT * FROM users WHERE USER_EMAIL = ? AND PASSWORD = SHA2(?, 256) AND TYPE_ID = 1`;
  db.query(sql, [email, password], (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (results.length > 0) {
      res.json({ success: true, user: results[0] });
    } else {
      res
        .status(401)
        .json({ success: false, message: "Invalid credentials or not admin" });
    }
  });
});

// Update admin profile
app.post("/admin/updateProfile", upload.single("profilePic"), (req, res) => {
  const { adminId, fullName, email, phone, password } = req.body;
  const profilePic = req.file ? req.file.filename : null;

  if (!adminId || !fullName || !email || !phone) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  const checkSql = `SELECT * FROM users WHERE USER_EMAIL = ? AND TYPE_ID = 1 AND USER_ID != ?`;
  db.query(checkSql, [email, adminId], (err, results) => {
    if (err)
      return res
        .status(500)
        .json({ success: false, message: "Database error" });
    if (results.length > 0) {
      if (profilePic) {
        fs.unlink(path.join(__dirname, "uploads", profilePic), () => {});
      }
      return res.status(409).json({
        success: false,
        message: "Email is already used by another admin",
      });
    }

    let updateSql = `UPDATE users SET FULL_NAME = ?, USER_EMAIL = ?, PHONE_NUMBER = ?`;
    const values = [fullName, email, phone];

    if (password) {
      updateSql += `, PASSWORD = SHA2(?, 256)`;
      values.push(password);
    }
    if (profilePic) {
      updateSql += `, USER_PHOTO = ?`;
      values.push(profilePic);
    }

    updateSql += ` WHERE USER_ID = ?`;
    values.push(adminId);

    db.query(updateSql, values, (err2) => {
      if (err2)
        return res
          .status(500)
          .json({ success: false, message: "Update failed" });

      db.query(
        "SELECT * FROM users WHERE USER_ID = ?",
        [adminId],
        (err3, updatedUser) => {
          if (err3)
            return res
              .status(500)
              .json({ success: false, message: "Fetch failed" });
          res.json({ success: true, admin: updatedUser[0] });
        }
      );
    });
  });
});

// Reset and send password
app.post("/send-reset-password", (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res
      .status(400)
      .json({ success: false, message: "Missing email or password" });
  }

  const sql = `UPDATE users SET PASSWORD = SHA2(?, 256) WHERE USER_EMAIL = ? AND TYPE_ID = 1`;
  db.query(sql, [newPassword, email], (err, result) => {
    if (err)
      return res
        .status(500)
        .json({ success: false, message: "Database update failed" });
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found" });
    }

    const mailOptions = {
      from: '"Bus Transportation" <husseintabel733@gmail.com>',
      to: email,
      subject: "Password Reset Request",
      html: `<h2>Password Reset</h2><p>Your new password is: <strong>${newPassword}</strong></p><p>Please log in and change your password immediately.</p>`,
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) {
        return res
          .status(500)
          .json({ success: false, message: "Failed to send email." });
      } else {
        return res.json({
          success: true,
          message: "Reset password email sent.",
        });
      }
    });
  });
});

// Send email function
async function sendDriverEmail(toEmail, fullName, tempPassword) {
  const mailOptions = {
    from: '"Transport System" <husseintabel733@gmail.com>',
    to: toEmail,
    subject: "Welcome - Driver Account Created",
    text: `Hello ${fullName},

Your driver account has been created.

Email: ${toEmail}
Temporary Password: ${tempPassword}

Please login and change your password after your first login.

Best regards,
Transport Management System`,
  };

  return transporter.sendMail(mailOptions);
}

// Create or Update Driver with soft delete logic
app.post("/admin/createDriver", async (req, res) => {
  const {
    fullName,
    email,
    phone,
    salary,
    managerId,
    license_num,
    license_type,
    join_date,
  } = req.body;

  try {
    // Check for existing active driver with same email
    const [activeDriverEmail] = await db.promise().query(
      `SELECT u.USER_ID FROM users u
       JOIN driver d ON d.DRIVER_ID = u.USER_ID
       WHERE u.USER_EMAIL = ? AND d.AVAILABILITY = 0`,
      [email]
    );

    if (activeDriverEmail.length > 0) {
      return res.json({
        success: false,
        message: "Email already used by an active driver",
      });
    }

    // Check if user with this email exists
    const [existingUser] = await db
      .promise()
      .query("SELECT * FROM users WHERE USER_EMAIL = ?", [email]);

    // Check if license number already exists (only for available drivers)
    const [existingLicense] = await db
      .promise()
      .query(
        "SELECT * FROM driver WHERE LICENSE_NUMBER = ? AND AVAILABILITY = 0",
        [license_num]
      );

    if (existingLicense.length > 0) {
      return res.json({
        success: false,
        message: "License number already exists",
      });
    }

    let userId;
    const tempPassword = generateRandomPassword();

    if (existingUser.length > 0) {
      const user = existingUser[0];

      if (user.TYPE_ID === 3) {
        // Update existing user from passenger to driver
        await db
          .promise()
          .query(
            `UPDATE users SET FULL_NAME = ?, PHONE_NUMBER = ?, PASSWORD = SHA2(?, 256), TYPE_ID = 2 WHERE USER_ID = ?`,
            [fullName, phone, tempPassword, user.USER_ID]
          );

        userId = user.USER_ID;

        // Send email with new temp password
        await sendDriverEmail(email, fullName, tempPassword);
      } else if (user.TYPE_ID === 2) {
        // Already a driver, just update name and phone
        userId = user.USER_ID;
        await db
          .promise()
          .query(
            `UPDATE users SET FULL_NAME = ?, PHONE_NUMBER = ? WHERE USER_ID = ?`,
            [fullName, phone, userId]
          );
      } else {
        return res.json({
          success: false,
          message: "Email already exists with a different role",
        });
      }
    } else {
      // Insert new user as driver
      const [userInsertResult] = await db.promise().query(
        `INSERT INTO users (FULL_NAME, USER_EMAIL, PASSWORD, PHONE_NUMBER, TYPE_ID)
         VALUES (?, ?, SHA2(?, 256), ?, 2)`,
        [fullName, email, tempPassword, phone]
      );

      userId = userInsertResult.insertId;

      await sendDriverEmail(email, fullName, tempPassword);
    }

    // Check if driver exists with AVAILABILITY = 1 (archived)
    const [archivedDriver] = await db
      .promise()
      .query(`SELECT * FROM driver WHERE DRIVER_ID = ? AND AVAILABILITY = 1`, [
        userId,
      ]);

    if (archivedDriver.length > 0) {
      // Reactivate driver
      await db
        .promise()
        .query(
          `UPDATE driver SET AVAILABILITY = 0, SALARY = ?, MANAGER_ID = ?, LICENSE_NUMBER = ?, LICENSE_TYPE = ?, JOIN_DATE = ? WHERE DRIVER_ID = ?`,
          [salary, managerId, license_num, license_type, join_date, userId]
        );
    } else {
      // Check if already active driver exists
      const [existingDriver] = await db
        .promise()
        .query(
          "SELECT * FROM driver WHERE DRIVER_ID = ? AND AVAILABILITY = 0",
          [userId]
        );

      if (existingDriver.length === 0) {
        // Insert new driver
        await db.promise().query(
          `INSERT INTO driver (DRIVER_ID, SALARY, MANAGER_ID, LICENSE_NUMBER, LICENSE_TYPE, JOIN_DATE, AVAILABILITY)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          [userId, salary, managerId, license_num, license_type, join_date]
        );
      } else {
        // Update existing active driver
        await db
          .promise()
          .query(
            `UPDATE driver SET SALARY = ?, MANAGER_ID = ?, LICENSE_NUMBER = ?, LICENSE_TYPE = ?, JOIN_DATE = ? WHERE DRIVER_ID = ?`,
            [salary, managerId, license_num, license_type, join_date, userId]
          );
      }
    }

    res.json({
      success: true,
      message: "Driver created/updated successfully",
    });
  } catch (error) {
    console.error("Driver Creation Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get drivers under a manager (only available ones)
app.get("/admin/drivers", (req, res) => {
  const managerId = req.query.managerId;

  const query = `
    SELECT
      d.DRIVER_ID AS driverId,
      u.FULL_NAME AS driverName,
      u.USER_EMAIL AS email,
      u.PHONE_NUMBER AS phone,
      d.SALARY AS salary,
      d.LICENSE_NUMBER AS license_num,
      d.LICENSE_TYPE AS license_type,
      d.JOIN_DATE AS join_date,
      IF(
        EXISTS (
          SELECT 1
          FROM driver_captin_trip dct
          JOIN trip t ON t.TRIP_ID = dct.TRIP_ID
          WHERE dct.DRIVER_ID = d.DRIVER_ID
            AND DATE_ADD(NOW(), INTERVAL 3 HOUR) BETWEEN 
              STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME), '%Y-%m-%d %H:%i:%s') AND
              STR_TO_DATE(
                CONCAT(
                  CASE 
                    WHEN t.RETURN_TIME < t.DEPARTURE_TIME 
                      THEN DATE_ADD(t.TRIP_DATE, INTERVAL 1 DAY)
                    ELSE t.TRIP_DATE
                  END,
                  ' ',
                  t.RETURN_TIME
                ), 
                '%Y-%m-%d %H:%i:%s'
              )
        ),
        'No',
        'Yes'
      ) AS available
    FROM driver d
    JOIN users u ON u.USER_ID = d.DRIVER_ID
    WHERE d.MANAGER_ID = ? AND d.AVAILABILITY = 0;
  `;

  db.query(query, [managerId], (err, result) => {
    if (err) return res.status(500).json({ error: err.message || err });
    res.json(result);
  });
});

// Soft delete (archive) driver by setting AVAILABILITY = 1
app.post("/admin/deleteDriver", async (req, res) => {
  const { driverId } = req.body;

  try {
    const connection = db.promise();

    // Check if driver is assigned to any current or future trip (not cancelled)
    const [tripRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM driver_captin_trip dct
      JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
      WHERE dct.DRIVER_ID = ?
        AND CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME) >= DATE_ADD(NOW(), INTERVAL 3 HOUR)
        AND t.STATUS_TRIP != 'Cancelled'
      `,
      [driverId]
    );

    if (tripRows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot archive driver: They are assigned to a current or future trip",
      });
    }

    // Proceed with soft delete
    await connection.query(
      `UPDATE driver SET AVAILABILITY = 1 WHERE DRIVER_ID = ?`,
      [driverId]
    );

    res.json({
      success: true,
      message: "Driver archived successfully",
    });
  } catch (err) {
    console.error("Soft delete driver error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while archiving driver",
    });
  }
});

// Update driver
app.post("/admin/updateDriver", async (req, res) => {
  const {
    driverId,
    driverName,
    email,
    phone,
    salary,
    license_num,
    license_type,
    join_date,
  } = req.body;

  if (!driverId || !driverName || !email || !phone || !salary) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    const [emailCheck] = await db
      .promise()
      .query(
        "SELECT USER_ID FROM users WHERE USER_EMAIL = ? AND USER_ID != ?",
        [email, driverId]
      );

    if (emailCheck.length > 0) {
      return res
        .status(409)
        .json({ message: "This email is already used by another driver." });
    }

    const [licenseCheck] = await db
      .promise()
      .query(
        "SELECT DRIVER_ID FROM driver WHERE LICENSE_NUMBER = ? AND DRIVER_ID != ?",
        [license_num, driverId]
      );

    if (licenseCheck.length > 0) {
      return res.status(409).json({
        message: "This license number is already used by another driver.",
      });
    }

    // تحويل join_date إلى صيغة YYYY-MM-DD فقط
    const joinDateOnly = join_date
      ? new Date(join_date).toISOString().slice(0, 10)
      : null;

    await db
      .promise()
      .query(
        `UPDATE users SET FULL_NAME = ?, USER_EMAIL = ?, PHONE_NUMBER = ? WHERE USER_ID = ?`,
        [driverName, email, phone, driverId]
      );

    await db
      .promise()
      .query(
        `UPDATE driver SET SALARY = ?, LICENSE_NUMBER = ?, LICENSE_TYPE = ?, JOIN_DATE = ? WHERE DRIVER_ID = ?`,
        [salary, license_num, license_type, joinDateOnly, driverId]
      );

    res.json({ message: "Driver updated successfully." });
  } catch (error) {
    console.error("Update driver error:", error);
    res.status(500).json({ message: "Server error while updating driver." });
  }
});

// Get passenger under a manager
app.get("/admin/passengers/:managerId", (req, res) => {
  const managerId = req.params.managerId;
  const query = `
    SELECT u.USER_ID, u.FULL_NAME, u.USER_EMAIL, u.PHONE_NUMBER, uf.USER_STATUS 
    FROM users u JOIN user_follow_manager uf ON u.USER_ID = uf.PASSENGER_ID 
    WHERE u.TYPE_ID = 3 AND uf.MANAGER_ID = ?;
  `;

  db.query(query, [managerId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(result);
  });
});

//Update user status
app.put("/admin/passengers/status", (req, res) => {
  const { userId, status } = req.body;

  const query = `
    UPDATE user_follow_manager
    SET USER_STATUS = ?
    WHERE PASSENGER_ID = ?;
  `;

  db.query(query, [status, userId], (err, result) => {
    if (err) {
      console.error("Error updating status:", err);
      return res.status(500).json({ error: err.message });
    }

    res.json({ message: "Status updated successfully" });
  });
});

async function sendWelcomeEmail(toEmail, fullName, tempPassword) {
  const mailOptions = {
    from: '"Transport System" <husseintabel733@gmail.com>',
    to: toEmail,
    subject: "Your Account Has Been Created",
    text: `Hello ${fullName},

Your account has been created in the Transport System.

Email: ${toEmail}
Temporary Password: ${tempPassword}

Please log in and change your password.

Regards,
Transport Team`,
  };

  return transporter.sendMail(mailOptions);
}

// Create passenger
app.post("/admin/createPassenger", async (req, res) => {
  const { fullName, email, phone, managerId } = req.body;

  if (!fullName || !email || !phone || !managerId) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  try {
    const [existingUsers] = await db
      .promise()
      .query("SELECT USER_ID FROM users WHERE USER_EMAIL = ?", [email]);

    if (existingUsers.length > 0) {
      return res
        .status(409)
        .json({ success: false, message: "Email already exists" });
    }

    const tempPassword = generateRandomPassword(); // create temp password

    const [result] = await db
      .promise()
      .query(
        "INSERT INTO users (USER_EMAIL, TYPE_ID, FULL_NAME, PASSWORD, PHONE_NUMBER) VALUES (?, 3, ?, SHA2(?, 256), ?)",
        [email, fullName, tempPassword, phone]
      );

    const insertedUserId = result.insertId;

    await db
      .promise()
      .query(
        "INSERT INTO user_follow_manager (PASSENGER_ID, MANAGER_ID, USER_STATUS) VALUES (?, ?, 1)",
        [insertedUserId, managerId]
      );

    await sendWelcomeEmail(email, fullName, tempPassword);

    res.json({ success: true });
  } catch (error) {
    console.error("Create Passenger Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get bus under a manager
app.get("/admin/buses", (req, res) => {
  const managerId = req.query.managerId;

  const query = `
    SELECT 
      b.BUS_ID AS busId,
      b.PLATE_NUMBER AS plateNumber,
      b.CAPACITY AS capacity,
      b.BUS_MODEL AS model,
      IF(
        EXISTS (
          SELECT 1
          FROM driver_captin_trip dct
          JOIN trip t ON t.TRIP_ID = dct.TRIP_ID
          WHERE dct.BUS_ID = b.BUS_ID
            AND DATE_ADD(NOW(), INTERVAL 3 HOUR) BETWEEN 
              STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME), '%Y-%m-%d %H:%i:%s') AND
              STR_TO_DATE(
                CONCAT(
                  CASE 
                    WHEN t.RETURN_TIME < t.DEPARTURE_TIME 
                      THEN DATE_ADD(t.TRIP_DATE, INTERVAL 1 DAY)
                    ELSE t.TRIP_DATE
                  END,
                  ' ',
                  t.RETURN_TIME
                ), 
                '%Y-%m-%d %H:%i:%s'
              )
            AND t.STATUS_TRIP != 'Cancelled'
        ),
        'No',
        'Yes'
      ) AS availability
    FROM bus b
    WHERE b.MANAGER_ID = ? AND b.BUS_AVAILABILITY = 0;
  `;

  db.query(query, [managerId], (err, result) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Error fetching buses: " + err.message });
    }
    res.json(result);
  });
});

// Create new bus
app.post("/admin/createBus", async (req, res) => {
  try {
    const { plateNumber, managerId, capacity, busModel } = req.body;

    const connection = db.promise();

    // Check if a bus with this plate number already exists
    const [existingBusRows] = await connection.query(
      "SELECT * FROM bus WHERE PLATE_NUMBER = ?",
      [plateNumber.trim()]
    );

    if (existingBusRows.length > 0) {
      const bus = existingBusRows[0];

      if (bus.BUS_AVAILABILITY === 1) {
        // Reactivate the archived bus
        await connection.query(
          `UPDATE bus 
           SET BUS_AVAILABILITY = 0, MANAGER_ID = ?, CAPACITY = ?, BUS_MODEL = ? 
           WHERE BUS_ID = ?`,
          [managerId, parseInt(capacity, 10), busModel.trim(), bus.BUS_ID]
        );

        return res.json({
          success: true,
          message: "Archived bus reactivated and updated successfully",
          busId: bus.BUS_ID,
        });
      }

      return res.status(409).json({
        success: false,
        message: "Plate Number already used by an active bus",
      });
    }

    // Insert new bus
    const [insertResult] = await connection.query(
      `INSERT INTO bus (PLATE_NUMBER, MANAGER_ID, CAPACITY, BUS_AVAILABILITY, BUS_MODEL)
       VALUES (?, ?, ?, 0, ?)`,
      [plateNumber.trim(), managerId, parseInt(capacity, 10), busModel.trim()]
    );

    res.status(201).json({
      success: true,
      message: "Bus created successfully",
      busId: insertResult.insertId,
    });
  } catch (error) {
    console.error("Create Bus Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update Bus
app.post("/admin/updateBus", async (req, res) => {
  const { busId, plateNumber, capacity, model } = req.body;

  try {
    const [plateCheck] = await db
      .promise()
      .query("SELECT BUS_ID FROM bus WHERE PLATE_NUMBER = ? AND BUS_ID != ?", [
        plateNumber,
        busId,
      ]);

    if (plateCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This plate number is already used by another bus.",
      });
    }

    await db
      .promise()
      .query(
        `UPDATE bus SET PLATE_NUMBER = ?, CAPACITY = ?, BUS_MODEL = ? WHERE BUS_ID = ?`,
        [plateNumber, capacity, model, busId]
      );

    res.json({ success: true, message: "Bus updated successfully" });
  } catch (error) {
    console.error("Update Bus Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while updating bus" });
  }
});

// Delete a bus
app.post("/admin/deleteBus", async (req, res) => {
  const { busId } = req.body;

  try {
    const connection = db.promise();

    // Check if bus exists
    const [busRows] = await connection.query(
      "SELECT BUS_AVAILABILITY FROM bus WHERE BUS_ID = ?",
      [busId]
    );

    if (busRows.length === 0) {
      return res.status(404).json({ success: false, message: "Bus not found" });
    }

    // Check if bus is assigned to any current or future trip (not cancelled)
    const [tripRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM driver_captin_trip dct
      JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
      WHERE dct.BUS_ID = ?
        AND CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME) >= DATE_ADD(NOW(), INTERVAL 3 HOUR)
        AND t.STATUS_TRIP != 'Cancelled'
      `,
      [busId]
    );

    if (tripRows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot archive bus: It is assigned to a current or upcoming trip",
      });
    }

    // Proceed with soft delete (archive)
    await connection.query(
      "UPDATE bus SET BUS_AVAILABILITY = 1 WHERE BUS_ID = ?",
      [busId]
    );

    res.json({ success: true, message: "Bus archived successfully" });
  } catch (error) {
    console.error("Soft delete bus error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while archiving bus" });
  }
});

// Get trip under a manager
app.get("/admin/trips", async (req, res) => {
  const managerId = req.query.managerId;
  const connection = db.promise();

  try {
    const [result] = await connection.query(
      `SELECT
          t.TRIP_ID,
          t.DEPARTURE_LOCATION,
          t.DESTINATION_LOCATION,
          t.STATUS_TRIP,
          CASE 
            WHEN t.RETURN_TIME < t.DEPARTURE_TIME THEN DATE_ADD(t.TRIP_DATE, INTERVAL 1 DAY)
            ELSE t.TRIP_DATE
          END AS TRIP_DATE,
          t.DEPARTURE_TIME,
          t.RETURN_TIME,
          t.SEAT_PRICE,
          t.MANAGER_ID,
          t.DEPARTURE_COORDS,
          ANY_VALUE(u.USER_EMAIL) AS DRIVER_EMAIL,
          ANY_VALUE(u.USER_ID) AS DRIVER_ID,
          ANY_VALUE(u.FULL_NAME) AS DRIVER_FULL_NAME,
          ANY_VALUE(u.PHONE_NUMBER) AS DRIVER_PHONE_NUMBER,
          GROUP_CONCAT(tsl.SPECIFIC_LOCATION SEPARATOR '; ') AS SPECIFIC_LOCATIONS,
          GROUP_CONCAT(tsl.LOCATION_GEO SEPARATOR '; ') AS GEO_LOCATIONS,
          ANY_VALUE(b.PLATE_NUMBER) AS PLATE_NUMBER,
          ANY_VALUE(b.BUS_MODEL) AS BUS_MODEL,
          ANY_VALUE(b.CAPACITY) AS CAPACITY,
          ANY_VALUE(b.BUS_ID) AS BUS_ID
      FROM
          trip t
      JOIN driver_captin_trip dct ON dct.TRIP_ID = t.TRIP_ID
      JOIN users u ON u.USER_ID = dct.DRIVER_ID
      JOIN trip_specific_location tsl ON tsl.TRIP_ID = t.TRIP_ID
      JOIN bus b ON b.BUS_ID = dct.BUS_ID
      WHERE t.MANAGER_ID = ?
      GROUP BY t.TRIP_ID`,
      [managerId]
    );

    res.json(result);
  } catch (err) {
    console.error("Error in /admin/trips:", err);
    res.status(500).json({ error: "Error fetching trips" });
  }
});

// get all book
app.get("/admin/tripPassengers", (req, res) => {
  const tripId = req.query.tripId;

  const query = `
    SELECT
    b.*,
    u.FULL_NAME,
    u.USER_EMAIL,
    u.PHONE_NUMBER
FROM
    book b
JOIN users u ON
	u.USER_ID = b.USER_ID
WHERE
    TRIP_ID = ?
  `;

  db.query(query, [tripId], (err, result) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Error fetching passengers: " + err.message });
    }
    res.json(result);
  });
});

// get available drivers and buses
app.post("/admin/availableDriversAndBuses", (req, res) => {
  const { trip_date, departure_time, return_time, manager_id } = req.body;

  if (!trip_date || !departure_time || !manager_id) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required data" });
  }

  const today = new Date().toISOString().split("T")[0];
  if (trip_date < today) {
    return res.status(400).json({
      success: false,
      message: "Trip date must be today or in the future.",
    });
  }

  const departureDateTime = `${trip_date} ${departure_time}`;
  const returnDateTime = return_time
    ? `${trip_date} ${return_time}`
    : departureDateTime;

  const sql = `
  -- Available Drivers
  SELECT 
    d.DRIVER_ID, u.FULL_NAME, u.USER_EMAIL, u.PHONE_NUMBER
  FROM 
    driver d
  JOIN users u ON d.DRIVER_ID = u.USER_ID
  WHERE d.MANAGER_ID = ?
    AND d.AVAILABILITY = 0
    AND d.DRIVER_ID NOT IN (
      SELECT dct.DRIVER_ID
      FROM driver_captin_trip dct
      JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
      WHERE 
        t.STATUS_TRIP != 'Cancelled'
        AND STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME), '%Y-%m-%d %H:%i:%s') < ?
        AND STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.RETURN_TIME), '%Y-%m-%d %H:%i:%s') > ?
    );

  -- Available Buses
  SELECT 
    b.BUS_ID, b.PLATE_NUMBER, b.CAPACITY, b.BUS_MODEL
  FROM 
    bus b
  WHERE b.MANAGER_ID = ?
    AND b.BUS_AVAILABILITY = 0
    AND b.BUS_ID NOT IN (
      SELECT dct.BUS_ID
      FROM driver_captin_trip dct
      JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
      WHERE 
        t.STATUS_TRIP != 'Cancelled'
        AND STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.DEPARTURE_TIME), '%Y-%m-%d %H:%i:%s') < ?
        AND STR_TO_DATE(CONCAT(t.TRIP_DATE, ' ', t.RETURN_TIME), '%Y-%m-%d %H:%i:%s') > ?
    );
`;

  db.query(
    sql,
    [
      manager_id,
      returnDateTime,
      departureDateTime, // For drivers
      manager_id,
      returnDateTime,
      departureDateTime, // For buses
    ],
    (err, results) => {
      if (err) return res.status(500).json({ success: false, error: err });

      const [availableDrivers, availableBuses] = results;
      res.json({ success: true, availableDrivers, availableBuses });
    }
  );
});

// create new trip
app.post("/admin/createTrip", async (req, res) => {
  const {
    departure,
    destination,
    status,
    price,
    date,
    departureTime,
    returnTime,
    stops,
    busId,
    driverId,
    managerId,
    departureCoords,
  } = req.body;

  const connection = db.promise();

  try {
    const [result] = await connection.query(
      "INSERT INTO trip (TRIP_DATE, DEPARTURE_TIME, RETURN_TIME, SEAT_PRICE, STATUS_TRIP, MANAGER_ID, DESTINATION_LOCATION, DEPARTURE_LOCATION, DEPARTURE_COORDS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        date,
        departureTime,
        returnTime,
        price,
        status,
        managerId,
        destination,
        departure,
        departureCoords || null,
      ]
    );

    const insertTripId = result.insertId;

    await connection.query(
      "INSERT INTO driver_captin_trip (DRIVER_ID, TRIP_ID, BUS_ID) VALUES (?, ?, ?)",
      [driverId, insertTripId, busId]
    );

    // Stops
    if (Array.isArray(stops) && stops.length > 0) {
      const stopQueries = stops.map((stop) =>
        connection.query(
          "INSERT INTO trip_specific_location (TRIP_ID, SPECIFIC_LOCATION, LOCATION_GEO) VALUES (?, ?, ?)",
          [insertTripId, stop.SPECIFIC_LOCATION, stop.LOCATION_GEO]
        )
      );
      await Promise.all(stopQueries);
    }

    // Get driver token
    const [driverData] = await connection.query(
      "SELECT FCM_TOKEN, FULL_NAME FROM users WHERE USER_ID = ? AND FCM_TOKEN IS NOT NULL",
      [driverId]
    );

    if (driverData.length > 0) {
      const token = driverData[0].FCM_TOKEN;
      const driverName = driverData[0].FULL_NAME;

      const formattedDate = new Date(date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const formattedTime = departureTime.slice(0, 5); // HH:mm

      const title = "New Trip Assigned";
      const body = `Hi ${driverName}, you have a new trip from ${departure} to ${destination} on ${formattedDate} at ${formattedTime}.`;

      await sendNotificationToPassengers([token], title, body);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Create trip error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/admin/cancelTrip", async (req, res) => {
  const { tripId } = req.body;

  try {
    const conn = db.promise();

    const [tripInfo] = await conn.query(
      `SELECT DEPARTURE_LOCATION, DESTINATION_LOCATION, DEPARTURE_TIME, TRIP_DATE
       FROM trip WHERE TRIP_ID = ?`,
      [tripId]
    );

    let tripMessage = "The trip you were assigned to has been cancelled.";
    let passengerMessage = "Your booked trip has been cancelled.";

    if (tripInfo.length > 0) {
      const {
        DEPARTURE_LOCATION,
        DESTINATION_LOCATION,
        DEPARTURE_TIME,
        TRIP_DATE,
      } = tripInfo[0];

      const formattedDate = new Date(TRIP_DATE).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      tripMessage = `Trip Cancelled: ${DEPARTURE_LOCATION} → ${DESTINATION_LOCATION} on ${formattedDate} at ${DEPARTURE_TIME} has been cancelled.`;
      passengerMessage = `Your trip from ${DEPARTURE_LOCATION} to ${DESTINATION_LOCATION} on ${formattedDate} at ${DEPARTURE_TIME} has been cancelled.`;
    }

    await conn.query(
      "UPDATE trip SET STATUS_TRIP = 'Cancelled' WHERE TRIP_ID = ?",
      [tripId]
    );

    const [passengers] = await conn.query(
      `SELECT u.FCM_TOKEN
       FROM book b
       JOIN users u ON b.USER_ID = u.USER_ID
       WHERE b.TRIP_ID = ? AND u.FCM_TOKEN IS NOT NULL`,
      [tripId]
    );

    const passengerTokens = passengers
      .map((row) => row.FCM_TOKEN)
      .filter(Boolean);

    if (passengerTokens.length > 0) {
      await sendNotificationToPassengers(
        passengerTokens,
        "Trip Cancelled",
        passengerMessage
      );
    }

    const [driverResult] = await conn.query(
      `SELECT DRIVER_ID FROM driver_captin_trip WHERE TRIP_ID = ?`,
      [tripId]
    );

    let driverToken = null;

    if (driverResult.length > 0) {
      const driverId = driverResult[0].DRIVER_ID;

      const [driverData] = await conn.query(
        `SELECT FCM_TOKEN FROM users WHERE USER_ID = ? AND FCM_TOKEN IS NOT NULL`,
        [driverId]
      );

      if (driverData.length > 0) {
        driverToken = driverData[0].FCM_TOKEN;
      }
    }

    if (driverToken) {
      await sendNotificationToPassengers(
        [driverToken],
        "Trip Cancelled",
        tripMessage
      );
    }

    res.status(200).json({
      success: true,
      message: "Trip cancelled. Notifications sent to passengers and driver.",
    });
  } catch (err) {
    console.error("Error cancelling trip:", err);
    res.status(500).json({ success: false, message: "Something went wrong." });
  }
});

app.put("/admin/reactivateTrip", async (req, res) => {
  const { tripId } = req.body;
  const connection = db.promise();

  try {
    // Update trip status
    await connection.query(
      "UPDATE trip SET STATUS_TRIP = 'Pending' WHERE TRIP_ID = ?",
      [tripId]
    );

    // Fetch trip details
    const [tripInfo] = await connection.query(
      `SELECT DEPARTURE_LOCATION, DESTINATION_LOCATION, DEPARTURE_TIME, TRIP_DATE
       FROM trip WHERE TRIP_ID = ?`,
      [tripId]
    );

    if (tripInfo.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Trip not found" });
    }

    const {
      DEPARTURE_LOCATION,
      DESTINATION_LOCATION,
      DEPARTURE_TIME,
      TRIP_DATE,
    } = tripInfo[0];

    const formattedDate = new Date(TRIP_DATE).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const tripMessage = `Your trip from ${DEPARTURE_LOCATION} to ${DESTINATION_LOCATION} on ${formattedDate} at ${DEPARTURE_TIME} is reactivated.`;

    // 1. Notify passengers
    const [passengers] = await connection.query(
      `SELECT u.FCM_TOKEN
       FROM book b
       JOIN users u ON b.USER_ID = u.USER_ID
       WHERE b.TRIP_ID = ? AND u.FCM_TOKEN IS NOT NULL`,
      [tripId]
    );

    const passengerTokens = passengers.map((p) => p.FCM_TOKEN).filter(Boolean);

    if (passengerTokens.length > 0) {
      await sendNotificationToPassengers(
        passengerTokens,
        "Trip Reactivated",
        tripMessage
      );
    }

    // 2. Notify driver
    const [driverResult] = await connection.query(
      `SELECT d.DRIVER_ID, u.FCM_TOKEN, u.FULL_NAME
       FROM driver_captin_trip d
       JOIN users u ON d.DRIVER_ID = u.USER_ID
       WHERE d.TRIP_ID = ? AND u.FCM_TOKEN IS NOT NULL`,
      [tripId]
    );

    if (driverResult.length > 0) {
      const driver = driverResult[0];
      const driverMsg = `Hi ${driver.FULL_NAME}, your trip from ${DEPARTURE_LOCATION} to ${DESTINATION_LOCATION} on ${formattedDate} at ${DEPARTURE_TIME} is reactivated.`;

      await sendNotificationToPassengers(
        [driver.FCM_TOKEN],
        "Trip Reactivated",
        driverMsg
      );
    }

    res.json({
      success: true,
      message: "Trip reactivated and notifications sent.",
    });
  } catch (err) {
    console.error("Error reactivating trip:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update Trip with full notifications logic
app.put("/admin/updateTrip", async (req, res) => {
  const {
    departure,
    destination,
    price,
    date,
    departureTime,
    returnTime,
    stops,
    busId,
    driverId,
    managerId,
    departureCoords,
    tripId,
  } = req.body;

  const connection = db.promise();

  try {
    // Fetch old trip info
    const [oldTrip] = await connection.query(
      `SELECT t.DEPARTURE_LOCATION, t.DESTINATION_LOCATION, t.SEAT_PRICE,
              t.TRIP_DATE, t.DEPARTURE_TIME, t.RETURN_TIME,
              dct.DRIVER_ID
       FROM trip t
       JOIN driver_captin_trip dct ON t.TRIP_ID = dct.TRIP_ID
       WHERE t.TRIP_ID = ?`,
      [tripId]
    );

    const old = oldTrip[0];
    const oldDriverId = old.DRIVER_ID;
    const oldDepartureTime = old.DEPARTURE_TIME;
    const oldSeatPrice = old.SEAT_PRICE;
    const oldReturnTime = old.RETURN_TIME;
    const oldTripDate = old.TRIP_DATE;

    // Update trip
    await connection.query(
      `UPDATE trip SET
        TRIP_DATE = ?, 
        DEPARTURE_TIME = ?, 
        RETURN_TIME = ?, 
        SEAT_PRICE = ?, 
        MANAGER_ID = ?, 
        DESTINATION_LOCATION = ?, 
        DEPARTURE_LOCATION = ?, 
        DEPARTURE_COORDS = ?
      WHERE TRIP_ID = ?`,
      [
        date,
        departureTime,
        returnTime,
        price,
        managerId,
        destination,
        departure,
        departureCoords || null,
        tripId,
      ]
    );

    // Update driver & bus
    await connection.query(
      `UPDATE driver_captin_trip SET DRIVER_ID = ?, BUS_ID = ? WHERE TRIP_ID = ?`,
      [driverId, busId, tripId]
    );

    // Delete old stops & insert new ones
    await connection.query(
      "DELETE FROM trip_specific_location WHERE TRIP_ID = ?",
      [tripId]
    );

    if (Array.isArray(stops) && stops.length > 0) {
      const stopQueries = stops.map((stop) =>
        connection.query(
          "INSERT INTO trip_specific_location (TRIP_ID, SPECIFIC_LOCATION, LOCATION_GEO) VALUES (?, ?, ?)",
          [tripId, stop.SPECIFIC_LOCATION, stop.LOCATION_GEO]
        )
      );
      await Promise.all(stopQueries);
    }

    // Notify old driver if changed
    if (oldDriverId !== driverId) {
      const [oldDriver] = await connection.query(
        "SELECT FCM_TOKEN FROM users WHERE USER_ID = ? AND FCM_TOKEN IS NOT NULL",
        [oldDriverId]
      );

      if (oldDriver.length > 0) {
        await sendNotificationToPassengers(
          [oldDriver[0].FCM_TOKEN],
          "Trip Update",
          "You have been unassigned from a trip. Please check your schedule."
        );
      }
    }

    // Notify new driver
    const [newDriver] = await connection.query(
      "SELECT FULL_NAME, FCM_TOKEN FROM users WHERE USER_ID = ? AND FCM_TOKEN IS NOT NULL",
      [driverId]
    );

    if (newDriver.length > 0) {
      const { FULL_NAME, FCM_TOKEN } = newDriver[0];
      const formattedDate = new Date(date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const time = departureTime.slice(0, 5);
      const msg = `Hi ${FULL_NAME}, you have a new trip from ${departure} to ${destination} on ${formattedDate} at ${time}.`;
      await sendNotificationToPassengers([FCM_TOKEN], "New Trip Assigned", msg);
    }

    // Notify passengers if trip info changed
    const tripChanged =
      oldDepartureTime !== departureTime ||
      oldSeatPrice !== price ||
      oldReturnTime !== returnTime ||
      oldTripDate !== date;

    if (tripChanged) {
      const [passengers] = await connection.query(
        `SELECT u.FCM_TOKEN FROM book b
         JOIN users u ON b.USER_ID = u.USER_ID
         WHERE b.TRIP_ID = ? AND u.FCM_TOKEN IS NOT NULL`,
        [tripId]
      );

      const passengerTokens = passengers
        .map((p) => p.FCM_TOKEN)
        .filter(Boolean);

      if (passengerTokens.length > 0) {
        await sendNotificationToPassengers(
          passengerTokens,
          "Trip Updated",
          "Your booked trip details have been updated. Please check the app."
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Update trip error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/admin/dashboardStats", async (req, res) => {
  const manager_id = req.query.manager_id;
  if (!manager_id) {
    return res
      .status(400)
      .json({ success: false, message: "Missing manager_id" });
  }

  const connection = db.promise();

  try {
    const [
      [buses],
      [trips],
      [completedTrips],
      [passengers],
      [drivers],
      [revenueToday],
      [revenueYesterday],
      [bookedSeats],
      [totalSeats],
    ] = await Promise.all([
      connection.execute(
        `SELECT COUNT(*) AS count
         FROM bus b
         WHERE b.MANAGER_ID = ? 
         AND b.BUS_AVAILABILITY != 1
         AND NOT EXISTS (
         SELECT 1
        FROM driver_captin_trip dct
        JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
        WHERE dct.BUS_ID = b.BUS_ID
         AND t.TRIP_DATE = CURDATE()
        AND DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 3 HOUR), '%H:%i:%s') BETWEEN t.DEPARTURE_TIME AND t.RETURN_TIME
  );
`,
        [manager_id]
      ),
      connection.execute(
        `SELECT COUNT(*) AS count FROM trip WHERE MANAGER_ID = ? AND STATUS_TRIP = 'active' AND TRIP_DATE = CURDATE()`,
        [manager_id]
      ),
      connection.execute(
        `SELECT COUNT(*) AS count FROM trip WHERE MANAGER_ID = ? AND STATUS_TRIP = 'complete' AND TRIP_DATE = CURDATE()`,
        [manager_id]
      ),
      connection.execute(
        `SELECT COUNT(*) AS count FROM user_follow_manager WHERE MANAGER_ID = ? AND USER_STATUS = 1`,
        [manager_id]
      ),
      connection.execute(
        `SELECT COUNT(*) AS count
        FROM driver d
        WHERE d.MANAGER_ID = ? 
       AND d.AVAILABILITY != 1
       AND NOT EXISTS (
      SELECT 1
      FROM driver_captin_trip dct
      JOIN trip t ON dct.TRIP_ID = t.TRIP_ID
      WHERE dct.DRIVER_ID = d.DRIVER_ID
      AND t.TRIP_DATE = CURDATE()
      AND DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 3 HOUR), '%H:%i:%s') BETWEEN t.DEPARTURE_TIME AND t.RETURN_TIME
  );
`,
        [manager_id]
      ),
      connection.execute(
        `SELECT SUM(PAYMENT) AS total FROM book 
         JOIN trip ON book.TRIP_ID = trip.TRIP_ID 
         WHERE CHECK_PAY = 1 AND PAYMENT_DATE = CURDATE() AND trip.MANAGER_ID = ?`,
        [manager_id]
      ),
      connection.execute(
        `SELECT SUM(PAYMENT) AS total FROM book 
         JOIN trip ON book.TRIP_ID = trip.TRIP_ID 
         WHERE CHECK_PAY = 1 AND PAYMENT_DATE = CURDATE() - INTERVAL 1 DAY AND trip.MANAGER_ID = ?`,
        [manager_id]
      ),
      connection.execute(
        `SELECT COUNT(*) AS count FROM book 
         JOIN trip ON book.TRIP_ID = trip.TRIP_ID 
         WHERE CHECK_PAY = 1 AND book.PAYMENT_DATE = CURDATE() AND trip.MANAGER_ID = ?`,
        [manager_id]
      ),
      connection.execute(
        `SELECT SUM(b.CAPACITY) AS total FROM trip t 
         JOIN driver_captin_trip dct ON t.TRIP_ID = dct.TRIP_ID 
         JOIN bus b ON dct.BUS_ID = b.BUS_ID 
         WHERE t.TRIP_DATE = CURDATE() AND t.MANAGER_ID = ?`,
        [manager_id]
      ),
    ]);

    const seatRate = totalSeats[0].total
      ? ((bookedSeats[0].count / totalSeats[0].total) * 100).toFixed(1) + "%"
      : "0%";

    function calcGrowth(today, yesterday) {
      if (!yesterday || yesterday === 0) return "--%";
      return (((today - yesterday) / yesterday) * 100).toFixed(1) + "%";
    }

    res.json({
      success: true,
      stats: {
        buses: { value: buses[0].count },
        trips: { value: trips[0].count },
        completedTrips: { value: completedTrips[0].count },
        passengers: { value: passengers[0].count },
        drivers: { value: drivers[0].count },
        revenue: {
          value: revenueToday[0].total || 0,
          growth: calcGrowth(
            revenueToday[0].total || 0,
            revenueYesterday[0].total || 0
          ),
        },
        seatOccupancy: { value: seatRate },
      },
    });
  } catch (err) {
    console.error("Error in /admin/dashboardStats:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/admin/passengerTraffic", async (req, res) => {
  const manager_id = req.query.manager_id;
  if (!manager_id) {
    return res
      .status(400)
      .json({ success: false, message: "Missing manager_id" });
  }

  const connection = db.promise();
  try {
    const [thisWeekResult, lastWeekResult] = await Promise.all([
      connection.execute(
        `SELECT DAYNAME(PAYMENT_DATE) AS day, COUNT(*) AS count
         FROM book
         JOIN trip ON book.TRIP_ID = trip.TRIP_ID
         WHERE trip.MANAGER_ID = ?
           AND CHECK_PAY = 1
           AND YEARWEEK(PAYMENT_DATE, 1) = YEARWEEK(CURDATE(), 1)
         GROUP BY day`,
        [manager_id]
      ),
      connection.execute(
        `SELECT DAYNAME(PAYMENT_DATE) AS day, COUNT(*) AS count
         FROM book
         JOIN trip ON book.TRIP_ID = trip.TRIP_ID
         WHERE trip.MANAGER_ID = ?
           AND CHECK_PAY = 1
           AND YEARWEEK(PAYMENT_DATE, 1) = YEARWEEK(CURDATE() - INTERVAL 1 WEEK, 1)
         GROUP BY day`,
        [manager_id]
      ),
    ]);

    const thisWeek = thisWeekResult[0];
    const lastWeek = lastWeekResult[0];

    const weekDays = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    const formatCounts = (data) => {
      const map = Object.fromEntries(data.map((d) => [d.day, d.count]));
      return weekDays.map((day) => map[day] || 0);
    };

    res.json({
      success: true,
      days: weekDays,
      thisWeek: formatCounts(thisWeek),
      lastWeek: formatCounts(lastWeek),
    });
  } catch (err) {
    console.error("Error in /admin/passengerTraffic:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/admin/revenuePerDay", async (req, res) => {
  const manager_id = req.query.manager_id;

  if (!manager_id) {
    return res
      .status(400)
      .json({ success: false, message: "Missing manager_id" });
  }

  const connection = db.promise();

  try {
    const [rows] = await connection.execute(
      `
      SELECT 
        DAYNAME(DATE(PAYMENT_DATE)) AS day,
        SUM(PAYMENT) AS revenue
      FROM book
      JOIN trip ON book.TRIP_ID = trip.TRIP_ID
      WHERE 
        CHECK_PAY = 1 AND 
        trip.MANAGER_ID = ? AND 
        WEEK(PAYMENT_DATE, 1) = WEEK(CURDATE(), 1) AND 
        YEAR(PAYMENT_DATE) = YEAR(CURDATE())
      GROUP BY day
      ORDER BY FIELD(day, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
      `,
      [manager_id]
    );

    const formatted = rows.map((r) => ({
      day: r.day,
      revenue: Number(r.revenue),
    }));

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("Error in /admin/revenuePerDay:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/admin/revenuePerMonth", async (req, res) => {
  const manager_id = req.query.manager_id;
  if (!manager_id) {
    return res
      .status(400)
      .json({ success: false, message: "Missing manager_id" });
  }

  try {
    const [rows] = await db.promise().execute(
      `SELECT 
         DATE_FORMAT(b.PAYMENT_DATE, '%Y-%m') AS month,
         SUM(b.PAYMENT) AS total_revenue
       FROM 
         book b
       JOIN 
         trip t ON b.TRIP_ID = t.TRIP_ID
       WHERE 
         b.CHECK_PAY = 1 AND t.MANAGER_ID = ?
       GROUP BY month
       ORDER BY month ASC`,
      [manager_id]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Revenue Per Month Error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Server start
app.listen(1111, () => {
  console.log(`Server is running on port 1111`);
});
