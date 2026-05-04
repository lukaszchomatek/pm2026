import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "posts" },
  timestamp: pino.stdTimeFunctions.isoTime
});

export function errorFields(error) {
  return {
    errorType: error?.name || "Error",
    errorMessage: error?.message || "unknown error",
    stack: error?.stack
  };
}
