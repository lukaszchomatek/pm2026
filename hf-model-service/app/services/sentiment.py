from pydantic import BaseModel, Field

SERVICE_NAME = "sentiment"
ENDPOINT_PATH = "/predictsentiment"
TASK = "sentiment-analysis"
DEFAULT_MODEL_ID = "cardiffnlp/twitter-roberta-base-sentiment-latest"
PIPELINE_KWARGS = {}


class LabelScore(BaseModel):
    label: str
    score: float


class RequestModel(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)


class ResponseModel(BaseModel):
    request_id: str
    model: str
    result: list[LabelScore]


def predict(model, payload: dict):
    return model(payload["text"])


def build_response(request_id: str, model_id: str, prediction):
    return ResponseModel(
        request_id=request_id,
        model=model_id,
        result=[LabelScore(**item) for item in prediction],
    )


def log_payload(payload: dict):
    return {"text_length": len(payload["text"]) }
