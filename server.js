// server.js
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const cors = require("cors");
const multer = require("multer");
const upload = multer({ dest: "tmp/" });

const app = express();
app.use(express.json({ limit: "150mb" }));
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

// === Firebase Admin (bypasses rules) ===
admin.initializeApp({
  credential: admin.credential.cert("./serviceAccountKey.json"),
  storageBucket: "grace-cc555.appspot.com",
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

// === JWT Auth Middleware ===
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
    const uid = req.user.email;
    const adminDoc = await db.collection("admins").doc(uid).get();
    if (!adminDoc.exists) throw new Error("Admin required");
    next();
  } catch {
    res.status(403).json({ error: "Admin access required" });
  }
};

// === AUTH ===
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await db.collection("users").doc(email).set({ password: hash });
    res.json({ message: "User created" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const snap = await db.collection("users").doc(email).get();
    if (
      !snap.exists ||
      !(await bcrypt.compare(password, snap.data().password))
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === READ ANY COLLECTION (requires auth per rules) ===
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const snapshot = await db.collection(collection).get();
    const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === WRITE TO ADMIN-ONLY COLLECTIONS ===
const adminCollections = ["sermons", "songs", "videos", "notices"];
app.post("/api/:collection", authenticate, requireAdmin, async (req, res) => {
  try {
    const { collection } = req.params;
    if (!adminCollections.includes(collection)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    const docRef = await db.collection(collection).add({
      ...req.body,
      createdBy: req.user.email,
      createdAt: new Date(),
    });
    res.json({ id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === SINGLE DOC GET ===
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const { limit } = req.query;

    let q = db.collection(collection);
    if (limit) q = q.orderBy("createdAt", "desc").limit(parseInt(limit));

    const snapshot = await q.get();
    const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(data);
  } catch (err) {
    console.error("GET /api error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === READ NOTICES BY USER (subcollection) ===
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
      .set({ readAt: new Date() });
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

// === UPLOAD FILE (respects Storage rules) ===
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
  try {
    const file = req.file;
    const { path: destPath } = req.body; // e.g., "sermons/audio.mp3"
    if (!file || !destPath)
      return res.status(400).json({ error: "File and path required" });

    const folder = destPath.split("/")[0];
    const maxMB = sizeLimitsMB[folder];
    if (!maxMB) return res.status(400).json({ error: "Invalid path" });
    if (file.size > maxMB * 1024 * 1024) {
      return res.status(400).json({ error: `Max ${maxMB} MB` });
    }

    // Special: profiles/{userId}
    if (
      folder === "profiles" &&
      !destPath.startsWith(`profiles/${req.user.email}`)
    ) {
      return res.status(403).json({ error: "Can only upload to own profile" });
    }

    await bucket.upload(file.path, {
      destination: destPath,
      metadata: { contentType: file.mimetype },
    });

    const url = `https://storage.googleapis.com/${
      bucket.name
    }/${encodeURIComponent(destPath)}`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file?.path)
      await require("fs")
        .promises.unlink(req.file.path)
        .catch(() => {});
  }
});

// === HEALTH ===
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date() }));

app.listen(PORT, () => console.log(`Backend on ${PORT}`));
