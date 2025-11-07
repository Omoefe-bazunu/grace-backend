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

const app = express();
app.use(express.json({ limit: "150mb" }));
app.use(cors({ origin: "*" }));

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

if (!JWT_SECRET) {
  console.error("JWT_SECRET missing");
  process.exit(1);
}

// === Firebase Admin ===
try {
  admin.initializeApp({
    credential: admin.credential.cert("./serviceAccountKey.json"),
    storageBucket: "grace-cc555.appspot.com",
  });
  console.log("Firebase Admin OK");
} catch (err) {
  console.error("Firebase init failed:", err);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// === Multer ===
const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 150 * 1024 * 1024 },
});

// === Auth Middleware ===
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const snap = await db.collection("admins").doc(req.user.email).get();
    if (!snap.exists) throw new Error();
    next();
  } catch {
    res.status(403).json({ error: "Admin required" });
  }
};

// === Helper ===
const toISO = (field) => (field?.toDate?.() || new Date()).toISOString();

// === AUTH ===
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email & password required" });

    const existing = await db.collection("users").doc(email).get();
    if (existing.exists) return res.status(409).json({ error: "User exists" });

    const hash = await bcrypt.hash(password, 10);
    await db
      .collection("users")
      .doc(email)
      .set({ password: hash, createdAt: new Date() });
    res.json({ message: "User created" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email & password required" });

    const snap = await db.collection("users").doc(email).get();
    if (!snap.exists)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = snap.data();
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === READ: List ===
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const { limit, category } = req.query;

    let q = db.collection(collection).orderBy("createdAt", "desc");

    if (collection === "sermons" && category) {
      q = q.where("category", "==", category);
    }

    if (limit) q = q.limit(parseInt(limit));

    const snap = await q.get();
    const data = snap.docs.map((doc) => {
      const d = doc.data();
      return { id: doc.id, ...d, createdAt: toISO(d.createdAt) };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === READ: Single ===
app.get("/api/:collection/:id", authenticate, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const doc = await db.collection(collection).doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    const d = doc.data();
    res.json({ id: doc.id, ...d, createdAt: toISO(d.createdAt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === WRITE: Admin Only ===
const adminCollections = ["sermons", "songs", "videos", "notices"];

app.post("/api/:collection", authenticate, requireAdmin, async (req, res) => {
  try {
    const { collection } = req.params;
    if (!adminCollections.includes(collection)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const payload = {
      ...req.body,
      createdBy: req.user.email,
      createdAt: new Date(),
    };

    // Optional validation
    if (collection === "sermons") {
      if (!payload.title || !payload.category) {
        return res.status(400).json({ error: "Title & category required" });
      }
    }

    const ref = await db.collection(collection).add(payload);
    res.json({ id: ref.id, message: "Created" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === READ NOTICES ===
app.post("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { noticeId } = req.body;
    if (req.user.email !== userId)
      return res.status(403).json({ error: "Forbidden" });

    await db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .doc(noticeId)
      .set({
        readAt: new Date(),
      });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:userId/readNotices", authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user.email !== userId)
      return res.status(403).json({ error: "Forbidden" });

    const snap = await db
      .collection("users")
      .doc(userId)
      .collection("readNotices")
      .get();
    res.json(snap.docs.map((d) => d.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === UPLOAD ===
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

app.post("/upload", authenticate, upload.single("file"), async (req, res) => {
  let filePath = null;
  try {
    const file = req.file;
    const { path: destPath } = req.body;

    if (!file || !destPath)
      return res.status(400).json({ error: "File & path required" });

    filePath = file.path;
    const folder = destPath.split("/")[0];
    const maxMB = sizeLimitsMB[folder];
    if (!maxMB) return res.status(400).json({ error: "Invalid folder" });

    if (file.size > maxMB * 1024 * 1024) {
      return res.status(400).json({ error: `Max ${maxMB}MB` });
    }

    if (
      folder === "profiles" &&
      !destPath.startsWith(`profiles/${req.user.email}`)
    ) {
      return res.status(403).json({ error: "Own profile only" });
    }

    await bucket.upload(file.path, {
      destination: destPath,
      metadata: { contentType: file.mimetype },
    });

    const url = `https://storage.googleapis.com/${
      bucket.name
    }/${encodeURIComponent(destPath)}`;
    res.json({ url, path: destPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
});

// === HEALTH ===
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// === 404 & Error ===
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => {
  console.log(`Backend LIVE on ${PORT}`);
});
