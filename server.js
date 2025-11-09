// // server.js (with TTS Pre-generation & Caching)
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

// // Firebase Admin
// let bucket;
// try {
//   const serviceAccount = require("./serviceAccountKey.json");
//   admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
//     storageBucket: "grace-cc555.firebasestorage.app",
//   });
//   bucket = admin.storage().bucket();
//   console.log("Firebase Admin + Storage initialized");
// } catch (err) {
//   console.error("Firebase initialization failed:", err.message);
//   process.exit(1);
// }

// const db = admin.firestore();

// // Multer
// const upload = multer({
//   dest: "tmp/",
//   limits: { fileSize: 150 * 1024 * 1024 },
// });

// // Middleware
// const authenticate = (req, res, next) => {
//   const authHeader = req.headers.authorization;
//   if (!authHeader?.startsWith("Bearer ")) {
//     return res.status(401).json({ error: "No token provided" });
//   }
//   const token = authHeader.split(" ")[1];
//   try {
//     req.user = jwt.verify(token, JWT_SECRET);
//     next();
//   } catch (err) {
//     return res.status(401).json({ error: "Invalid or expired token" });
//   }
// };

// const requireAdmin = async (req, res, next) => {
//   try {
//     const adminDoc = await db.collection("admins").doc(req.user.email).get();
//     if (!adminDoc.exists) {
//       return res.status(403).json({ error: "Admin access required" });
//     }
//     next();
//   } catch (err) {
//     console.error("Admin check failed:", err);
//     return res.status(500).json({ error: "Failed to verify admin" });
//   }
// };

// const toISO = (field) => {
//   if (!field) return new Date().toISOString();
//   if (field.toDate) return field.toDate().toISOString();
//   return new Date(field).toISOString();
// };

// // === TTS HELPER FUNCTIONS ===
// const MAX_CHARS_PER_CHUNK = 4000;
// const SENTENCE_ENDINGS = /[.!?]+/;

// const splitTextIntoChunks = (text) => {
//   if (!text) return [];
//   const chunks = [];
//   let currentChunk = "";
//   const sentences = text.split(SENTENCE_ENDINGS);

//   for (const sentence of sentences) {
//     const sentenceWithPunctuation =
//       sentence + (text[text.indexOf(sentence) + sentence.length] || ".");

//     if (
//       (currentChunk + sentenceWithPunctuation).length <= MAX_CHARS_PER_CHUNK
//     ) {
//       currentChunk += sentenceWithPunctuation;
//     } else {
//       if (currentChunk) chunks.push(currentChunk.trim());
//       currentChunk = sentenceWithPunctuation;
//     }
//   }

//   if (currentChunk.trim()) chunks.push(currentChunk.trim());
//   return chunks;
// };

// const generateTTSChunk = async (text, languageCode, voiceName) => {
//   const response = await fetch(
//     `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
//     {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         input: { text },
//         voice: { languageCode, name: voiceName },
//         audioConfig: {
//           audioEncoding: "MP3",
//           speakingRate: 1.0,
//           pitch: 0.0,
//           volumeGainDb: 0.0,
//         },
//       }),
//     }
//   );

//   if (!response.ok) {
//     const errorText = await response.text();
//     throw new Error(`TTS failed: ${response.status} - ${errorText}`);
//   }

//   const data = await response.json();
//   return data.audioContent;
// };

// const mergeAudioChunks = (base64Chunks) => {
//   // Simple concatenation for MP3 (works for most cases)
//   // For production, consider using ffmpeg for proper merging
//   const buffers = base64Chunks.map((chunk) => Buffer.from(chunk, "base64"));
//   return Buffer.concat(buffers);
// };

// // === AUTH ROUTES ===
// app.post("/register", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password)
//       return res.status(400).json({ error: "Email and password required" });

//     const userDoc = await db.collection("users").doc(email).get();
//     if (userDoc.exists)
//       return res.status(409).json({ error: "User already exists" });

//     const hashed = await bcrypt.hash(password, 10);
//     await db.collection("users").doc(email).set({
//       password: hashed,
//       createdAt: new Date(),
//     });

//     res.json({ message: "User registered successfully" });
//   } catch (err) {
//     console.error("Register error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password)
//       return res.status(400).json({ error: "Email and password required" });

//     const userDoc = await db.collection("users").doc(email).get();
//     if (!userDoc.exists)
//       return res.status(401).json({ error: "Invalid credentials" });

//     const userData = userDoc.data();
//     const valid = await bcrypt.compare(password, userData.password);
//     if (!valid) return res.status(401).json({ error: "Invalid credentials" });

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

//     if (category) query = query.where("category", "==", category);
//     if (limit) query = query.limit(parseInt(limit));

//     const snapshot = await query.get();
//     const docs = snapshot.docs.map((doc) => ({
//       id: doc.id,
//       ...doc.data(),
//       createdAt: toISO(doc.data().createdAt),
//     }));

//     res.json(docs);
//   } catch (err) {
//     console.error("GET collection error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get("/api/:collection/:id", authenticate, async (req, res) => {
//   try {
//     const { collection, id } = req.params;
//     const doc = await db.collection(collection).doc(id).get();
//     if (!doc.exists) return res.status(404).json({ error: "Not found" });

//     const data = doc.data();
//     res.json({ id: doc.id, ...data, createdAt: toISO(data.createdAt) });
//   } catch (err) {
//     console.error("GET item error:", err);
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
//         .json({ error: "Operation not allowed on this collection" });
//     }

//     const payload = {
//       ...req.body,
//       uploadedBy: req.user.email,
//       createdAt: new Date(),
//     };

//     const docRef = await db.collection(collection).add(payload);
//     res.json({ id: docRef.id, message: "Created successfully" });
//   } catch (err) {
//     console.error("POST error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // === UPDATE & DELETE ===
// app.put(
//   "/api/:collection/:id",
//   authenticate,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const { collection, id } = req.params;
//       if (!allowedCollections.includes(collection)) {
//         return res.status(403).json({ error: "Operation not allowed" });
//       }

//       await db
//         .collection(collection)
//         .doc(id)
//         .update({
//           ...req.body,
//           updatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         });

//       res.json({ message: "Updated successfully" });
//     } catch (err) {
//       console.error("PUT error:", err);
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

// app.delete(
//   "/api/:collection/:id",
//   authenticate,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const { collection, id } = req.params;
//       if (!allowedCollections.includes(collection)) {
//         return res.status(403).json({ error: "Operation not allowed" });
//       }

//       await db.collection(collection).doc(id).delete();

//       res.json({ message: "Deleted successfully" });
//     } catch (err) {
//       console.error("DELETE error:", err);
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

// // === FILE UPLOAD ===
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

//     if (!file || !destinationPath) {
//       return res
//         .status(400)
//         .json({ error: "File and destination path required" });
//     }

//     tempFilePath = file.path;
//     const folder = destinationPath.split("/")[0];
//     const maxSizeMB = folderSizeLimits[folder];

//     if (!maxSizeMB)
//       return res.status(400).json({ error: "Invalid upload folder" });
//     if (file.size > maxSizeMB * 1024 * 1024) {
//       return res
//         .status(400)
//         .json({ error: `File exceeds ${maxSizeMB}MB limit` });
//     }

//     if (
//       folder === "profiles" &&
//       !destinationPath.startsWith(`profiles/${req.user.email}`)
//     ) {
//       return res
//         .status(403)
//         .json({ error: "Cannot upload to another user's profile" });
//     }

//     const [uploadedFile] = await bucket.upload(file.path, {
//       destination: destinationPath,
//       metadata: { contentType: file.mimetype },
//       public: true,
//     });

//     await uploadedFile.makePublic();
//     const publicUrl = `https://storage.googleapis.com/${
//       bucket.name
//     }/${encodeURIComponent(destinationPath)}`;

//     res.json({
//       url: publicUrl,
//       path: destinationPath,
//       message: "Uploaded successfully",
//     });
//   } catch (err) {
//     console.error("Upload error:", err);
//     res.status(500).json({ error: err.message });
//   } finally {
//     if (tempFilePath) {
//       await fs.unlink(tempFilePath).catch(() => {});
//     }
//   }
// });

// // === TTS ROUTES ===

// // On-demand TTS (fallback for old sermons or immediate playback)
// app.post("/api/tts/synthesize", async (req, res) => {
//   const { text, languageCode, voiceName } = req.body;

//   if (!text || !languageCode || !voiceName) {
//     return res.status(400).json({
//       error: "Missing required fields: text, languageCode, voiceName",
//     });
//   }

//   try {
//     const audioContent = await generateTTSChunk(text, languageCode, voiceName);
//     res.json({ audioContent });
//   } catch (error) {
//     console.error("TTS Error:", error);
//     res.status(500).json({ error: "TTS generation failed: " + error.message });
//   }
// });

// // Pre-generate TTS for entire sermon (MAIN ENDPOINT)
// app.post(
//   "/api/sermons/:id/generate-audio",
//   authenticate,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { languageCode = "en-US", voiceName = "en-US-Neural2-F" } =
//         req.body;

//       console.log(`Starting TTS generation for sermon ${id}`);

//       // Get sermon
//       const sermonDoc = await db.collection("sermons").doc(id).get();
//       if (!sermonDoc.exists) {
//         return res.status(404).json({ error: "Sermon not found" });
//       }

//       const sermonData = sermonDoc.data();

//       // Check if already generated
//       if (sermonData.ttsAudioUrl) {
//         console.log(`Sermon ${id} already has TTS audio`);
//         return res.json({
//           url: sermonData.ttsAudioUrl,
//           cached: true,
//           message: "Audio already exists",
//         });
//       }

//       // Check if content exists
//       if (!sermonData.content) {
//         return res
//           .status(400)
//           .json({ error: "Sermon has no content to generate audio from" });
//       }

//       // Split into chunks
//       const chunks = splitTextIntoChunks(sermonData.content);
//       console.log(`Split sermon into ${chunks.length} chunks`);

//       // Generate TTS for each chunk
//       const audioChunks = [];
//       for (let i = 0; i < chunks.length; i++) {
//         console.log(`Generating chunk ${i + 1}/${chunks.length}`);
//         const audioContent = await generateTTSChunk(
//           chunks[i],
//           languageCode,
//           voiceName
//         );
//         audioChunks.push(audioContent);
//       }

//       // Merge audio chunks
//       console.log("Merging audio chunks...");
//       const mergedAudio = mergeAudioChunks(audioChunks);

//       // Upload to Firebase Storage
//       const audioPath = `sermons/tts/${id}_${languageCode}.mp3`;
//       const file = bucket.file(audioPath);

//       await file.save(mergedAudio, {
//         contentType: "audio/mpeg",
//         public: true,
//         metadata: {
//           contentType: "audio/mpeg",
//           metadata: {
//             generatedAt: new Date().toISOString(),
//             languageCode,
//             voiceName,
//             chunkCount: chunks.length,
//           },
//         },
//       });

//       await file.makePublic();
//       const publicUrl = `https://storage.googleapis.com/${
//         bucket.name
//       }/${encodeURIComponent(audioPath)}`;

//       // Update sermon document
//       await db.collection("sermons").doc(id).update({
//         ttsAudioUrl: publicUrl,
//         ttsGeneratedAt: new Date(),
//         ttsLanguageCode: languageCode,
//         ttsVoiceName: voiceName,
//       });

//       console.log(`TTS generation complete for sermon ${id}`);
//       res.json({
//         url: publicUrl,
//         cached: false,
//         chunks: chunks.length,
//         message: "Audio generated successfully",
//       });
//     } catch (error) {
//       console.error("TTS generation error:", error);
//       res
//         .status(500)
//         .json({ error: "Failed to generate audio: " + error.message });
//     }
//   }
// );

// // Check TTS generation status
// app.get("/api/sermons/:id/audio-status", authenticate, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const sermonDoc = await db.collection("sermons").doc(id).get();

//     if (!sermonDoc.exists) {
//       return res.status(404).json({ error: "Sermon not found" });
//     }

//     const data = sermonDoc.data();
//     res.json({
//       hasAudio: !!data.ttsAudioUrl,
//       url: data.ttsAudioUrl || null,
//       generatedAt: data.ttsGeneratedAt ? toISO(data.ttsGeneratedAt) : null,
//       languageCode: data.ttsLanguageCode || null,
//     });
//   } catch (error) {
//     console.error("Status check error:", error);
//     res.status(500).json({ error: error.message });
//   }
// });

// // === READ NOTICES TRACKING ===
// app.post("/api/users/:userId/readNotices", authenticate, async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const { noticeId } = req.body;

//     if (!noticeId)
//       return res.status(400).json({ error: "noticeId is required" });

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
//   res.json({ status: "ok", timestamp: new Date().toISOString() });
// });

// // Global error handler
// app.use((err, req, res, next) => {
//   console.error("Unhandled error:", err);
//   res.status(500).json({ error: "Internal server error" });
// });

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
//   console.log(`Health check: http://localhost:${PORT}/health`);
// });

// server.js (with Pagination Support)
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

// === TTS HELPER FUNCTIONS ===
const MAX_CHARS_PER_CHUNK = 4000;
const SENTENCE_ENDINGS = /[.!?]+/;

const splitTextIntoChunks = (text) => {
  if (!text) return [];
  const chunks = [];
  let currentChunk = "";
  const sentences = text.split(SENTENCE_ENDINGS);

  for (const sentence of sentences) {
    const sentenceWithPunctuation =
      sentence + (text[text.indexOf(sentence) + sentence.length] || ".");

    if (
      (currentChunk + sentenceWithPunctuation).length <= MAX_CHARS_PER_CHUNK
    ) {
      currentChunk += sentenceWithPunctuation;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentenceWithPunctuation;
    }
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
};

const generateTTSChunk = async (text, languageCode, voiceName) => {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 1.0,
          pitch: 0.0,
          volumeGainDb: 0.0,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TTS failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.audioContent;
};

const mergeAudioChunks = (base64Chunks) => {
  // Simple concatenation for MP3 (works for most cases)
  // For production, consider using ffmpeg for proper merging
  const buffers = base64Chunks.map((chunk) => Buffer.from(chunk, "base64"));
  return Buffer.concat(buffers);
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

// === READ ROUTES WITH PAGINATIONS ===
app.get("/api/:collection", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const {
      limit = 10,
      category,
      after, // Document ID to start after (cursor-based pagination)
      sort = "createdAt",
      order = "desc",
    } = req.query;

    console.log(
      `GET /${collection} - Category: ${category}, After: ${after}, Limit: ${limit}`
    );

    // Build the base query
    let query = db.collection(collection);

    // IMPORTANT FIX: Apply category filter BEFORE orderBy
    if (category) {
      console.log(`Applying category filter: ${category}`);
      query = query.where("category", "==", category);
    }

    // Apply ordering
    query = query.orderBy(sort, order);

    // Apply cursor pagination if 'after' is provided
    if (after) {
      try {
        const lastDoc = await db.collection(collection).doc(after).get();
        if (lastDoc.exists) {
          query = query.startAfter(lastDoc);
          console.log(`Starting after document: ${after}`);
        } else {
          console.warn(`Document ${after} not found, ignoring cursor`);
        }
      } catch (cursorError) {
        console.error(`Error fetching cursor document:`, cursorError);
        // Continue without cursor if there's an error
      }
    }

    // Apply limit
    query = query.limit(parseInt(limit));

    // Execute query
    const snapshot = await query.get();

    console.log(`Query returned ${snapshot.docs.length} documents`);

    const docs = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: toISO(data.createdAt),
      };
    });

    // Get the last document for next cursor
    const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;

    const response = {
      [collection]: docs,
      pagination: {
        hasMore: docs.length === parseInt(limit),
        nextCursor: lastDoc ? lastDoc.id : null,
        count: docs.length,
      },
    };

    console.log(
      `Response: ${docs.length} items, hasMore: ${response.pagination.hasMore}`
    );

    res.json(response);
  } catch (err) {
    console.error("GET collection error:", err);

    // Send detailed error in development
    res.status(500).json({
      error: err.message,
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// ALTERNATIVE: If Firestore composite index is missing, use this fallback
app.get("/api/:collection/no-index", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const {
      limit = 10,
      category,
      after,
      sort = "createdAt",
      order = "desc",
    } = req.query;

    console.log(`GET /${collection}/no-index - Category: ${category}`);

    // Fetch all documents (or a larger batch)
    let query = db.collection(collection);

    // Only apply orderBy, no category filter in query
    query = query.orderBy(sort, order).limit(parseInt(limit) * 10);

    const snapshot = await query.get();

    let docs = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: toISO(data.createdAt),
      };
    });

    // Filter by category in memory (client-side filtering on server)
    if (category) {
      docs = docs.filter((doc) => doc.category === category);
    }

    // Apply cursor pagination in memory
    if (after) {
      const afterIndex = docs.findIndex((doc) => doc.id === after);
      if (afterIndex !== -1) {
        docs = docs.slice(afterIndex + 1);
      }
    }

    // Apply limit
    docs = docs.slice(0, parseInt(limit));

    const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;

    res.json({
      [collection]: docs,
      pagination: {
        hasMore: docs.length === parseInt(limit),
        nextCursor: lastDoc ? lastDoc.id : null,
        count: docs.length,
      },
    });
  } catch (err) {
    console.error("GET collection (no-index) error:", err);
    res.status(500).json({
      error: err.message,
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// Alternative: Offset-based pagination (for simpler use cases)
app.get("/api/:collection/offset", authenticate, async (req, res) => {
  try {
    const { collection } = req.params;
    const {
      limit = 10,
      category,
      page = 1,
      sort = "createdAt",
      order = "desc",
    } = req.query;

    let query = db.collection(collection).orderBy(sort, order);

    if (category) query = query.where("category", "==", category);

    // Apply offset pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Get total count for pagination metadata
    let totalCount = 0;
    if (pageNum === 1) {
      const countQuery = category
        ? db.collection(collection).where("category", "==", category)
        : db.collection(collection);
      const countSnapshot = await countQuery.get();
      totalCount = countSnapshot.size;
    }

    // Apply pagination to query
    query = query.limit(limitNum).offset(offset);

    const snapshot = await query.get();
    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      createdAt: toISO(doc.data().createdAt),
    }));

    // Return paginated response
    res.json({
      [collection]: docs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        hasMore: docs.length === limitNum,
        totalPages: totalCount ? Math.ceil(totalCount / limitNum) : 0,
      },
    });
  } catch (err) {
    console.error("GET collection with offset error:", err);
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

// === TTS ROUTES ===

// On-demand TTS (fallback for old sermons or immediate playback)
app.post("/api/tts/synthesize", async (req, res) => {
  const { text, languageCode, voiceName } = req.body;

  if (!text || !languageCode || !voiceName) {
    return res.status(400).json({
      error: "Missing required fields: text, languageCode, voiceName",
    });
  }

  try {
    const audioContent = await generateTTSChunk(text, languageCode, voiceName);
    res.json({ audioContent });
  } catch (error) {
    console.error("TTS Error:", error);
    res.status(500).json({ error: "TTS generation failed: " + error.message });
  }
});

// Pre-generate TTS for entire sermon (MAIN ENDPOINT)
app.post(
  "/api/sermons/:id/generate-audio",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { languageCode = "en-US", voiceName = "en-US-Neural2-F" } =
        req.body;

      console.log(`Starting TTS generation for sermon ${id}`);

      // Get sermon
      const sermonDoc = await db.collection("sermons").doc(id).get();
      if (!sermonDoc.exists) {
        return res.status(404).json({ error: "Sermon not found" });
      }

      const sermonData = sermonDoc.data();

      // Check if already generated
      if (sermonData.ttsAudioUrl) {
        console.log(`Sermon ${id} already has TTS audio`);
        return res.json({
          url: sermonData.ttsAudioUrl,
          cached: true,
          message: "Audio already exists",
        });
      }

      // Check if content exists
      if (!sermonData.content) {
        return res
          .status(400)
          .json({ error: "Sermon has no content to generate audio from" });
      }

      // Split into chunks
      const chunks = splitTextIntoChunks(sermonData.content);
      console.log(`Split sermon into ${chunks.length} chunks`);

      // Generate TTS for each chunk
      const audioChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Generating chunk ${i + 1}/${chunks.length}`);
        const audioContent = await generateTTSChunk(
          chunks[i],
          languageCode,
          voiceName
        );
        audioChunks.push(audioContent);
      }

      // Merge audio chunks
      console.log("Merging audio chunks...");
      const mergedAudio = mergeAudioChunks(audioChunks);

      // Upload to Firebase Storage
      const audioPath = `sermons/tts/${id}_${languageCode}.mp3`;
      const file = bucket.file(audioPath);

      await file.save(mergedAudio, {
        contentType: "audio/mpeg",
        public: true,
        metadata: {
          contentType: "audio/mpeg",
          metadata: {
            generatedAt: new Date().toISOString(),
            languageCode,
            voiceName,
            chunkCount: chunks.length,
          },
        },
      });

      await file.makePublic();
      const publicUrl = `https://storage.googleapis.com/${
        bucket.name
      }/${encodeURIComponent(audioPath)}`;

      // Update sermon document
      await db.collection("sermons").doc(id).update({
        ttsAudioUrl: publicUrl,
        ttsGeneratedAt: new Date(),
        ttsLanguageCode: languageCode,
        ttsVoiceName: voiceName,
      });

      console.log(`TTS generation complete for sermon ${id}`);
      res.json({
        url: publicUrl,
        cached: false,
        chunks: chunks.length,
        message: "Audio generated successfully",
      });
    } catch (error) {
      console.error("TTS generation error:", error);
      res
        .status(500)
        .json({ error: "Failed to generate audio: " + error.message });
    }
  }
);

// Check TTS generation status
app.get("/api/sermons/:id/audio-status", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const sermonDoc = await db.collection("sermons").doc(id).get();

    if (!sermonDoc.exists) {
      return res.status(404).json({ error: "Sermon not found" });
    }

    const data = sermonDoc.data();
    res.json({
      hasAudio: !!data.ttsAudioUrl,
      url: data.ttsAudioUrl || null,
      generatedAt: data.ttsGeneratedAt ? toISO(data.ttsGeneratedAt) : null,
      languageCode: data.ttsLanguageCode || null,
    });
  } catch (error) {
    console.error("Status check error:", error);
    res.status(500).json({ error: error.message });
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
  console.log(`Pagination endpoints available:`);
  console.log(`- GET /api/:collection (cursor-based)`);
  console.log(`- GET /api/:collection/offset (offset-based)`);
});
