import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId, MongoClient } from "mongodb";
import { bootstrapRabbitMQ } from "./messaging/bootstrapRabbitMQ.js";
import { QUEUES, ROUTING_KEYS } from "./messaging/classificationTopology.js";
import { consumeJson, publishJson } from "./messaging/rabbit.js";
import { logger, errorFields } from "./logger.js";
import { requestContextMiddleware } from "./requestContext.js";
import {
  classificationDuration,
  classificationFallbacksTotal,
  classificationResultsTotal,
  metricsHandler,
  metricsMiddleware,
  postsCreatedTotal,
  postsStatusTotal
} from "./metrics.js";

const app = express();
app.use(express.json());
app.use(requestContextMiddleware);
app.use(metricsMiddleware);

const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/postsdb";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const USERS_URL = process.env.USERS_URL || "http://localhost:3001";
const TOXICITY_REVIEW_THRESHOLD = Number(process.env.TOXICITY_REVIEW_THRESHOLD ?? 0.7);
const SPAM_REVIEW_THRESHOLD = Number(process.env.SPAM_REVIEW_THRESHOLD ?? 0.9);
const CONSUMER_PREFETCH = Number(process.env.POSTS_RESULTS_PREFETCH ?? 20);

const POST_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  PENDING_CLASSIFICATION: "PENDING_CLASSIFICATION",
  PUBLISHED: "PUBLISHED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  CLASSIFICATION_FAILED: "CLASSIFICATION_FAILED"
});

const REQUESTED_CLASSIFIERS = Object.freeze(["sentiment", "toxicity", "zeroshot"]);
const SUPPORTED_CLASSIFIERS = new Set(REQUESTED_CLASSIFIERS);

const mongoClient = new MongoClient(MONGO_URL);
await mongoClient.connect();

const db = mongoClient.db();
const postsCollection = db.collection("posts");

await postsCollection.createIndex({ author: 1, createdAt: -1 });
await postsCollection.createIndex({ status: 1, createdAt: -1 });
await postsCollection.createIndex({ classificationRunId: 1 });

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

function getSpamScore(zeroshotResult) {
  const labels = Array.isArray(zeroshotResult?.labels) ? zeroshotResult.labels : [];
  const scores = Array.isArray(zeroshotResult?.scores) ? zeroshotResult.scores : [];
  const spamIndex = labels.findIndex(label => String(label).toLowerCase() === "spam");
  if (spamIndex < 0) {
    return null;
  }

  return Number(scores[spamIndex] ?? 0);
}

function getClassificationFailures(post) {
  const failed = Array.isArray(post.failedClassifiers) ? post.failedClassifiers : [];
  return new Set(failed);
}

function getClassificationCompleted(post) {
  const completed = Array.isArray(post.completedClassifiers) ? post.completedClassifiers : [];
  return new Set(completed);
}

function allClassifiersSettled(post) {
  const requested = Array.isArray(post.requestedClassifiers) && post.requestedClassifiers.length
    ? post.requestedClassifiers
    : [...REQUESTED_CLASSIFIERS];

  const completed = getClassificationCompleted(post);
  const failed = getClassificationFailures(post);

  return requested.every(classifier => completed.has(classifier) || failed.has(classifier));
}

function resolveFinalDecision(post) {
  const failed = getClassificationFailures(post);
  const toxicityMeta = post.classificationMeta?.toxicity ?? null;
  const toxicityFailed = failed.has("toxicity") || toxicityMeta?.status === "failed";

  if (failed.size >= 2) {
    return {
      status: POST_STATUS.CLASSIFICATION_FAILED,
      statusReason: "Multiple classifiers failed; decision is technically unsafe."
    };
  }

  if (toxicityFailed) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: "Toxicity failed; manual review required."
    };
  }

  if (toxicityMeta?.status !== "ok") {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: "Toxicity has no reliable positive result."
    };
  }

  const highestToxicity = getHighestToxicityLabel(post.toxicity);
  if (!highestToxicity) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: "Missing toxicity score; manual review required."
    };
  }

  if (containsToxicLabel(highestToxicity.label) && highestToxicity.score >= TOXICITY_REVIEW_THRESHOLD) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: `Toxicity risk detected (${highestToxicity.label}: ${highestToxicity.score.toFixed(2)}).`
    };
  }

  const spamScore = getSpamScore(post.zeroshot);
  if (spamScore !== null && spamScore >= SPAM_REVIEW_THRESHOLD) {
    return {
      status: POST_STATUS.REVIEW_REQUIRED,
      statusReason: `High spam probability from zeroshot (${spamScore.toFixed(2)}).`
    };
  }

  return {
    status: POST_STATUS.PUBLISHED,
    statusReason: "Classification completed; post published."
  };
}

function classifierPendingMeta() {
  return {
    status: "pending",
    attempts: 0,
    errorType: null,
    errorMessage: null,
    source: "queue",
    messageId: null,
    eventType: null,
    modelVersion: null,
    classifiedAt: null,
    failedAt: null
  };
}

function resetClassificationFields(runId, now) {
  return {
    classificationRunId: runId,
    requestedClassifiers: [...REQUESTED_CLASSIFIERS],
    completedClassifiers: [],
    failedClassifiers: [],
    classificationStartedAt: now,
    classificationCompletedAt: null,
    sentiment: null,
    toxicity: null,
    zeroshot: null,
    status: POST_STATUS.PENDING_CLASSIFICATION,
    statusReason: "Post stored; classification request queued.",
    classificationMeta: {
      sentiment: classifierPendingMeta(),
      toxicity: classifierPendingMeta(),
      zeroshot: classifierPendingMeta()
    },
    updatedAt: now
  };
}

function isSameClassifierMessage(post, classifier, messageId) {
  if (!classifier || !messageId) {
    return false;
  }

  const existingMessageId = post?.classificationMeta?.[classifier]?.messageId;
  return existingMessageId === messageId;
}

async function fetchAuthorProfile(username) {
  const url = `${USERS_URL}/users/${encodeURIComponent(username)}/profile`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`users service profile fetch failed: ${response.status}`);
  }

  return await response.json();
}

async function publishClassificationRequested({ postId, authorId, text, classificationRunId, correlationId, causationId }) {
  if (!rabbit?.channel) {
    throw new Error("RabbitMQ channel unavailable");
  }

  const event = {
    messageId: crypto.randomUUID(),
    type: ROUTING_KEYS.REQUESTED,
    eventType: ROUTING_KEYS.REQUESTED,
    correlationId,
    causationId,
    classificationRunId,
    postId: postId.toString(),
    authorId,
    text,
    requestedClassifiers: [...REQUESTED_CLASSIFIERS],
    createdAt: new Date().toISOString()
  };

  const published = publishJson(
    rabbit.channel,
    rabbit.exchangeName,
    ROUTING_KEYS.REQUESTED,
    event,
    { messageId: event.messageId, correlationId }
  );

  if (!published) {
    throw new Error("RabbitMQ publish returned false");
  }

  logger.info({ event: "classification_requested_published", correlationId, postId: postId.toString(), messageId: event.messageId, causationId, status: POST_STATUS.PENDING_CLASSIFICATION });
}

function normalizeResultEvent(message, msg) {
  const routingKey = msg?.fields?.routingKey ?? "";
  const eventType = String(message?.eventType ?? routingKey ?? "");
  const classifierFromType = eventType.split(".").at(-1);
  const classifier = String(message?.classifier ?? classifierFromType ?? "").trim().toLowerCase();

  if (!SUPPORTED_CLASSIFIERS.has(classifier)) {
    throw new Error(`unsupported classifier '${classifier}'`);
  }

  const base = {
    postId: String(message?.postId ?? ""),
    classificationRunId: String(message?.classificationRunId ?? ""),
    classifier,
    messageId: String(message?.messageId ?? msg?.properties?.messageId ?? crypto.randomUUID()),
    eventType,
    routingKey,
    correlationId: String(message?.correlationId ?? msg?.properties?.correlationId ?? ""),
    causationId: String(message?.causationId ?? "")
  };

  if (!base.postId || !base.classificationRunId) {
    throw new Error("missing postId or classificationRunId");
  }

  return {
    ...base,
    isFailed: routingKey.startsWith("classification.failed."),
    payloadStatus: String(message?.status ?? "").toLowerCase(),
    result: message?.result,
    errorType: message?.errorType ?? null,
    errorMessage: message?.errorMessage ?? null,
    modelVersion: message?.modelVersion ?? null,
    classifiedAt: message?.classifiedAt ?? null,
    failedAt: message?.failedAt ?? null
  };
}

async function finalizeClassificationIfReady(postId, classificationRunId) {
  const post = await postsCollection.findOne({ _id: postId });

  if (!post) {
    return;
  }

  if (post.classificationRunId !== classificationRunId) {
    return;
  }

  if (!allClassifiersSettled(post)) {
    return;
  }

  if (post.classificationCompletedAt) {
    return;
  }

  const decision = resolveFinalDecision(post);
  const now = new Date();

  await postsCollection.updateOne(
    { _id: postId, classificationRunId, classificationCompletedAt: null },
    {
      $set: {
        classificationCompletedAt: now,
        status: decision.status,
        statusReason: decision.statusReason,
        updatedAt: now
      }
    }
  );

  postsStatusTotal.inc({ status: decision.status });
  if (post.classificationStartedAt) {
    const seconds = (now.getTime() - new Date(post.classificationStartedAt).getTime()) / 1000;
    if (seconds >= 0) classificationDuration.observe({ status: decision.status }, seconds);
  }

  if (decision.status === POST_STATUS.REVIEW_REQUIRED) {
    const failed = getClassificationFailures(post);
    failed.forEach(name => classificationFallbacksTotal.inc({ classifier: name }));
    if (failed.size === 0) classificationFallbacksTotal.inc({ classifier: "policy" });
  }
}


async function handleClassificationResult(message, msg, parseError) {
  if (parseError) {
    logger.error({ event: "message_processing_failed", queue: QUEUES.POSTS_RESULTS, ...errorFields(parseError) });
    msg && rabbit?.channel?.nack(msg, false, false);
    logger.info({ event: "message_nack", queue: QUEUES.POSTS_RESULTS });
    return;
  }

  const event = normalizeResultEvent(message, msg);
  logger.info({ event: "classification_result_consumed", correlationId: event.correlationId, postId: event.postId, classifierName: event.classifier, messageId: event.messageId, causationId: event.causationId });
  const postId = new ObjectId(event.postId);
  const now = new Date();
  const classifierPath = `classificationMeta.${event.classifier}`;

  const post = await postsCollection.findOne({ _id: postId });
  if (!post) {
    msg && rabbit?.channel?.ack(msg);
    logger.info({ event: "message_ack", postId: event.postId, messageId: event.messageId, correlationId: event.correlationId });
    return;
  }

  if (post.classificationRunId !== event.classificationRunId) {
    return;
  }

  if (isSameClassifierMessage(post, event.classifier, event.messageId)) {
    return;
  }

  const completedSet = getClassificationCompleted(post);
  const failedSet = getClassificationFailures(post);
  if (completedSet.has(event.classifier) || failedSet.has(event.classifier)) {
    return;
  }

  const isFailedEvent = event.isFailed || event.payloadStatus === "failed";
  classificationResultsTotal.inc({ classifier: event.classifier, status: isFailedEvent ? "failed" : "ok" });

  if (isFailedEvent) {
    await postsCollection.updateOne(
      { _id: postId, classificationRunId: event.classificationRunId },
      {
        $set: {
          [classifierPath]: {
            status: "failed",
            attempts: 1,
            errorType: event.errorType ?? "processing_error",
            errorMessage: event.errorMessage ?? "classifier failed",
            source: "queue",
            messageId: event.messageId,
            eventType: event.eventType,
            modelVersion: event.modelVersion,
            classifiedAt: event.classifiedAt,
            failedAt: event.failedAt ?? now.toISOString()
          },
          updatedAt: now
        },
        $addToSet: { failedClassifiers: event.classifier }
      }
    );
    logger.info({ event: "partial_classification_saved", correlationId: event.correlationId, postId: event.postId, classifierName: event.classifier, status: "failed", messageId: event.messageId });
  } else {
    await postsCollection.updateOne(
      { _id: postId, classificationRunId: event.classificationRunId },
      {
        $set: {
          [event.classifier]: event.result ?? null,
          [classifierPath]: {
            status: "ok",
            attempts: 1,
            errorType: null,
            errorMessage: null,
            source: "queue",
            messageId: event.messageId,
            eventType: event.eventType,
            modelVersion: event.modelVersion,
            classifiedAt: event.classifiedAt ?? now.toISOString(),
            failedAt: null
          },
          updatedAt: now
        },
        $addToSet: { completedClassifiers: event.classifier }
      }
    );
    logger.info({ event: "partial_classification_saved", correlationId: event.correlationId, postId: event.postId, classifierName: event.classifier, status: "ok", messageId: event.messageId });
  }

  await finalizeClassificationIfReady(postId, event.classificationRunId);
  logger.info({ event: "post_status_updated", correlationId: event.correlationId, postId: event.postId });
  msg && rabbit?.channel?.ack(msg);
  logger.info({ event: "message_ack", correlationId: event.correlationId, postId: event.postId, messageId: event.messageId });
}

async function startResultsConsumer() {
  if (!rabbit?.channel) {
    console.warn("[rabbit] posts result consumer disabled - channel unavailable");
    return;
  }

  await rabbit.channel.prefetch(CONSUMER_PREFETCH);
  await consumeJson(rabbit.channel, QUEUES.POSTS_RESULTS, handleClassificationResult);
  console.log(`[rabbit] consuming ${QUEUES.POSTS_RESULTS}`);
}

app.get("/metrics", metricsHandler);

app.get("/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  } catch {
    res.status(500).json({ status: "error" });
  }
});

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body ?? {};
    logger.info({ event: "post_create_requested", requestId: req.requestId, correlationId: req.correlationId });

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const normalizedText = text.trim();
    const classificationRunId = crypto.randomUUID();
    const authorProfile = await fetchAuthorProfile(req.user.username);
    logger.info({ event: "author_snapshot_loaded", requestId: req.requestId, correlationId: req.correlationId, authorId: req.user.username });
    const now = new Date();

    const pendingPost = {
      author: req.user.username,
      authorId: req.user.username,
      authorSnapshot: {
        username: authorProfile.username,
        displayName: authorProfile.displayName,
        role: authorProfile.role,
        group: authorProfile.group
      },
      text: normalizedText,
      createdAt: now,
      ...resetClassificationFields(classificationRunId, now)
    };

    const inserted = await postsCollection.insertOne(pendingPost);
    postsCreatedTotal.inc();
    logger.info({ event: "post_saved_pending", requestId: req.requestId, correlationId: req.correlationId, postId: inserted.insertedId.toString(), status: POST_STATUS.PENDING_CLASSIFICATION });

    try {
      await publishClassificationRequested({
        postId: inserted.insertedId,
        authorId: req.user.username,
        text: normalizedText,
        classificationRunId,
        correlationId: req.correlationId,
        causationId: req.requestId
      });

      const createdPost = await postsCollection.findOne({ _id: inserted.insertedId });
      return res.status(202).json({ id: inserted.insertedId, ...createdPost });
    } catch (publishError) {
      const failNow = new Date();
      await postsCollection.updateOne(
        { _id: inserted.insertedId },
        {
          $set: {
            status: POST_STATUS.CLASSIFICATION_FAILED,
            statusReason: `Failed to publish classification.requested: ${publishError?.message ?? "unknown error"}`,
            updatedAt: failNow,
            "classificationMeta.publication": {
              status: "failed",
              source: "rabbitmq",
              errorMessage: publishError?.message ?? "unknown error",
              at: failNow.toISOString()
            }
          }
        }
      );

      return res.status(503).json({
        error: "classification dispatch failed",
        details: publishError?.message ?? "unknown error",
        postId: inserted.insertedId
      });
    }
  } catch (err) {
    logger.error({ event: "post_create_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) });
    if (err?.message?.includes("users service profile fetch failed")) {
      return res.status(503).json({ error: "users service unavailable" });
    }

    return res.status(500).json({ error: "internal error" });
  }
});

app.post("/admin/classification/backfill", async (req, res) => {
  try {
    const filter = {
      $or: [
        { classificationRunId: { $exists: false } },
        { status: POST_STATUS.CLASSIFICATION_FAILED },
        {
          status: POST_STATUS.PENDING_CLASSIFICATION,
          $expr: {
            $lt: [
              { $add: [{ $size: { $ifNull: ["$completedClassifiers", []] } }, { $size: { $ifNull: ["$failedClassifiers", []] } }] },
              REQUESTED_CLASSIFIERS.length
            ]
          }
        }
      ]
    };

    const posts = await postsCollection.find(filter).limit(200).toArray();
    let published = 0;

    for (const post of posts) {
      const runId = crypto.randomUUID();
      const now = new Date();

      await postsCollection.updateOne(
        { _id: post._id },
        { $set: resetClassificationFields(runId, now) }
      );

      try {
        await publishClassificationRequested({
          postId: post._id,
          authorId: post.authorId ?? post.author,
          text: post.text,
          classificationRunId: runId
        });

        published += 1;
      } catch (error) {
        await postsCollection.updateOne(
          { _id: post._id },
          {
            $set: {
              status: POST_STATUS.CLASSIFICATION_FAILED,
              statusReason: `Backfill publish failed: ${error?.message ?? "unknown error"}`,
              updatedAt: new Date(),
              "classificationMeta.publication": {
                status: "failed",
                source: "rabbitmq",
                errorMessage: error?.message ?? "unknown error",
                at: new Date().toISOString()
              }
            }
          }
        );
      }
    }

    return res.json({ matched: posts.length, published });
  } catch (error) {
    logger.error({ event: "backfill_failed", ...errorFields(error) });
    return res.status(500).json({ error: "internal error" });
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
      .limit(5)
      .toArray();

    return res.json(posts);
  } catch (err) {
    logger.error({ event: "post_create_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) });
    return res.status(500).json({ error: "internal error" });
  }
});

app.get("/allposts", async (req, res) => {
  try {
    const posts = await postsCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json(posts);
  } catch (err) {
    logger.error({ event: "post_create_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) });
    return res.status(500).json({ error: "internal error" });
  }
});

app.get("/posts/me", authMiddleware, async (req, res) => {
  try {
    const posts = await postsCollection
      .find({ author: req.user.username })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json(posts);
  } catch (err) {
    logger.error({ event: "post_create_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) });
    return res.status(500).json({ error: "internal error" });
  }
});

const rabbit = await bootstrapRabbitMQ();
await startResultsConsumer();

app.listen(PORT, () => {
  console.log(`posts service listening on port ${PORT}`);
});
