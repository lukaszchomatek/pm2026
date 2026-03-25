import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from "redis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  console.error("Redis error:", err);
});

await redis.connect();

app.get("/health", async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: "ok" });
  } catch {
    res.status(500).json({ status: "error" });
  }
});

app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const key = `user:${username}`;
    const existing = await redis.get(key);

    if (existing) {
      return res.status(409).json({ error: "user already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await redis.set(
      key,
      JSON.stringify({
        username,
        passwordHash
      })
    );

    res.status(201).json({ message: "user registered" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const key = `user:${username}`;
    const raw = await redis.get(key);

    if (!raw) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const user = JSON.parse(raw);
    const ok = await bcrypt.compare(password, user.passwordHash);

    if (!ok) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const token = jwt.sign(
      { sub: username, username },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`users service listening on port ${PORT}`);
});