import { assertQueue, assertTopicExchange, bindQueue } from "./rabbit.js";

export const CLASSIFIERS = Object.freeze(["sentiment", "toxicity", "zeroshot"]);

export const ROUTING_KEYS = Object.freeze({
  REQUESTED: "classification.requested",
  RESULT_ALL: "classification.result.*",
  FAILED_ALL: "classification.failed.*"
});

export function resultRoutingKey(classifierName) {
  return `classification.result.${classifierName}`;
}

export function failedRoutingKey(classifierName) {
  return `classification.failed.${classifierName}`;
}

export function technicalDlqRoutingKey(classifierName) {
  return `classification.dlq.${classifierName}`;
}

export const QUEUES = Object.freeze({
  SENTIMENT_REQUESTS: "sentiment.classification.requests",
  TOXICITY_REQUESTS: "toxicity.classification.requests",
  ZEROSHOT_REQUESTS: "zeroshot.classification.requests",
  POSTS_RESULTS: "posts.classification.results"
});

const REQUEST_QUEUE_BY_CLASSIFIER = Object.freeze({
  sentiment: QUEUES.SENTIMENT_REQUESTS,
  toxicity: QUEUES.TOXICITY_REQUESTS,
  zeroshot: QUEUES.ZEROSHOT_REQUESTS
});

export function classifierRequestQueue(classifierName) {
  return REQUEST_QUEUE_BY_CLASSIFIER[classifierName];
}

export function dlqName(queueName) {
  return `${queueName}.dlq`;
}

export async function setupClassificationTopology(channel, exchangeName) {
  await assertTopicExchange(channel, exchangeName, { durable: true });

  for (const classifierName of CLASSIFIERS) {
    const queueName = classifierRequestQueue(classifierName);
    await setupClassifierQueue(channel, exchangeName, queueName, classifierName);
  }

  await assertQueue(channel, QUEUES.POSTS_RESULTS, { durable: true });
  await bindQueue(channel, QUEUES.POSTS_RESULTS, exchangeName, ROUTING_KEYS.RESULT_ALL);
  await bindQueue(channel, QUEUES.POSTS_RESULTS, exchangeName, ROUTING_KEYS.FAILED_ALL);
}

async function setupClassifierQueue(channel, exchangeName, queueName, classifierName) {
  await assertQueue(channel, dlqName(queueName), { durable: true });
  await bindQueue(channel, dlqName(queueName), exchangeName, technicalDlqRoutingKey(classifierName));

  await assertQueue(channel, queueName, {
    durable: true,
    deadLetterExchange: exchangeName,
    deadLetterRoutingKey: technicalDlqRoutingKey(classifierName)
  });

  await bindQueue(channel, queueName, exchangeName, ROUTING_KEYS.REQUESTED);
}
