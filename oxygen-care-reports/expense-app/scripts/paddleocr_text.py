"""Read a receipt image from stdin and print its text, one receipt row per line.

Used by server.mjs as the local fallback when RapidOCR cannot read a receipt.
PaddleOCR returns separate text boxes, so boxes on the same row (for example
"TOTAL" and "17.49") are joined left to right; the receipt parser relies on that.
"""

import logging
import os
import sys

# The models are downloaded by scripts/remote-update.sh into this Python environment
# (it sets PADDLEOCR_DOWNLOAD=1). At runtime the service cannot write there, so skip the
# online model-source check. PaddleX treats any value of that variable as "skip".
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.path.join(sys.prefix, "paddlex-cache"))
if os.environ.get("PADDLEOCR_DOWNLOAD") != "1":
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

import cv2  # noqa: E402  (installed with PaddleOCR)
import numpy  # noqa: E402
from paddleocr import PaddleOCR  # noqa: E402

# Small, CPU-friendly English models; receipt photos are already upright after server-side
# preparation. Naming a model makes PaddleOCR ignore `lang`, so both are named.
OPTIONS = {
    "text_detection_model_name": "PP-OCRv5_mobile_det",
    "text_recognition_model_name": "en_PP-OCRv5_mobile_rec",
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
}


# Same row grouping as rapidocr_text.py. Each helper runs in its own isolated Python
# environment (python3 -I), so they cannot import from each other.
def rows(boxes, texts):
    items = []
    for box, text in zip(boxes, texts):
        ys = [point[1] for point in box]
        xs = [point[0] for point in box]
        items.append((sum(ys) / len(ys), max(ys) - min(ys), min(xs), text))
    items.sort()
    lines = []
    for centre, height, left, text in items:
        # Boxes whose vertical centres are within half a line height share a row.
        if lines and abs(centre - lines[-1]["centre"]) <= max(height, lines[-1]["height"]) / 2:
            lines[-1]["parts"].append((left, text))
        else:
            lines.append({"centre": centre, "height": height, "parts": [(left, text)]})
    return [" ".join(text for _, text in sorted(line["parts"])) for line in lines]


def main():
    data = sys.stdin.buffer.read()
    if not data:
        sys.exit(2)
    image = cv2.imdecode(numpy.frombuffer(data, numpy.uint8), cv2.IMREAD_COLOR)
    if image is None:
        sys.exit(2)
    logging.disable(logging.CRITICAL)
    boxes, texts = [], []
    for result in PaddleOCR(**OPTIONS).predict(image):
        for box, text in zip(result["rec_polys"], result["rec_texts"]):
            if text.strip():
                boxes.append([(float(x), float(y)) for x, y in box])
                texts.append(text)
    if texts:
        sys.stdout.write("\n".join(rows(boxes, texts)) + "\n")


if __name__ == "__main__":
    main()
