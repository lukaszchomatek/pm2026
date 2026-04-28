import { connectRabbitMQ } from "./rabbit.js";
import { setupClassificationTopology } from "./classificationTopology.js";

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const CLASSIFICATION_EXCHANGE = process.env.CLASSIFICATION_EXCHANGE || "classification";

export async function bootstrapRabbitMQ() {
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
    console.error("[rabbit] bootstrap failed", error);
    return null;
  }
}
