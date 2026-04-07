from pydantic import BaseModel, Field, field_validator

SERVICE_NAME = "zeroshot"
ENDPOINT_PATH = "/predictzeroshot"
TASK = "zero-shot-classification"
DEFAULT_MODEL_ID = "facebook/bart-large-mnli"
PIPELINE_KWARGS = {}


class RequestModel(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    candidate_labels: list[str] = Field(..., min_length=2, max_length=20)
    multi_label: bool = False
    hypothesis_template: str = "This text is about {}."

    @field_validator("candidate_labels")
    @classmethod
    def validate_candidate_labels(cls, value: list[str]):
        cleaned = [item.strip() for item in value if item and item.strip()]
        if len(cleaned) < 2:
            raise ValueError("At least two non-empty candidate labels are required")
        return cleaned


class ResponseModel(BaseModel):
    request_id: str
    model: str
    sequence: str
    labels: list[str]
    scores: list[float]


def predict(model, payload: dict):
    return model(
        sequences=payload["text"],
        candidate_labels=payload["candidate_labels"],
        multi_label=payload["multi_label"],
        hypothesis_template=payload["hypothesis_template"],
    )


def build_response(request_id: str, model_id: str, prediction):
    return ResponseModel(
        request_id=request_id,
        model=model_id,
        sequence=prediction["sequence"],
        labels=prediction["labels"],
        scores=prediction["scores"],
    )


def log_payload(payload: dict):
    return {
        "text_length": len(payload["text"]),
        "candidate_labels_count": len(payload["candidate_labels"]),
        "multi_label": payload["multi_label"],
    }
