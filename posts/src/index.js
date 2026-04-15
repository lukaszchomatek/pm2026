import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";
import pRetry, { AbortError as PRetryAbortError } from "p-retry";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/postsdb";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const USERS_URL = process.env.USERS_URL || "http://localhost:3001";
const SENTIMENT_URL = process.env.SENTIMENT_URL;
const TOXICITY_URL = process.env.TOXICITY_URL;
const ZEROSHOT_URL = process.env.ZEROSHOT_URL;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 10000);
const MODEL_RETRIES = Number(process.env.MODEL_RETRIES ?? 2);
const MODEL_RETRY_MIN_TIMEOUT_MS = Number(process.env.MODEL_RETRY_MIN_TIMEOUT_MS ?? 250);
const MODEL_RETRY_FACTOR = Number(process.env.MODEL_RETRY_FACTOR ?? 2);
const ZERO_SHOT_MULTI_LABEL = process.env.ZERO_SHOT_MULTI_LABEL === "1";
const TOXICITY_REVIEW_THRESHOLD = Number(process.env.TOXICITY_REVIEW_THRESHOLD ?? 0.7);

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
      const error = new Error(`${url} -> ${response.status} ${responseBody}`);
      error.name = "HttpError";
      error.httpStatus = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function classifyError(error) {
  const rootError = error?.originalError ?? error;

  if (rootError?.name === "AbortError") {
    return "timeout";
  }

  if (typeof rootError?.httpStatus === "number") {
    if (rootError.httpStatus >= 500) {
      return "http_5xx";
    }

    if (rootError.httpStatus >= 400) {
      return "http_4xx";
    }
  }

  if (rootError?.name === "TypeError") {
    return "network_error";
  }

  return "unknown_error";
}

function shouldRetryError(errorType) {
  return errorType === "timeout" || errorType === "network_error" || errorType === "http_5xx";
}

async function callModelWithRetry(url, body, requestId) {
  let attempts = 0;

  try {
    const result = await pRetry(
      async () => {
        attempts += 1;

        try {
          return await callModel(url, body, requestId);
        } catch (error) {
          const errorType = classifyError(error);

          if (!shouldRetryError(errorType)) {
            throw new PRetryAbortError(error);
          }

          throw error;
        }
      },
      {
        retries: MODEL_RETRIES,
        minTimeout: MODEL_RETRY_MIN_TIMEOUT_MS,
        factor: MODEL_RETRY_FACTOR
      }
    );

    return { result, attempts };
  } catch (error) {
    error.attempts = attempts;
    throw error;
  }
}

async function classifyWithFallback({ name, url, body, requestId, fallbackFactory, normalizer }) {
  try {
    const { result, attempts } = await callModelWithRetry(url, body, requestId);

    return {
      data: normalizer(result),
      meta: {
        status: "ok",
        attempts,
        errorType: null,
        errorMessage: null,
        source: "remote"
      }
    };
  } catch (error) {
    const errorType = classifyError(error);
    const baseMeta = {
      attempts: Number(error?.attempts ?? error?.attemptNumber ?? MODEL_RETRIES + 1),
      errorType,
      errorMessage: (error?.originalError?.message ?? error?.message) || `${name} classification failed`
    };

    try {
      const fallback = fallbackFactory();

      return {
        data: fallback,
        meta: {
          status: "fallback_used",
          ...baseMeta,
          source: "fallback"
        }
      };
    } catch {
      return {
        data: null,
        meta: {
          status: "failed",
          ...baseMeta,
          source: "fallback"
        }
      };
    }
  }
}

function containsToxicLabel(label) {
  const normalized = String(label ?? "").toLowerCase();
  return (
    normalized.includes("toxic") ||
    normalized.includes("hate") ||
    normalized.includes("insult") ||
    normalized.includes("threat") ||
    normalized.includes("obscene")
  );
}

function shouldReviewFromToxicity(toxicityResult, toxicityMeta) {
  if (toxicityMeta.source !== "remote" || toxicityMeta.status !== "ok") {
    return true;
  }

  if (!Array.isArray(toxicityResult)) {
    return true;
  }

  return toxicityResult.some(item => {
    const score = Number(item?.score ?? 0);
    return score >= TOXICITY_REVIEW_THRESHOLD && containsToxicLabel(item?.label);
  });
}

function resolvePostStatus(toxicityResult, toxicityMeta) {
  if (toxicityMeta.status === "failed") {
    return "CLASSIFICATION_FAILED";
  }

  if (shouldReviewFromToxicity(toxicityResult, toxicityMeta)) {
    return "REVIEW_REQUIRED";
  }

  return "PUBLISHED";
}

async function enrichText(text, requestId) {
  const [sentiment, toxicity, zeroshot] = await Promise.all([
    classifyWithFallback({
      name: "sentiment",
      url: SENTIMENT_URL,
      body: { text },
      requestId,
      fallbackFactory: () => ({ label: "unknown", score: 0 }),
      normalizer: response => response.result?.[0] ?? null
    }),
    classifyWithFallback({
      name: "toxicity",
      url: TOXICITY_URL,
      body: { text },
      requestId,
      fallbackFactory: () => [],
      normalizer: response => response.result ?? []
    }),
    classifyWithFallback({
      name: "zeroshot",
      url: ZEROSHOT_URL,
      body: {
        text,
        candidate_labels: ZERO_SHOT_LABELS,
        multi_label: ZERO_SHOT_MULTI_LABEL
      },
      requestId,
      fallbackFactory: () => null,
      normalizer: response => ({
        sequence: response.sequence,
        labels: response.labels ?? [],
        scores: response.scores ?? []
      })
    })
  ]);

  const postStatus = resolvePostStatus(toxicity.data, toxicity.meta);

  return {
    sentiment: sentiment.data,
    toxicity: toxicity.data,
    zeroshot: zeroshot.data,
    status: postStatus,
    classificationMeta: {
      sentiment: sentiment.meta,
      toxicity: toxicity.meta,
      zeroshot: zeroshot.meta
    }
  };
}

async function fetchAuthorProfile(username) {
  const url = `${USERS_URL}/users/${encodeURIComponent(username)}/profile`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`users service profile fetch failed: ${response.status}`);
  }

  return await response.json();
}

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body ?? {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const normalizedText = text.trim();
    const requestId = crypto.randomUUID();
    const authorProfile = await fetchAuthorProfile(req.user.username);

    const enrichment = await enrichText(normalizedText, requestId);

    const post = {
      author: req.user.username,
      authorId: req.user.username,
      authorSnapshot: {
        username: authorProfile.username,
        displayName: authorProfile.displayName,
        role: authorProfile.role,
        group: authorProfile.group
      },
      text: normalizedText,
      sentiment: enrichment.sentiment,
      toxicity: enrichment.toxicity,
      zeroshot: enrichment.zeroshot,
      status: enrichment.status,
      classificationMeta: enrichment.classificationMeta,
      createdAt: new Date()
    };

    const insertResult = await postsCollection.insertOne(post);

    res.status(201).json({
      id: insertResult.insertedId,
      author: post.author,
      authorId: post.authorId,
      authorSnapshot: post.authorSnapshot,
      text: post.text,
      sentiment: post.sentiment,
      toxicity: post.toxicity,
      zeroshot: post.zeroshot,
      status: post.status,
      classificationMeta: post.classificationMeta,
      createdAt: post.createdAt
    });
  } catch (err) {
    console.error(err);
    if (err?.message?.includes("users service profile fetch failed")) {
      return res.status(503).json({ error: "users service unavailable" });
    }

    res.status(500).json({ error: "internal error" });
  }
});
app.get("/posts", async (req, res) => {
  try {
    const posts = await postsCollection
      .find({ status: "PUBLISHED" })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// a method displays all posts, independently on the status
app.get("/allposts", async (req, res) => {
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
