// server.js
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");

// Initialize Express app
const app = express();

// Middleware
app.use(express.json({ limit: "150mb" }));
app.use(
  cors({
    origin: "*", // In production, specify your frontend URLs
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET is not set in environment variables");
  process.exit(1);
}

// Multer configuration for file uploads (temporary storage)
const upload = multer({
  dest: "tmp/",
  limits: {
    fileSize: 150 * 1024 * 1024, // 150MB max
  },
});

// ==================== Firebase Admin Setup ====================
try {
  admin.initializeApp({
    credential: admin.credential.cert("./serviceAccountKey.json"),
    storageBucket: "grace-cc555.appspot.com",
  });
  console.log("Firebase Admin initialized successfully");
} catch (error) {
  console.error("Failed to initialize Firebase Admin:", error.message);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ==================== Authentication Middleware ====================

/**
 * Verify JWT token and attach user info to request
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

/**
 * Verify user has admin privileges
 */
const requireAdmin = async (req, res, next) => {
  try {
    const adminDoc = await db.collection("admins").doc(req.user.email).get();

    if (!adminDoc.exists) {
      return res.status(403).json({ error: "Admin access required" });
    }

    next();
  } catch (error) {
    console.error("Admin verification error:", error);
    res.status(403).json({ error: "Admin access required" });
  }
};

// ==================== Helper Functions ====================

/**
 * Convert Firestore Timestamp to ISO string
 */
const toISO = (field) => {
  if (field?.toDate) {
    return field.toDate().toISOString();
  }
  return field instanceof Date ? field.toISOString() : new Date().toISOString();
};

/**
 * Clean up uploaded file from temp directory
 */
const cleanupFile = async (filePath) => {
  try {
    if (filePath) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    console.error("File cleanup error:", error.message);
  }
};

// ==================== Authentication Endpoints ====================

/**
 * Register a new user
 * POST /register
 * Body: { email, password }
 */
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Check if user already exists
    const existingUser = await db.collection("users").doc(email).get();
    if (existingUser.exists) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.collection("users").doc(email).set({
      password: hashedPassword,
      createdAt: new Date(),
    });

    res.json({ message: "User registered successfully" });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Login user and return JWT token
 * POST /login
 * Body: { email, password }
 */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Get user from database
    const userDoc = await db.collection("users").doc(email).get();

    if (!userDoc.exists) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Verify password
    const userData = userDoc.data();
    const isPasswordValid = await bcrypt.compare(password, userData.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate JWT token (valid for 7 days)
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, email });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Collection CRUD Endpoints ====================

/**
 * Get all documents from a collection
 * GET /api/:collection?limit=10&category=value
 * Query params: limit (optional), category (optional, sermons only)
 */
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const { limit, category } = req.query;

    let query = db.collection(collection);

    // Filter by category (currently only for sermons)
    if (collection === "sermons" && category) {
      query = query.where("category", "==", category);
    }

    // Apply sorting and limit
    query = query.orderBy("createdAt", "desc");

    if (limit) {
      const limitNum = parseInt(limit);
      if (limitNum > 0) {
        query = query.limit(limitNum);
      }
    }

    const snapshot = await query.get();

    const data = snapshot.docs.map((doc) => {
      const docData = doc.data();
      return {
        id: doc.id,
        ...docData,
        createdAt: toISO(docData.createdAt),
      };
    });

    res.json(data);
  } catch (error) {
    console.error(`GET /api/${req.params.collection} error:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single document by ID
 * GET /api/:collection/:id
 */
app.get("/api/:collection/:id", authenticate, async (req, res) => {
  try {
    const { collection, id } = req.params;

    const doc = await db.collection(collection).doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const docData = doc.data();
    res.json({
      id: doc.id,
      ...docData,
      createdAt: toISO(docData.createdAt),
    });
  } catch (error) {
    console.error("GET /api/:collection/:id error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create new document (Admin only)
 * POST /api/:collection
 * Body: document data
 */
const adminCollections = ["sermons", "songs", "videos", "notices"];

app.post("/api/:collection", authenticate, requireAdmin, async (req, res) => {
  try {
    const { collection } = req.params;

    // Verify collection is allowed for admin creation
    if (!adminCollections.includes(collection)) {
      return res
        .status(403)
        .json({ error: "Cannot create documents in this collection" });
    }

    // Validate required fields based on collection type
    const validationError = validateDocument(collection, req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Create document
    const docRef = await db.collection(collection).add({
      ...req.body,
      createdBy: req.user.email,
      createdAt: new Date(),
    });

    res.json({
      id: docRef.id,
      message: `${collection} document created successfully`,
    });
  } catch (error) {
    console.error("POST /api/:collection error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validate document data based on collection type
 */
function validateDocument(collection, data) {
  switch (collection) {
    case "sermons":
      if (!data.title || !data.category) {
        return "Sermons require: title, and category";
      }
      break;
    case "songs":
      if (!data.title || !data.audioUrl || !data.category) {
        return "Songs require: title, audioUrl, and category";
      }
      break;
    case "videos":
      if (!data.videoUrl) {
        return "Videos require: videoUrl";
      }
      break;
    case "notices":
      if (!data.title || !data.message) {
        return "Notices require: title and message";
      }
      break;
  }
  return null;
}

// ==================== User-specific Endpoints ====================

/**
 * Mark notice as read for user
 * POST /api/users/:userId/readNotices
 * Body: { noticeId }
 */
app.post("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { noticeId } = req.body;

    // Ensure user can only mark their own notices as read
    if (req.user.email !== userId) {
      return res
        .status(403)
        .json({ error: "Can only update own read notices" });
    }

    if (!noticeId) {
      return res.status(400).json({ error: "noticeId is required" });
    }

    await db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .doc(noticeId)
      .set({ readAt: new Date() });

    res.json({ success: true });
  } catch (error) {
    console.error("Mark notice read error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all read notices for user
 * GET /api/users/:userId/readNotices
 * Returns: array of notice IDs
 */
app.get("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;

    // Ensure user can only get their own read notices
    if (req.user.email !== userId) {
      return res
        .status(403)
        .json({ error: "Can only access own read notices" });
    }

    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .get();

    const readNoticeIds = snapshot.docs.map((doc) => doc.id);
    res.json(readNoticeIds);
  } catch (error) {
    console.error("Get read notices error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== File Upload Endpoint ====================

// File size limits per folder (in MB)
const sizeLimitsMB = {
  notices: 10,
  sermons: 50,
  songs: 50,
  videos: 100,
  thumbnails: 10,
  hymns: 10,
  profiles: 5,
  assets: 10,
  temps: 100,
};

/**
 * Upload file to Firebase Storage
 * POST /upload
 * Body (multipart/form-data): file, path
 */
app.post("/upload", authenticate, upload.single("file"), async (req, res) => {
  let filePath = null;

  try {
    const file = req.file;
    const { path: destPath } = req.body;

    // Validate inputs
    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    if (!destPath) {
      return res.status(400).json({ error: "Destination path required" });
    }

    filePath = file.path;

    // Extract folder from path and validate
    const folder = destPath.split("/")[0];
    const maxSizeMB = sizeLimitsMB[folder];

    if (!maxSizeMB) {
      return res.status(400).json({ error: `Invalid folder: ${folder}` });
    }

    // Check file size
    if (file.size > maxSizeMB * 1024 * 1024) {
      return res.status(400).json({
        error: `File size exceeds ${maxSizeMB}MB limit for ${folder}`,
      });
    }

    // Additional security: users can only upload to their own profile folder
    if (
      folder === "profiles" &&
      !destPath.startsWith(`profiles/${req.user.email}`)
    ) {
      return res
        .status(403)
        .json({ error: "Can only upload to your own profile folder" });
    }

    // Upload to Firebase Storage
    await bucket.upload(file.path, {
      destination: destPath,
      metadata: {
        contentType: file.mimetype,
        metadata: {
          uploadedBy: req.user.email,
          uploadedAt: new Date().toISOString(),
        },
      },
    });

    // Generate public URL
    const encodedPath = encodeURIComponent(destPath);
    const url = `https://storage.googleapis.com/${bucket.name}/${encodedPath}`;

    res.json({ url, path: destPath });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up temp file
    await cleanupFile(filePath);
  }
});

// ==================== Health Check ====================

/**
 * Health check endpoint
 * GET /health
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ==================== Error Handling ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ==================== Server Startup ====================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  Grace Church Backend Server          ║
║  Port: ${PORT}                       ║
║  Status: Running                      ║
║  Time: ${new Date().toISOString()}    ║
╚═══════════════════════════════════════╝
  `);
});
