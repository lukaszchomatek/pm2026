import importlib
import os

from app.core.factory import create_app

service_kind = os.getenv("SERVICE_KIND", "sentiment")
service_module = importlib.import_module(f"app.services.{service_kind}")

app = create_app(service_module)
