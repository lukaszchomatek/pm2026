import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { logger, errorFields } from "./logger.js";
import { requestContextMiddleware } from "./requestContext.js";
import { metricsHandler, metricsMiddleware } from "./metrics.js";

const app = express();
app.use(express.json());
app.use(requestContextMiddleware);
app.use(metricsMiddleware);

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  logger.error({ event: "redis_error", ...errorFields(err) }, "Redis error")
});

await redis.connect();

app.get("/metrics", metricsHandler);

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
    const {
      username,
      password,
      displayName: rawDisplayName,
      role: rawRole,
      group: rawGroup
    } = req.body ?? {};

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const displayName = rawDisplayName?.trim() || username;
    const role = rawRole?.trim() || "student";
    const group = rawGroup?.trim() || "default";

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
        passwordHash,
        displayName,
        role,
        group
      })
    );

    res.status(201).json({ message: "user registered" });
  } catch (err) {
    logger.error({ event: "profile_fetch_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) }, "profile fetch failed");
    res.status(500).json({ error: "internal error" });
  }
});

app.get("/users/:username/profile", async (req, res) => {
  try {
    const { username } = req.params;
    const key = `user:${username}`;
    const raw = await redis.get(key);

    if (!raw) {
      return res.status(404).json({ error: "user not found" });
    }

    const user = JSON.parse(raw);

    res.json({
      username: user.username,
      displayName: user.displayName ?? user.username,
      role: user.role ?? "student",
      group: user.group ?? "default"
    });
  } catch (err) {
    logger.error({ event: "login_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) }, "login failed");
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
    logger.error({ event: "register_failed", requestId: req.requestId, correlationId: req.correlationId, ...errorFields(err) }, "register failed");
    res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => {
  logger.info({ event: "service_started", port: PORT }, "users service listening");
});
