import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/postsdb";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const SENTIMENT_URL = process.env.SENTIMENT_URL;
const TOXICITY_URL = process.env.TOXICITY_URL;
const ZEROSHOT_URL = process.env.ZEROSHOT_URL;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 10000);
const ZERO_SHOT_MULTI_LABEL = process.env.ZERO_SHOT_MULTI_LABEL === "1";

function parseZeroShotLabels() {
  try {
    const parsed = JSON.parse(
      process.env.ZERO_SHOT_LABELS ?? '["question","complaint","opinion","announcement","spam"]'
    );

    if (!Array.isArray(parsed) || parsed.length < 2) {
      throw new Error("ZERO_SHOT_LABELS must be an array with at least 2 items");
    }

    return parsed.map(x => String(x).trim()).filter(Boolean);
  } catch (err) {
    throw new Error(`Invalid ZERO_SHOT_LABELS: ${err.message}`);
  }
}

const ZERO_SHOT_LABELS = parseZeroShotLabels();

const mongoClient = new MongoClient(MONGO_URL);
await mongoClient.connect();

const db = mongoClient.db();
const postsCollection = db.collection("posts");

await postsCollection.createIndex({ author: 1, createdAt: -1 });

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "missing or invalid bearer token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

app.get("/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  } catch {
    res.status(500).json({ status: "error" });
  }
});

async function callModel(url, body, requestId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`${url} -> ${response.status} ${responseBody}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichText(text, requestId) {
  const results = await Promise.allSettled([
    callModel(SENTIMENT_URL, { text }, requestId),
    callModel(TOXICITY_URL, { text }, requestId),
    callModel(
      ZEROSHOT_URL,
      {
        text,
        candidate_labels: ZERO_SHOT_LABELS,
        multi_label: ZERO_SHOT_MULTI_LABEL
      },
      requestId
    )
  ]);

  const [sentimentResult, toxicityResult, zeroshotResult] = results;

  return {
    sentiment:
      sentimentResult.status === "fulfilled"
        ? (sentimentResult.value.result?.[0] ?? null)
        : null,

    toxicity:
      toxicityResult.status === "fulfilled"
        ? (toxicityResult.value.result ?? [])
        : [],

    zeroshot:
      zeroshotResult.status === "fulfilled"
        ? {
            sequence: zeroshotResult.value.sequence,
            labels: zeroshotResult.value.labels ?? [],
            scores: zeroshotResult.value.scores ?? []
          }
        : null,

    enrichmentErrors: {
      sentiment:
        sentimentResult.status === "rejected" ? sentimentResult.reason.message : null,
      toxicity:
        toxicityResult.status === "rejected" ? toxicityResult.reason.message : null,
      zeroshot:
        zeroshotResult.status === "rejected" ? zeroshotResult.reason.message : null
    }
  };
}

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body ?? {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const normalizedText = text.trim();
    const requestId = crypto.randomUUID();

    const enrichment = await enrichText(normalizedText, requestId);

    const post = {
      author: req.user.username,
      text: normalizedText,
      sentiment: enrichment.sentiment,
      toxicity: enrichment.toxicity,
      zeroshot: enrichment.zeroshot,
      enrichmentErrors: enrichment.enrichmentErrors,
      createdAt: new Date()
    };

    const insertResult = await postsCollection.insertOne(post);

    res.status(201).json({
      id: insertResult.insertedId,
      author: post.author,
      text: post.text,
      sentiment: post.sentiment,
      toxicity: post.toxicity,
      zeroshot: post.zeroshot,
      enrichmentErrors: post.enrichmentErrors,
      createdAt: post.createdAt
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});
app.get("/posts", async (req, res) => {
  try {
    const posts = await postsCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

app.get("/posts/me", authMiddleware, async (req, res) => {
  try {
    const posts = await postsCollection
      .find({ author: req.user.username })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`posts service listening on port ${PORT}`);
});