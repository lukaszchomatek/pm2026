import os
import logging
from transformers import pipeline

logger = logging.getLogger(__name__)

_MODEL = None


def get_classifier():
    global _MODEL

    if _MODEL is not None:
        return _MODEL

    model_id = os.getenv("MODEL_ID", "cardiffnlp/twitter-roberta-base-sentiment-latest")
    use_gpu = os.getenv("USE_GPU", "1") == "1"

    device = 0 if use_gpu else -1

    logger.info("Loading model '%s' on device=%s", model_id, device)

    _MODEL = pipeline(
        task="sentiment-analysis",
        model=model_id,
        device=device,
    )

    logger.info("Model loaded successfully")

    return _MODEL