import { assertQueue, assertTopicExchange, bindQueue } from "./rabbit.js";

export const ROUTING_KEYS = Object.freeze({
  REQUESTED: "classification.requested",
  RESULT_SENTIMENT: "classification.result.sentiment",
  RESULT_TOXICITY: "classification.result.toxicity",
  RESULT_ZEROSHOT: "classification.result.zeroshot",
  FAILED_SENTIMENT: "classification.failed.sentiment",
  FAILED_TOXICITY: "classification.failed.toxicity",
  FAILED_ZEROSHOT: "classification.failed.zeroshot"
});

export const QUEUES = Object.freeze({
  SENTIMENT_REQUESTS: "sentiment.classification.requests",
  TOXICITY_REQUESTS: "toxicity.classification.requests",
  ZEROSHOT_REQUESTS: "zeroshot.classification.requests",
  POSTS_RESULTS: "posts.classification.results"
});

export function dlqName(queueName) {
  return `${queueName}.dlq`;
}

export async function setupClassificationTopology(channel, exchangeName) {
  await assertTopicExchange(channel, exchangeName, { durable: true });

  await setupClassifierQueue(channel, exchangeName, QUEUES.SENTIMENT_REQUESTS);
  await setupClassifierQueue(channel, exchangeName, QUEUES.TOXICITY_REQUESTS);
  await setupClassifierQueue(channel, exchangeName, QUEUES.ZEROSHOT_REQUESTS);

  await assertQueue(channel, QUEUES.POSTS_RESULTS, { durable: true });
  await bindQueue(channel, QUEUES.POSTS_RESULTS, exchangeName, "classification.result.*");
  await bindQueue(channel, QUEUES.POSTS_RESULTS, exchangeName, "classification.failed.*");
}

async function setupClassifierQueue(channel, exchangeName, queueName) {
  await assertQueue(channel, dlqName(queueName), { durable: true });

  await assertQueue(channel, queueName, {
    durable: true,
    deadLetterExchange: exchangeName,
    deadLetterRoutingKey: `classification.failed.${extractClassifierName(queueName)}`
  });

  await bindQueue(channel, queueName, exchangeName, ROUTING_KEYS.REQUESTED);
}

function extractClassifierName(queueName) {
  return queueName.split(".")[0];
}
