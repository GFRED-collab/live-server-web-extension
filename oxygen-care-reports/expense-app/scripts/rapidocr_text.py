"""Read a receipt image from stdin and print its text, one receipt row per line.

Used by server.mjs as the local failover when Tesseract cannot read a receipt.
RapidOCR returns separate text boxes, so boxes on the same row (for example
"TOTAL" and "17.49") are joined left to right; the receipt parser relies on that.
"""

import logging
import sys

from rapidocr import RapidOCR


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
    image = sys.stdin.buffer.read()
    if not image:
        sys.exit(2)
    logging.disable(logging.CRITICAL)
    result = RapidOCR(params={"Global.log_level": "critical"})(image)
    if result.boxes is None or result.txts is None:
        return
    sys.stdout.write("\n".join(rows(result.boxes, result.txts)) + "\n")


if __name__ == "__main__":
    main()
