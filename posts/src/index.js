import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";
import pRetry, { AbortError as PRetryAbortError } from "p-retry";
import { bootstrapRabbitMQ } from "./messaging/bootstrapRabbitMQ.js";
import { ROUTING_KEYS } from "./messaging/classificationTopology.js";
import { publishJson } from "./messaging/rabbit.js";

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
const SPAM_REVIEW_THRESHOLD = Number(process.env.SPAM_REVIEW_THRESHOLD ?? 0.9);

const POST_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  PENDING_CLASSIFICATION: "PENDING_CLASSIFICATION",
  PUBLISHED: "PUBLISHED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  CLASSIFICATION_FAILED: "CLASSIFICATION_FAILED"
});
const REQUESTED_CLASSIFIERS = Object.freeze(["sentiment", "toxicity", "zeroshot"]);

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
await postsCollection.createIndex({ status: 1, createdAt: -1 });

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
    return POST_STATUS.CLASSIFICATION_FAILED;
  }

  if (shouldReviewFromToxicity(toxicityResult, toxicityMeta)) {
    return POST_STATUS.REVIEW_REQUIRED;
  }

  return POST_STATUS.PUBLISHED;
}

function hasManyClassificationFailures(meta) {
  const failedCount = Object.values(meta).filter(item => item?.status === "failed").length;
  return failedCount >= 2;
}

function getHighestToxicityLabel(toxicityResult) {
  if (!Array.isArray(toxicityResult) || toxicityResult.length === 0) {
    return null;
  }

  return toxicityResult.reduce((highest, item) => {
    const score = Number(item?.score ?? 0);

    if (!highest || score > highest.score) {
      return { label: String(item?.label ?? "unknown"), score };
    }

    return highest;
  }, null);
}

function getStatusDecision({ sentiment, toxicity, zeroshot }) {
  if (hasManyClassificationFailures({ sentiment: sentiment.meta, toxicity: toxicity.meta, zeroshot: zeroshot.meta })) {
    return {
      status: POST_STATUS.CLASSIFICATION_FAILED,
      statusReason: "Multiple classifiers failed; moderation decision is technically unsafe."
    };
  }

  if (toxicity.meta.status === "failed") {
    return {
      status: POST_STATUS.CLASSIFICATION_FAILED,
      statusReason: "Toxicity classifier failed without a reliable decision fallback."
    };
  }

  if (toxicity.meta.source !== "remote" || toxicity.meta.status !== "ok") {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: "Toxicity used fallback data; manual review required."
    };
  }

  const highestToxicity = getHighestToxicityLabel(toxicity.data);
  if (highestToxicity && containsToxicLabel(highestToxicity.label) && highestToxicity.score >= TOXICITY_REVIEW_THRESHOLD) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: `Toxicity risk detected (${highestToxicity.label}: ${highestToxicity.score.toFixed(2)}).`
    };
  }

  const spamLabelIndex = Array.isArray(zeroshot.data?.labels)
    ? zeroshot.data.labels.findIndex(label => String(label).toLowerCase() === "spam")
    : -1;
  const spamScore = spamLabelIndex >= 0 ? Number(zeroshot.data?.scores?.[spamLabelIndex] ?? 0) : 0;
  if (spamScore >= SPAM_REVIEW_THRESHOLD) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: `High spam probability from zeroshot (${spamScore.toFixed(2)}).`
    };
  }

  return {
    status: resolvePostStatus(toxicity.data, toxicity.meta),
    statusReason: "Classification completed; post published."
  };
}

async function createPendingPost({ authorUsername, authorProfile, text, classificationRunId }) {
  const now = new Date();
  const classifierMetaPending = {
    status: "pending",
    attempts: 0,
    errorType: null,
    errorMessage: null,
    source: "queue"
  };
  const pendingPost = {
    author: authorUsername,
    authorId: authorUsername,
    authorSnapshot: {
      username: authorProfile.username,
      displayName: authorProfile.displayName,
      role: authorProfile.role,
      group: authorProfile.group
    },
    text,
    status: POST_STATUS.PENDING_CLASSIFICATION,
    statusReason: "Post stored; classification request queued.",
    classificationRunId,
    requestedClassifiers: [...REQUESTED_CLASSIFIERS],
    completedClassifiers: [],
    failedClassifiers: [],
    classificationStartedAt: now,
    classificationCompletedAt: null,
    sentiment: null,
    toxicity: null,
    zeroshot: null,
    classificationMeta: {
      sentiment: { ...classifierMetaPending },
      toxicity: { ...classifierMetaPending },
      zeroshot: { ...classifierMetaPending }
    },
    createdAt: now,
    updatedAt: now
  };

  const result = await postsCollection.insertOne(pendingPost);
  return { insertedId: result.insertedId };
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

  const decision = getStatusDecision({ sentiment, toxicity, zeroshot });

  return {
    sentiment: sentiment.data,
    toxicity: toxicity.data,
    zeroshot: zeroshot.data,
    status: decision.status,
    statusReason: decision.statusReason,
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
    const classificationRunId = crypto.randomUUID();
    const authorProfile = await fetchAuthorProfile(req.user.username);
    const { insertedId } = await createPendingPost({
      authorUsername: req.user.username,
      authorProfile,
      text: normalizedText,
      classificationRunId
    });

    try {
      const event = {
        messageId: crypto.randomUUID(),
        eventType: ROUTING_KEYS.REQUESTED,
        classificationRunId,
        postId: insertedId.toString(),
        authorId: req.user.username,
        text: normalizedText,
        requestedClassifiers: [...REQUESTED_CLASSIFIERS],
        createdAt: new Date().toISOString()
      };

      if (!rabbit?.channel) {
        throw new Error("RabbitMQ channel unavailable");
      }

      const published = publishJson(
        rabbit.channel,
        rabbit.exchangeName,
        ROUTING_KEYS.REQUESTED,
        event,
        { messageId: event.messageId }
      );

      if (!published) {
        throw new Error("RabbitMQ publish returned false");
      }

      const createdPost = await postsCollection.findOne({ _id: insertedId });
      return res.status(202).json({ id: insertedId, ...createdPost });
    } catch (publishError) {
      const now = new Date();
      await postsCollection.updateOne(
        { _id: insertedId },
        {
          $set: {
            status: POST_STATUS.CLASSIFICATION_FAILED,
            statusReason: `Failed to publish classification.requested: ${publishError?.message ?? "unknown error"}`,
            classificationMeta: {
              sentiment: { status: "pending", source: "queue", errorMessage: null },
              toxicity: { status: "pending", source: "queue", errorMessage: null },
              zeroshot: { status: "pending", source: "queue", errorMessage: null },
              publication: {
                status: "failed",
                source: "rabbitmq",
                errorMessage: publishError?.message ?? "unknown error"
              }
            },
            updatedAt: now
          }
        }
      );

      return res.status(503).json({
        error: "classification dispatch failed",
        details: publishError?.message ?? "unknown error",
        postId: insertedId
      });
    }
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
    const statusQuery = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const statuses = statusQuery
      ? statusQuery.split(",").map(item => item.trim()).filter(Boolean)
      : [POST_STATUS.PUBLISHED];
    const allowedStatuses = new Set(Object.values(POST_STATUS));
    const invalidStatus = statuses.some(status => !allowedStatuses.has(status));

    if (invalidStatus) {
      return res.status(400).json({ error: "invalid status filter" });
    }

    const statusFilter = statuses.length === 1 ? statuses[0] : { $in: statuses };
    const posts = await postsCollection
      .find({ status: statusFilter })
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

const rabbit = await bootstrapRabbitMQ();

app.listen(PORT, () => {
  console.log(`posts service listening on port ${PORT}`);
});
