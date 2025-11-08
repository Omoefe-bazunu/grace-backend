// // server.js (updated)
// require("dotenv").config();
// const express = require("express");
// const jwt = require("jsonwebtoken");
// const bcrypt = require("bcryptjs");
// const admin = require("firebase-admin");
// const cors = require("cors");
// const multer = require("multer");
// const fs = require("fs").promises;
// const app = express();
// app.use(express.json({ limit: "150mb" }));
// app.use(cors({ origin: "*" }));
// const JWT_SECRET = process.env.JWT_SECRET;
// const PORT = process.env.PORT || 4000;
// if (!JWT_SECRET) {
//   console.error("JWT_SECRET missing in environment variables");
//   process.exit(1);
// }

// // === Firebase Admin Initialization ===
// let bucket;
// try {
//   const serviceAccount = require("./serviceAccountKey.json");
//   admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
//     storageBucket: "grace-cc555.firebasestorage.app", // Fixed bucket name
//   });
//   bucket = admin.storage().bucket();
//   console.log("✓ Firebase Admin + Storage initialized successfully");
//   console.log("✓ Bucket name:", bucket.name);
// } catch (err) {
//   console.error("✗ Firebase initialization failed:", err.message);
//   process.exit(1);
// }

// const db = admin.firestore();

// // === Multer Configuration ===
// const upload = multer({
//   dest: "tmp/",
//   limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
// });

// // === Middleware: Authentication ===
// const authenticate = (req, res, next) => {
//   const token = req.headers.authorization?.split(" ")[1];
//   if (!token)
//     return res.status(401).json({ error: "No authentication token provided" });
//   try {
//     req.user = jwt.verify(token, JWT_SECRET);
//     next();
//   } catch (err) {
//     res.status(401).json({ error: "Invalid or expired token" });
//   }
// };

// // === Middleware: Admin Check ===
// const requireAdmin = async (req, res, next) => {
//   try {
//     const adminDoc = await db.collection("admins").doc(req.user.email).get();
//     if (!adminDoc.exists) {
//       return res.status(403).json({ error: "Admin privileges required" });
//     }
//     next();
//   } catch (err) {
//     res.status(403).json({ error: "Failed to verify admin status" });
//   }
// };

// // === Helper: Convert Firestore Timestamp ===
// const toISO = (field) => {
//   if (!field) return new Date().toISOString();
//   return (field.toDate ? field.toDate() : new Date(field)).toISOString();
// };

// // === AUTH ROUTES ===
// app.post("/register", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password) {
//       return res.status(400).json({ error: "Email and password are required" });
//     }
//     const userDoc = await db.collection("users").doc(email).get();
//     if (userDoc.exists) {
//       return res.status(409).json({ error: "User already exists" });
//     }
//     const hashedPassword = await bcrypt.hash(password, 10);
//     await db.collection("users").doc(email).set({
//       password: hashedPassword,
//       createdAt: new Date(),
//     });
//     res.json({ message: "User registered successfully" });
//   } catch (err) {
//     console.error("Registration error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password) {
//       return res.status(400).json({ error: "Email and password are required" });
//     }
//     const userDoc = await db.collection("users").doc(email).get();
//     if (!userDoc.exists) {
//       return res.status(401).json({ error: "Invalid credentials" });
//     }
//     const userData = userDoc.data();
//     const isValidPassword = await bcrypt.compare(password, userData.password);
//     if (!isValidPassword) {
//       return res.status(401).json({ error: "Invalid credentials" });
//     }
//     const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
//     res.json({ token, email });
//   } catch (err) {
//     console.error("Login error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // === READ ROUTES ===
// app.get("/api/:collection", authenticate, async (req, res) => {
//   try {
//     const { collection } = req.params;
//     const { limit, category } = req.query;
//     let query = db.collection(collection).orderBy("createdAt", "desc");
//     if (category) {
//       query = query.where("category", "==", category);
//     }
//     if (limit) {
//       query = query.limit(parseInt(limit));
//     }
//     const snapshot = await query.get();
//     const documents = snapshot.docs.map((doc) => {
//       const data = doc.data();
//       return {
//         id: doc.id,
//         ...data,
//         createdAt: toISO(data.createdAt),
//       };
//     });
//     res.json(documents);
//   } catch (err) {
//     console.error(`Error fetching ${req.params.collection}:`, err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/api/:collection/:id", authenticate, async (req, res) => {
//   try {
//     const { collection, id } = req.params;
//     const doc = await db.collection(collection).doc(id).get();
//     if (!doc.exists) {
//       return res.status(404).json({ error: "Document not found" });
//     }
//     const data = doc.data();
//     res.json({
//       id: doc.id,
//       ...data,
//       createdAt: toISO(data.createdAt),
//     });
//   } catch (err) {
//     console.error(`Error fetching document:`, err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // === WRITE ROUTES ===
// const allowedCollections = [
//   "sermons",
//   "songs",
//   "videos",
//   "notices",
//   "quizResources",
//   "contactMessages",
//   "quizHelpQuestions",
// ];

// app.post("/api/:collection", authenticate, requireAdmin, async (req, res) => {
//   try {
//     const { collection } = req.params;
//     if (!allowedCollections.includes(collection)) {
//       return res
//         .status(403)
//         .json({ error: "Collection not allowed for direct writes" });
//     }
//     if (collection === "sermons") {
//       if (!req.body.title || !req.body.category) {
//         return res
//           .status(400)
//           .json({ error: "Title and category are required for sermons" });
//       }
//     } else if (collection === "songs") {
//       if (!req.body.title || !req.body.category || !req.body.audioUrl) {
//         return res.status(400).json({
//           error: "Title, category, and audio file are required for songs",
//         });
//       }
//     } else if (collection === "videos") {
//       if (!req.body.title || !req.body.videoUrl) {
//         return res
//           .status(400)
//           .json({ error: "Title and video file are required for videos" });
//       }
//     } else if (collection === "notices") {
//       if (!req.body.title || !req.body.message) {
//         return res
//           .status(400)
//           .json({ error: "Title and message are required for notices" });
//       }
//     }
//     const payload = {
//       ...req.body,
//       uploadedBy: req.user.email,
//       createdAt: new Date(),
//     };
//     const docRef = await db.collection(collection).add(payload);
//     res.json({ id: docRef.id, message: "Document created successfully" });
//   } catch (err) {
//     console.error(`Error creating document in ${req.params.collection}:`, err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // === FILE UPLOAD ROUTE ===
// const folderSizeLimits = {
//   notices: 10,
//   sermons: 50,
//   songs: 50,
//   videos: 100,
//   thumbnails: 10,
//   profiles: 5,
//   temps: 100,
//   hymns: 10,
//   assets: 10,
// };

// app.post("/upload", authenticate, upload.single("file"), async (req, res) => {
//   let tempFilePath = null;
//   try {
//     const file = req.file;
//     const { path: destinationPath } = req.body;
//     console.log(
//       "Upload request - File:",
//       file?.originalname,
//       "Destination:",
//       destinationPath
//     );
//     if (!file || !destinationPath) {
//       return res
//         .status(400)
//         .json({ error: "File and destination path are required" });
//     }
//     tempFilePath = file.path;
//     const folder = destinationPath.split("/")[0];
//     const maxSizeMB = folderSizeLimits[folder];
//     if (!maxSizeMB) {
//       return res.status(400).json({ error: "Invalid upload folder" });
//     }
//     if (file.size > maxSizeMB * 1024 * 1024) {
//       return res
//         .status(400)
//         .json({ error: `File size exceeds ${maxSizeMB}MB limit` });
//     }
//     if (
//       folder === "profiles" &&
//       !destinationPath.startsWith(`profiles/${req.user.email}`)
//     ) {
//       return res
//         .status(403)
//         .json({ error: "Can only upload to your own profile folder" });
//     }
//     const [uploadedFile] = await bucket.upload(file.path, {
//       destination: destinationPath,
//       metadata: {
//         contentType: file.mimetype,
//       },
//       public: true,
//     });
//     await uploadedFile.makePublic();
//     const publicUrl = `https://storage.googleapis.com/${
//       bucket.name
//     }/${encodeURIComponent(destinationPath)}`;
//     console.log("Upload successful - URL:", publicUrl);
//     res.json({
//       url: publicUrl,
//       path: destinationPath,
//       message: "File uploaded successfully",
//     });
//   } catch (err) {
//     console.error("File upload error:", err);
//     res.status(500).json({ error: err.message });
//   } finally {
//     if (tempFilePath) {
//       await fs.unlink(tempFilePath).catch(() => {});
//     }
//   }
// });

// // Add to server.js (after other routes, before health check)

// app.post("/api/users/:userId/readNotices", authenticate, async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const { noticeId } = req.body;
//     if (!noticeId) return res.status(400).json({ error: "noticeId required" });

//     const readRef = db
//       .collection("users")
//       .doc(userId)
//       .collection("readNotices")
//       .doc(noticeId);
//     await readRef.set({ readAt: new Date() }, { merge: true });

//     res.json({ message: "Marked as read" });
//   } catch (err) {
//     console.error("Mark read error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/api/users/:userId/readNotices", authenticate, async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const snapshot = await db
//       .collection("users")
//       .doc(userId)
//       .collection("readNotices")
//       .get();
//     const readIds = snapshot.docs.map((doc) => doc.id);
//     res.json(readIds);
//   } catch (err) {
//     console.error("Fetch read notices error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // === HEALTH CHECK ===
// app.get("/health", (req, res) => {
//   res.json({
//     status: "ok",
//     timestamp: new Date().toISOString(),
//     message: "Server is running",
//   });
// });

// // === ERROR HANDLER ===
// app.use((err, req, res, next) => {
//   console.error("Unhandled error:", err);
//   res.status(500).json({ error: "Internal server error" });
// });

// // === START SERVER ===
// app.listen(PORT, () => {
//   console.log(`✓ Server running on port ${PORT}`);
//   console.log(`✓ Health check: http://localhost:${PORT}/health`);
// });

// server.js (CORRECTED - Auth works, CRUD + notices tracking)
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;

const app = express();
app.use(express.json({ limit: "150mb" }));
app.use(cors({ origin: "*" }));

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

if (!JWT_SECRET) {
  console.error("JWT_SECRET missing in environment variables");
  process.exit(1);
}

// Firebase Admin
let bucket;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "grace-cc555.firebasestorage.app",
  });
  bucket = admin.storage().bucket();
  console.log("Firebase Admin + Storage initialized");
} catch (err) {
  console.error("Firebase initialization failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// Multer
const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 150 * 1024 * 1024 },
});

// Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const adminDoc = await db.collection("admins").doc(req.user.email).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  } catch (err) {
    console.error("Admin check failed:", err);
    return res.status(500).json({ error: "Failed to verify admin" });
  }
};

const toISO = (field) => {
  if (!field) return new Date().toISOString();
  if (field.toDate) return field.toDate().toISOString();
  return new Date(field).toISOString();
};

// === AUTH ROUTES ===
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const userDoc = await db.collection("users").doc(email).get();
    if (userDoc.exists)
      return res.status(409).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);
    await db.collection("users").doc(email).set({
      password: hashed,
      createdAt: new Date(),
    });

    res.json({ message: "User registered successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const userDoc = await db.collection("users").doc(email).get();
    if (!userDoc.exists)
      return res.status(401).json({ error: "Invalid credentials" });

    const userData = userDoc.data();
    const valid = await bcrypt.compare(password, userData.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, email });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === READ ROUTES ===
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const { limit, category } = req.query;
    let query = db.collection(collection).orderBy("createdAt", "desc");

    if (category) query = query.where("category", "==", category);
    if (limit) query = query.limit(parseInt(limit));

    const snapshot = await query.get();
    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      createdAt: toISO(doc.data().createdAt),
    }));

    res.json(docs);
  } catch (err) {
    console.error("GET collection error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/:collection/:id", authenticate, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const doc = await db.collection(collection).doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    const data = doc.data();
    res.json({ id: doc.id, ...data, createdAt: toISO(data.createdAt) });
  } catch (err) {
    console.error("GET item error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === WRITE ROUTES ===
const allowedCollections = [
  "sermons",
  "songs",
  "videos",
  "notices",
  "quizResources",
  "contactMessages",
  "quizHelpQuestions",
];

app.post("/api/:collection", authenticate, requireAdmin, async (req, res) => {
  try {
    const { collection } = req.params;
    if (!allowedCollections.includes(collection)) {
      return res
        .status(403)
        .json({ error: "Operation not allowed on this collection" });
    }

    const payload = {
      ...req.body,
      uploadedBy: req.user.email,
      createdAt: new Date(),
    };

    const docRef = await db.collection(collection).add(payload);
    res.json({ id: docRef.id, message: "Created successfully" });
  } catch (err) {
    console.error("POST error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === UPDATE & DELETE ===
app.put(
  "/api/:collection/:id",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { collection, id } = req.params;
      if (!allowedCollections.includes(collection)) {
        return res.status(403).json({ error: "Operation not allowed" });
      }

      await db
        .collection(collection)
        .doc(id)
        .update({
          ...req.body,
          updatedAt: new Date(),
        });

      res.json({ message: "Updated successfully" });
    } catch (err) {
      console.error("PUT error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.delete(
  "/api/:collection/:id",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { collection, id } = req.params;
      if (!allowedCollections.includes(collection)) {
        return res.status(403).json({ error: "Operation not allowed" });
      }

      await db.collection(collection).doc(id).delete();
      res.json({ message: "Deleted successfully" });
    } catch (err) {
      console.error("DELETE error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// === FILE UPLOAD ===
const folderSizeLimits = {
  notices: 10,
  sermons: 50,
  songs: 50,
  videos: 100,
  thumbnails: 10,
  profiles: 5,
  temps: 100,
  hymns: 10,
  assets: 10,
};

app.post("/upload", authenticate, upload.single("file"), async (req, res) => {
  let tempFilePath = null;
  try {
    const file = req.file;
    const { path: destinationPath } = req.body;

    if (!file || !destinationPath) {
      return res
        .status(400)
        .json({ error: "File and destination path required" });
    }

    tempFilePath = file.path;
    const folder = destinationPath.split("/")[0];
    const maxSizeMB = folderSizeLimits[folder];

    if (!maxSizeMB)
      return res.status(400).json({ error: "Invalid upload folder" });
    if (file.size > maxSizeMB * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: `File exceeds ${maxSizeMB}MB limit` });
    }

    if (
      folder === "profiles" &&
      !destinationPath.startsWith(`profiles/${req.user.email}`)
    ) {
      return res
        .status(403)
        .json({ error: "Cannot upload to another user's profile" });
    }

    const [uploadedFile] = await bucket.upload(file.path, {
      destination: destinationPath,
      metadata: { contentType: file.mimetype },
      public: true,
    });

    await uploadedFile.makePublic();
    const publicUrl = `https://storage.googleapis.com/${
      bucket.name
    }/${encodeURIComponent(destinationPath)}`;

    res.json({
      url: publicUrl,
      path: destinationPath,
      message: "Uploaded successfully",
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }
});

// === READ NOTICES TRACKING ===
app.post("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { noticeId } = req.body;

    if (!noticeId)
      return res.status(400).json({ error: "noticeId is required" });

    const readRef = db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .doc(noticeId);
    await readRef.set({ readAt: new Date() }, { merge: true });

    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .get();
    const readIds = snapshot.docs.map((doc) => doc.id);
    res.json(readIds);
  } catch (err) {
    console.error("Fetch read notices error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === HEALTH CHECK ===
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
