import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/postsdb";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const SENTIMENT_URL = process.env.SENTIMENT_URL || "http://localhost:8000/predict";

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

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body ?? {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const sentimentResponse = await fetch(SENTIMENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": crypto.randomUUID()
      },
      body: JSON.stringify({ text })
    });

    if (!sentimentResponse.ok) {
      const body = await sentimentResponse.text();
      return res.status(502).json({
        error: "sentiment service error",
        details: body
      });
    }

    const sentimentData = await sentimentResponse.json();
    const sentimentResult = sentimentData.result?.[0] ?? null;

    const post = {
      author: req.user.username,
      text,
      sentiment: sentimentResult,
      createdAt: new Date()
    };

    const insertResult = await postsCollection.insertOne(post);

    res.status(201).json({
      id: insertResult.insertedId,
      author: post.author,
      text: post.text,
      sentiment: post.sentiment,
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