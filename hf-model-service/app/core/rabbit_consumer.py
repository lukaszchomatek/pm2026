import json
import logging
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone

import pika

logger = logging.getLogger("hf-inference-service")

REQUEST_ROUTING_KEY = "classification.requested"
QUEUE_NAMES = {
    "sentiment": "sentiment.classification.requests",
    "toxicity": "toxicity.classification.requests",
    "zeroshot": "zeroshot.classification.requests",
}


def technical_dlq_routing_key(classifier_name):
    return f"classification.dlq.{classifier_name}"


class TransientProcessingError(Exception):
    pass


class PermanentProcessingError(Exception):
    pass


class RabbitClassifierConsumer:
    def __init__(self, *, config, service_module, model_getter, pipeline_kwargs):
        self.config = config
        self.service_module = service_module
        self.model_getter = model_getter
        self.pipeline_kwargs = pipeline_kwargs

        self.exchange = os.getenv("CLASSIFICATION_EXCHANGE", "classification")
        self.rabbitmq_url = os.getenv("RABBITMQ_URL", "amqp://localhost:5672")
        self.fail_mode = os.getenv("FAIL_MODE", "none").strip().lower() or "none"

        self.queue_name = QUEUE_NAMES.get(config.service_name)
        if not self.queue_name:
            raise ValueError(f"Unsupported service for queue binding: {config.service_name}")

        self._thread = None
        self._stop_event = threading.Event()

    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"{self.config.service_name}-rabbit-consumer", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self):
        backoff_seconds = 1

        while not self._stop_event.is_set():
            connection = None
            channel = None
            try:
                params = pika.URLParameters(self.rabbitmq_url)
                params.heartbeat = 30
                params.blocked_connection_timeout = 30

                connection = pika.BlockingConnection(params)
                channel = connection.channel()
                channel.basic_qos(prefetch_count=1)

                classifier_name = self.config.service_name
                dead_letter_routing_key = technical_dlq_routing_key(classifier_name)

                channel.exchange_declare(exchange=self.exchange, exchange_type="topic", durable=True)
                channel.queue_declare(
                    queue=self.queue_name,
                    durable=True,
                    arguments={
                        "x-dead-letter-exchange": self.exchange,
                        "x-dead-letter-routing-key": dead_letter_routing_key,
                    },
                )
                channel.queue_bind(queue=self.queue_name, exchange=self.exchange, routing_key=REQUEST_ROUTING_KEY)

                logger.info(
                    "rabbit_consumer_started service=%s exchange=%s queue=%s routing_key=%s dead_letter_exchange=%s dead_letter_routing_key=%s fail_mode=%s",
                    classifier_name,
                    self.exchange,
                    self.queue_name,
                    REQUEST_ROUTING_KEY,
                    self.exchange,
                    dead_letter_routing_key,
                    self.fail_mode,
                )

                while not self._stop_event.is_set():
                    method, properties, body = channel.basic_get(queue=self.queue_name, auto_ack=False)
                    if method is None:
                        time.sleep(0.2)
                        continue

                    self._handle_delivery(channel, method.delivery_tag, body, properties)

                backoff_seconds = 1
            except pika.exceptions.AMQPConnectionError as exc:
                logger.warning(
                    "rabbit_consumer_connection_retry service=%s backoff=%ss error=%s",
                    self.config.service_name,
                    backoff_seconds,
                    str(exc) or exc.__class__.__name__,
                )
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 10)
            except Exception:
                logger.exception("rabbit_consumer_connection_error service=%s", self.config.service_name)
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 10)
            finally:
                if channel and getattr(channel, "is_open", False):
                    try:
                        channel.close()
                    except Exception:
                        pass
                if connection and getattr(connection, "is_open", False):
                    try:
                        connection.close()
                    except Exception:
                        pass

    def _handle_delivery(self, channel, delivery_tag, body, properties):
        try:
            event = json.loads(body.decode("utf-8"))
        except Exception as exc:
            logger.warning("invalid_json service=%s error=%s", self.config.service_name, str(exc))
            channel.basic_ack(delivery_tag=delivery_tag)
            return

        requested = event.get("requestedClassifiers")
        if isinstance(requested, list) and self.config.service_name not in requested:
            logger.info("classifier_skipped service=%s run=%s", self.config.service_name, event.get("classificationRunId"))
            channel.basic_ack(delivery_tag=delivery_tag)
            return

        try:
            result_payload = self._process_message(event)
            routing_key = f"classification.result.{self.config.service_name}"
            self._publish(channel, routing_key, result_payload, properties)
            channel.basic_ack(delivery_tag=delivery_tag)
        except TransientProcessingError as exc:
            logger.warning(
                "transient_error_requeue service=%s run=%s error=%s",
                self.config.service_name,
                event.get("classificationRunId"),
                str(exc),
            )
            channel.basic_nack(delivery_tag=delivery_tag, requeue=True)
        except Exception as exc:
            failed_payload = self._build_failed_payload(event, exc)
            routing_key = f"classification.failed.{self.config.service_name}"
            try:
                self._publish(channel, routing_key, failed_payload, properties)
            except Exception:
                logger.exception("failed_publish_failed_event service=%s", self.config.service_name)
                channel.basic_nack(delivery_tag=delivery_tag, requeue=True)
                return

            channel.basic_ack(delivery_tag=delivery_tag)

    def _process_message(self, event):
        self._validate_event(event)
        self._apply_fail_mode()

        model = self.model_getter(
            task=self.config.task,
            model_id=self.config.model_id,
            model_revision=self.config.model_revision,
            use_gpu=self.config.use_gpu,
            pipeline_kwargs=self.pipeline_kwargs,
        )

        payload_dict = self._payload_for_classifier(event)
        prediction = self.service_module.predict(model, payload_dict)

        normalized_result = self._normalize_prediction(prediction)

        return {
            "messageId": event.get("messageId") or str(uuid.uuid4()),
            "eventType": f"classification.result.{self.config.service_name}",
            "classificationRunId": event.get("classificationRunId"),
            "postId": event.get("postId"),
            "classifier": self.config.service_name,
            "status": "ok",
            "result": normalized_result,
            "modelVersion": "demo-v1",
            "classifiedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _build_failed_payload(self, event, exc):
        return {
            "messageId": event.get("messageId") or str(uuid.uuid4()),
            "eventType": f"classification.failed.{self.config.service_name}",
            "classificationRunId": event.get("classificationRunId"),
            "postId": event.get("postId"),
            "classifier": self.config.service_name,
            "status": "failed",
            "errorType": "processing_error",
            "errorMessage": str(exc),
            "failedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _payload_for_classifier(self, event):
        payload = {"text": event.get("text", "")}

        if self.config.service_name == "zeroshot":
            payload["candidate_labels"] = self._resolve_zeroshot_labels()
            payload["multi_label"] = os.getenv("ZERO_SHOT_MULTI_LABEL", "1") == "1"
            payload["hypothesis_template"] = "This text is about {}."

        return payload

    def _resolve_zeroshot_labels(self):
        raw = os.getenv("ZERO_SHOT_LABELS", '["question","complaint","opinion","announcement","spam"]')
        try:
            parsed = json.loads(raw)
            cleaned = [str(item).strip() for item in parsed if str(item).strip()]
            if len(cleaned) >= 2:
                return cleaned
        except Exception:
            pass

        return ["question", "complaint", "opinion", "announcement", "spam"]

    def _normalize_prediction(self, prediction):
        if self.config.service_name == "sentiment":
            return prediction[0] if isinstance(prediction, list) and prediction else prediction

        if self.config.service_name == "toxicity":
            return prediction if isinstance(prediction, list) else []

        if self.config.service_name == "zeroshot":
            return {
                "sequence": prediction.get("sequence"),
                "labels": prediction.get("labels", []),
                "scores": prediction.get("scores", []),
            }

        return prediction

    def _validate_event(self, event):
        required = ["classificationRunId", "postId", "text"]
        missing = [field for field in required if not event.get(field)]
        if missing:
            raise PermanentProcessingError(f"missing required fields: {', '.join(missing)}")

    def _apply_fail_mode(self):
        if self.fail_mode == "none":
            return

        if self.fail_mode == "slow":
            time.sleep(3)
            return

        if self.fail_mode == "always":
            raise TransientProcessingError("simulated transient failure (FAIL_MODE=always)")

        if self.fail_mode == "random" and random.random() < 0.4:
            raise TransientProcessingError("simulated random transient failure (FAIL_MODE=random)")

    def _publish(self, channel, routing_key, payload, properties):
        message_id = payload.get("messageId") or str(uuid.uuid4())
        body = json.dumps(payload).encode("utf-8")
        channel.basic_publish(
            exchange=self.exchange,
            routing_key=routing_key,
            body=body,
            properties=pika.BasicProperties(
                content_type="application/json",
                delivery_mode=2,
                correlation_id=getattr(properties, "correlation_id", None),
                message_id=message_id,
            ),
            mandatory=False,
        )
