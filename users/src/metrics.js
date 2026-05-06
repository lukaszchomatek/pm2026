import client from "prom-client";

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "users_" });

const httpRequestsTotal = new client.Counter({ name: "http_requests_total", help: "Total HTTP requests", labelNames: ["service", "method", "route", "status_code"], registers: [register] });
const httpErrorsTotal = new client.Counter({ name: "http_errors_total", help: "HTTP error responses", labelNames: ["service", "method", "route", "status_code"], registers: [register] });
const httpRequestDuration = new client.Histogram({ name: "http_request_duration_seconds", help: "HTTP request duration in seconds", labelNames: ["service", "method", "route", "status_code"], buckets: [0.01,0.05,0.1,0.3,0.5,1,2,5], registers: [register] });

export function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path || req.path || "unknown";
    const labels = { service: "users", method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    if (res.statusCode >= 400) httpErrorsTotal.inc(labels);
    end(labels);
  });
  next();
}

export async function metricsHandler(req, res) {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
}
