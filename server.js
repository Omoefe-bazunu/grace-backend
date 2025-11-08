// server.js
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

// TEXT TO SPEECH IMPORTS
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { Storage } = require("@google-cloud/storage");
const crypto = require("crypto");

// Initialize Google TTS Client
const ttsClient = new TextToSpeechClient();

// TTS Configuration
const TTS_CONFIG = {
  maxChunkSize: 4000,
  audioEncoding: "MP3",
  speakingRate: 1.0,
  cacheTtl: 30 * 24 * 60 * 60 * 1000, // 30 days cache
};

// END OF TTS IMPORTS

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

      // Use admin SDK: bypasses security rules
      await db
        .collection(collection)
        .doc(id)
        .update({
          ...req.body,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

      // Use admin SDK: bypasses security rules
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

// === TEXT TO SPEECH ===

// TTS Cache Model
class TTSCache {
  constructor() {
    this.db = db;
  }

  async getCachedAudio(text, voiceConfig) {
    const hash = this.generateHash(text, voiceConfig);
    const cacheDoc = await this.db.collection("ttsCache").doc(hash).get();

    if (cacheDoc.exists) {
      const data = cacheDoc.data();
      // Check if cache is still valid
      if (Date.now() - data.timestamp < TTS_CONFIG.cacheTtl) {
        return data.audioContent;
      }
    }
    return null;
  }

  async setCachedAudio(text, voiceConfig, audioContent) {
    const hash = this.generateHash(text, voiceConfig);
    await this.db.collection("ttsCache").doc(hash).set({
      audioContent,
      textLength: text.length,
      voiceConfig,
      timestamp: Date.now(),
      accessedCount: 0,
    });
  }

  async incrementAccessCount(text, voiceConfig) {
    const hash = this.generateHash(text, voiceConfig);
    const docRef = this.db.collection("ttsCache").doc(hash);
    await docRef.update({
      accessedCount: admin.firestore.FieldValue.increment(1),
      lastAccessed: Date.now(),
    });
  }

  generateHash(text, voiceConfig) {
    return crypto
      .createHash("md5")
      .update(text + JSON.stringify(voiceConfig))
      .digest("hex");
  }

  // Clean up old cache entries (run as cron job)
  async cleanupOldCache(ttl = TTS_CONFIG.cacheTtl) {
    const cutoff = Date.now() - ttl;
    const snapshot = await this.db
      .collection("ttsCache")
      .where("timestamp", "<", cutoff)
      .get();

    const batch = this.db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    return snapshot.size;
  }
}

const ttsCache = new TTSCache();

// Smart text chunking function
function splitTextIntoChunks(text) {
  if (!text || text.length <= TTS_CONFIG.maxChunkSize) {
    return [text];
  }

  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= TTS_CONFIG.maxChunkSize) {
      currentChunk += (currentChunk ? " " : "") + sentence;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      // If a single sentence is too long, split by words
      if (sentence.length > TTS_CONFIG.maxChunkSize) {
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if ((currentChunk + word).length <= TTS_CONFIG.maxChunkSize) {
            currentChunk += (currentChunk ? " " : "") + word;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = word;
          }
        }
      } else {
        currentChunk = sentence;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Get voice configuration based on language
function getVoiceConfig(language = "en-US") {
  const voices = {
    en: { languageCode: "en-US", name: "en-US-Neural2-F" },
    es: { languageCode: "es-ES", name: "es-ES-Neural2-B" },
    fr: { languageCode: "fr-FR", name: "fr-FR-Neural2-B" },
    zh: { languageCode: "cmn-CN", name: "cmn-CN-Neural2-A" },
  };

  const langCode = language.split("-")[0];
  return voices[langCode] || voices["en"];
}

// === TTS ROUTES ===

// Generate TTS for a sermon
app.post("/api/tts/generate", authenticate, async (req, res) => {
  try {
    const { text, language = "en-US", sermonId } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const voiceConfig = getVoiceConfig(language);
    const chunks = splitTextIntoChunks(text);

    // Check cache first for all chunks
    const cachedChunks = [];
    const chunksToGenerate = [];

    for (const chunk of chunks) {
      const cachedAudio = await ttsCache.getCachedAudio(chunk, voiceConfig);
      if (cachedAudio) {
        cachedChunks.push({
          text: chunk,
          audioContent: cachedAudio,
          cached: true,
        });
      } else {
        chunksToGenerate.push(chunk);
      }
    }

    // Generate TTS for non-cached chunks
    const generationPromises = chunksToGenerate.map(async (chunk) => {
      try {
        const [response] = await ttsClient.synthesizeSpeech({
          input: { text: chunk },
          voice: voiceConfig,
          audioConfig: {
            audioEncoding: TTS_CONFIG.audioEncoding,
            speakingRate: TTS_CONFIG.speakingRate,
          },
        });

        const audioContent = response.audioContent.toString("base64");

        // Cache the result
        await ttsCache.setCachedAudio(chunk, voiceConfig, audioContent);

        return { text: chunk, audioContent, cached: false };
      } catch (error) {
        console.error("TTS generation error for chunk:", error);
        throw error;
      }
    });

    const generatedChunks = await Promise.all(generationPromises);
    const allChunks = [...cachedChunks, ...generatedChunks];

    // Track TTS usage for analytics
    if (sermonId && req.user.email) {
      await db.collection("ttsUsage").add({
        sermonId,
        userId: req.user.email,
        chunksCount: allChunks.length,
        cachedChunks: cachedChunks.length,
        totalCharacters: text.length,
        language,
        timestamp: new Date(),
      });
    }

    res.json({
      chunks: allChunks,
      totalChunks: allChunks.length,
      cachedChunks: cachedChunks.length,
      generatedChunks: generatedChunks.length,
    });
  } catch (error) {
    console.error("TTS generation error:", error);
    res.status(500).json({ error: "Failed to generate TTS audio" });
  }
});

//
// Get pre-signed URLs for TTS audio (if storing in cloud storage)
app.post("/api/tts/get-audio-urls", authenticate, async (req, res) => {
  try {
    const { chunkHashes } = req.body;

    if (!Array.isArray(chunkHashes)) {
      return res.status(400).json({ error: "chunkHashes array is required" });
    }

    const audioUrls = [];
    const storage = new Storage();

    for (const hash of chunkHashes) {
      const file = bucket.file(`tts/${hash}.mp3`);

      try {
        const [exists] = await file.exists();
        if (exists) {
          const [url] = await file.getSignedUrl({
            version: "v4",
            action: "read",
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
          });
          audioUrls.push({ hash, url });
        }
      } catch (error) {
        console.error("Error getting signed URL for hash:", hash, error);
      }
    }

    res.json({ audioUrls });
  } catch (error) {
    console.error("Get audio URLs error:", error);
    res.status(500).json({ error: "Failed to get audio URLs" });
  }
});

// TTS Analytics endpoint (admin only)
app.get(
  "/api/admin/tts-analytics",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { days = 30 } = req.query;
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Get usage statistics
      const usageSnapshot = await db
        .collection("ttsUsage")
        .where("timestamp", ">=", cutoffDate)
        .get();

      const cacheSnapshot = await db
        .collection("ttsCache")
        .where("timestamp", ">=", cutoffDate)
        .get();

      const analytics = {
        totalRequests: usageSnapshot.size,
        totalCharacters: 0,
        cacheHitRate: 0,
        popularLanguages: {},
        topUsers: {},
        cacheStats: {
          totalEntries: cacheSnapshot.size,
          totalAccesses: 0,
        },
      };

      usageSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        analytics.totalCharacters += data.totalCharacters;

        // Language stats
        analytics.popularLanguages[data.language] =
          (analytics.popularLanguages[data.language] || 0) + 1;

        // User stats
        analytics.topUsers[data.userId] =
          (analytics.topUsers[data.userId] || 0) + 1;
      });

      cacheSnapshot.docs.forEach((doc) => {
        analytics.cacheStats.totalAccesses += doc.data().accessedCount || 0;
      });

      if (usageSnapshot.size > 0) {
        analytics.cacheHitRate =
          (analytics.cacheStats.totalAccesses / usageSnapshot.size) * 100;
      }

      res.json(analytics);
    } catch (error) {
      console.error("TTS analytics error:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  }
);

// Batch TTS generation for multiple sermons (admin tool)
app.post(
  "/api/admin/tts/pregenerate",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { sermonIds, languages = ["en"] } = req.body;

      const sermonsSnapshot = await db
        .collection("sermons")
        .where(admin.firestore.FieldPath.documentId(), "in", sermonIds)
        .get();

      const results = [];

      for (const doc of sermonsSnapshot.docs) {
        const sermon = doc.data();
        const content = sermon.translations?.en || sermon.content;

        if (!content) continue;

        for (const language of languages) {
          try {
            const voiceConfig = getVoiceConfig(language);
            const chunks = splitTextIntoChunks(content);

            // Generate and cache all chunks
            for (const chunk of chunks) {
              const [response] = await ttsClient.synthesizeSpeech({
                input: { text: chunk },
                voice: voiceConfig,
                audioConfig: { audioEncoding: TTS_CONFIG.audioEncoding },
              });

              const audioContent = response.audioContent.toString("base64");
              await ttsCache.setCachedAudio(chunk, voiceConfig, audioContent);
            }

            results.push({
              sermonId: doc.id,
              language,
              chunks: chunks.length,
              status: "success",
            });
          } catch (error) {
            results.push({
              sermonId: doc.id,
              language,
              status: "error",
              error: error.message,
            });
          }
        }
      }

      res.json({ results });
    } catch (error) {
      console.error("Pregenerate TTS error:", error);
      res.status(500).json({ error: "Failed to pregenerate TTS" });
    }
  }
);

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
