/**
 * server.js
 *
 * Backend for Haven App (Expo + Next.js)
 *
 * - JWT-based auth (no Firebase Auth)
 * - Admin check via /admins/{uid} document
 * - File upload with size validation (matches Storage rules)
 * - All Firestore writes go through here
 * - Deploy on Render.com
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;

// === CONFIG ===
const app = express();
app.use(express.json({ limit: "150mb" })); // Allow large payloads
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

// === FIREBASE ADMIN SETUP ===
admin.initializeApp({
  credential: admin.credential.cert("./serviceAccountKey.json"),
  storageBucket: "grace-cc555.appspot.com",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// === MULTER: Temp storage before upload ===
const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB max
});

// === HELPERS ===

// Verify JWT and return user email
const authenticate = (req) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) throw new Error("No token");
  return jwt.verify(token, JWT_SECRET); // { email }
};

// Check if user is admin (exists in /admins/{uid})
const requireAdmin = async (email) => {
  const uid = email; // Using email as UID for simplicity
  const adminDoc = await db.collection("admins").doc(uid).get();
  if (!adminDoc.exists) throw new Error("Admin access required");
};

// === AUTH ENDPOINTS ===

// REGISTER: Create user in Firestore (password hashed)
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Missing fields" });

    const hash = await bcrypt.hash(password, 10);
    await db
      .collection("users")
      .doc(email)
      .set({ password: hash }, { merge: true });

    res.json({ message: "User created" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

// LOGIN: Return JWT
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const userDoc = await db.collection("users").doc(email).get();

    if (!userDoc.exists)
      return res.status(401).json({ error: "Invalid credentials" });

    const { password: hash } = userDoc.data();
    const match = await bcrypt.compare(password, hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/me", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const { email } = jwt.verify(token, JWT_SECRET);
    res.json({ email });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// === PROTECTED: SAVE NOTE (Admin only) ===
app.post("/notes", async (req, res) => {
  try {
    const user = authenticate(req);
    await requireAdmin(user.email);

    const { text } = req.body;
    await db.collection("notes").add({
      text,
      createdBy: user.email,
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// === PROTECTED: UPLOAD FILE (Size + Path Validation) ===
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const user = authenticate(req);
    const file = req.file;
    const { path: uploadPath } = req.body; // e.g., "sermons/audio.mp3"

    if (!file || !uploadPath)
      return res.status(400).json({ error: "File and path required" });

    // === VALIDATE PATH & SIZE (Matches your Storage rules) ===
    const validPaths = [
      "notices",
      "sermons",
      "songs",
      "videos",
      "thumbnails",
      "hymns",
      "profiles",
      "assets",
      "temps",
    ];
    const folder = uploadPath.split("/")[0];
    if (!validPaths.includes(folder)) {
      return res.status(400).json({ error: "Invalid upload path" });
    }

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

    const maxSize = sizeLimitsMB[folder] * 1024 * 1024;
    if (file.size > maxSize) {
      await fs.unlink(file.path); // Clean up
      return res
        .status(400)
        .json({ error: `File too large (max ${sizeLimitsMB[folder]} MB)` });
    }

    // === UPLOAD TO FIREBASE STORAGE ===
    const destination = uploadPath;
    await bucket.upload(file.path, {
      destination,
      metadata: { contentType: file.mimetype },
    });

    // Clean up temp file
    await fs.unlink(file.path);

    const fileUrl = `https://storage.googleapis.com/${
      bucket.name
    }/${encodeURIComponent(destination)}`;
    res.json({ url: fileUrl });
  } catch (err) {
    // Clean up on error
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    res.status(401).json({ error: err.message });
  }
});

// === PROTECTED: DELETE FILE (Admin only) ===
app.delete("/file", async (req, res) => {
  try {
    const user = authenticate(req);
    await requireAdmin(user.email);

    const { path } = req.body;
    if (!path) return res.status(400).json({ error: "Path required" });

    await bucket.file(path).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Bucket: grace-cc555.appspot.com`);
});
