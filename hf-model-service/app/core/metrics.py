from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

classifier_messages_consumed_total = Counter("classifier_messages_consumed_total", "Consumed classifier messages", ["classifier"])
classifier_success_total = Counter("classifier_success_total", "Successful classifier runs", ["classifier"])
classifier_errors_total = Counter("classifier_errors_total", "Classifier processing errors", ["classifier"])
classifier_results_published_total = Counter("classifier_results_published_total", "Published result events", ["classifier", "status"])
classifier_duration_seconds = Histogram("classifier_duration_seconds", "Classifier processing duration", ["classifier"], buckets=(0.05,0.1,0.3,0.5,1,2,5,10,30))

def render_metrics():
    return generate_latest(), CONTENT_TYPE_LATEST
