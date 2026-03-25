import os
import uuid
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from pydantic import BaseModel, Field

from app.model import get_classifier


LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s"
)

logger = logging.getLogger("sentiment-service")


class PredictRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)


class PredictResponse(BaseModel):
    request_id: str
    model: str
    result: list[dict]


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_classifier()
    yield


app = FastAPI(
    title="Sentiment Service",
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = request.headers.get("X-Request-Id", str(uuid.uuid4()))
    request.state.request_id = request_id

    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": os.getenv("MODEL_ID", "cardiffnlp/twitter-roberta-base-sentiment-latest"),
        "gpu_enabled": os.getenv("USE_GPU", "1") == "1",
    }


@app.post("/predict", response_model=PredictResponse)
def predict(payload: PredictRequest, request: Request):
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")

    classifier = get_classifier()
    result = classifier(text)

    logger.info(
        "request_id=%s text_length=%d result=%s",
        request.state.request_id,
        len(text),
        result,
    )

    return PredictResponse(
        request_id=request.state.request_id,
        model=os.getenv("MODEL_ID", "cardiffnlp/twitter-roberta-base-sentiment-latest"),
        result=result,
    )