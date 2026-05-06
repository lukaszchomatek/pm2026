import client from "prom-client";

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "posts_" });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["service", "method", "route", "status_code"],
  registers: [register]
});

export const httpErrorsTotal = new client.Counter({
  name: "http_errors_total",
  help: "HTTP error responses",
  labelNames: ["service", "method", "route", "status_code"],
  registers: [register]
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["service", "method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register]
});

export const postsCreatedTotal = new client.Counter({ name: "posts_created_total", help: "Created posts total", registers: [register] });
export const postsStatusTotal = new client.Counter({ name: "posts_status_total", help: "Posts final status total", labelNames: ["status"], registers: [register] });
export const classificationResultsTotal = new client.Counter({ name: "classification_results_total", help: "Classification results by classifier/status", labelNames: ["classifier", "status"], registers: [register] });
export const classificationDuration = new client.Histogram({ name: "classification_duration_seconds", help: "Classification end-to-end duration", labelNames: ["status"], buckets: [0.1, 0.5, 1, 2, 5, 10, 30], registers: [register] });
export const classificationFallbacksTotal = new client.Counter({ name: "classification_fallbacks_total", help: "Fallback/manual review decisions by classifier", labelNames: ["classifier"], registers: [register] });

export function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path || req.path || "unknown";
    const labels = { service: "posts", method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    if (res.statusCode >= 400) httpErrorsTotal.inc(labels);
    end(labels);
  });
  next();
}

export function metricsHandler(req, res) {
  res.set("Content-Type", register.contentType);
  register.metrics().then(metrics => res.send(metrics));
}
