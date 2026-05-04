import crypto from "crypto";
import { logger, errorFields } from "./logger.js";

export function requestContextMiddleware(req, res, next) {
  const requestId = String(req.headers["x-request-id"] || crypto.randomUUID());
  const correlationId = String(req.headers["x-correlation-id"] || requestId);
  const startedAt = Date.now();

  req.requestId = requestId;
  req.correlationId = correlationId;
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-correlation-id", correlationId);

  logger.info({ event: "http_request_started", requestId, correlationId, method: req.method, path: req.path });
  res.on("finish", () => {
    const payload = {
      event: res.statusCode >= 500 ? "http_request_failed" : "http_request_completed",
      requestId,
      correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    };
    (res.statusCode >= 500 ? logger.error : logger.info)(payload);
  });
  res.on("error", err => logger.error({ event: "http_request_failed", requestId, correlationId, ...errorFields(err) }));
  next();
}
