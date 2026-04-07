import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ServiceConfig:
    service_name: str
    endpoint_path: str
    task: str
    model_id: str
    model_revision: str | None
    use_gpu: bool
    log_level: str


def build_config(service_module) -> ServiceConfig:
    default_model_id = getattr(service_module, "DEFAULT_MODEL_ID")
    return ServiceConfig(
        service_name=getattr(service_module, "SERVICE_NAME"),
        endpoint_path=getattr(service_module, "ENDPOINT_PATH"),
        task=getattr(service_module, "TASK"),
        model_id=os.getenv("MODEL_ID", default_model_id),
        model_revision=os.getenv("MODEL_REVISION") or None,
        use_gpu=os.getenv("USE_GPU", "1") == "1",
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
