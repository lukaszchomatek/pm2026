import logging
from typing import Any

from transformers import pipeline

logger = logging.getLogger(__name__)

_MODELS: dict[tuple, Any] = {}


def _freeze_kwargs(kwargs: dict[str, Any]) -> tuple:
    return tuple(sorted(kwargs.items()))


def get_model(task: str, model_id: str, model_revision: str | None, use_gpu: bool, pipeline_kwargs: dict[str, Any] | None = None):
    pipeline_kwargs = pipeline_kwargs or {}
    key = (task, model_id, model_revision, use_gpu, _freeze_kwargs(pipeline_kwargs))

    if key in _MODELS:
        return _MODELS[key]

    device = 0 if use_gpu else -1

    logger.info(
        "Loading model task=%s model_id=%s revision=%s device=%s pipeline_kwargs=%s",
        task,
        model_id,
        model_revision,
        device,
        pipeline_kwargs,
    )

    _MODELS[key] = pipeline(
        task=task,
        model=model_id,
        revision=model_revision,
        device=device,
        **pipeline_kwargs,
    )

    logger.info("Model loaded successfully")
    return _MODELS[key]
