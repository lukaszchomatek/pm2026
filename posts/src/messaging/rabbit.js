import amqp from "amqplib";

export async function connectRabbitMQ(url) {
  if (!url) {
    throw new Error("RABBITMQ_URL is required");
  }

  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();

  return { connection, channel };
}

export async function assertTopicExchange(channel, exchangeName, options = {}) {
  return channel.assertExchange(exchangeName, "topic", {
    durable: true,
    ...options
  });
}

export async function assertQueue(channel, queueName, options = {}) {
  return channel.assertQueue(queueName, {
    durable: true,
    ...options
  });
}

export async function bindQueue(channel, queueName, exchangeName, routingKey) {
  return channel.bindQueue(queueName, exchangeName, routingKey);
}

export function publishJson(channel, exchangeName, routingKey, payload, options = {}) {
  return channel.publish(exchangeName, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true,
    ...options
  });
}

export async function consumeJson(channel, queueName, handler, options = {}) {
  return channel.consume(
    queueName,
    async msg => {
      if (!msg) {
        return;
      }

      try {
        const parsed = JSON.parse(msg.content.toString("utf8"));
        await handler(parsed, msg);
      } catch (error) {
        await handler(null, msg, error);
      }
    },
    options
  );
}
