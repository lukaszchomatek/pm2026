import logging

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request

from app.core.config import build_config
from app.core.middleware import add_request_id
from app.core.model_loader import get_model


logger = logging.getLogger("hf-inference-service")


def create_app(service_module) -> FastAPI:
    config = build_config(service_module)
    pipeline_kwargs = getattr(service_module, "PIPELINE_KWARGS", {})

    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        get_model(
            task=config.task,
            model_id=config.model_id,
            model_revision=config.model_revision,
            use_gpu=config.use_gpu,
            pipeline_kwargs=pipeline_kwargs,
        )
        yield

    app = FastAPI(
        title=f"{config.service_name} service",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.middleware("http")(add_request_id)

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "service": config.service_name,
            "task": config.task,
            "model": config.model_id,
            "revision": config.model_revision,
            "endpoint": config.endpoint_path,
            "gpu_enabled": config.use_gpu,
        }

    @app.post(config.endpoint_path, response_model=service_module.ResponseModel)
    def predict(payload: service_module.RequestModel, request: Request):
        model = get_model(
            task=config.task,
            model_id=config.model_id,
            model_revision=config.model_revision,
            use_gpu=config.use_gpu,
            pipeline_kwargs=pipeline_kwargs,
        )

        payload_dict = payload.model_dump()
        prediction = service_module.predict(model, payload_dict)
        response = service_module.build_response(
            request_id=request.state.request_id,
            model_id=config.model_id,
            prediction=prediction,
        )

        logger.info(
            "request_id=%s service=%s endpoint=%s payload=%s",
            request.state.request_id,
            config.service_name,
            config.endpoint_path,
            service_module.log_payload(payload_dict),
        )

        return response

    return app
