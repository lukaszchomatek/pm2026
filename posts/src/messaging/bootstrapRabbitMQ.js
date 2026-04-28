import { connectRabbitMQ } from "./rabbit.js";
import { setupClassificationTopology } from "./classificationTopology.js";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const CLASSIFICATION_EXCHANGE = process.env.CLASSIFICATION_EXCHANGE || "classification";
const RABBIT_BOOTSTRAP_RETRIES = Number(process.env.RABBIT_BOOTSTRAP_RETRIES ?? 20);
const RABBIT_BOOTSTRAP_DELAY_MS = Number(process.env.RABBIT_BOOTSTRAP_DELAY_MS ?? 2000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function bootstrapRabbitMQ() {
  for (let attempt = 1; attempt <= RABBIT_BOOTSTRAP_RETRIES; attempt += 1) {
    try {
      const { connection, channel } = await connectRabbitMQ(RABBITMQ_URL);
      await setupClassificationTopology(channel, CLASSIFICATION_EXCHANGE);

      connection.on("error", error => {
        console.error("[rabbit] connection error", error);
      });

      connection.on("close", () => {
        console.warn("[rabbit] connection closed");
      });

      console.log(`[rabbit] topology ready on exchange '${CLASSIFICATION_EXCHANGE}'`);

      return { connection, channel, exchangeName: CLASSIFICATION_EXCHANGE };
    } catch (error) {
      const isLastAttempt = attempt === RABBIT_BOOTSTRAP_RETRIES;
      const waitMs = Math.min(RABBIT_BOOTSTRAP_DELAY_MS * attempt, 10000);

      console.error(
        `[rabbit] bootstrap failed (attempt ${attempt}/${RABBIT_BOOTSTRAP_RETRIES})`,
        error
      );

      if (isLastAttempt) {
        return null;
      }

      await sleep(waitMs);
    }
  }

  return null;
}
