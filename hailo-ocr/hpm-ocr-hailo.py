#!/usr/bin/env python3
"""hpm-ocr-hailo: screen OCR on a Hailo NPU (PaddleOCR models).

Spawns resident, speaks NDJSON over stdio (one JSON object per line):

  -> {"type":"ocr","id":1,"image":"<base64>","scale":1.0,"min_conf":0.5}
  <- {"type":"result","id":1,"ok":true,"engine":"hailo","text":"..."}
  <- {"type":"result","id":1,"ok":false,"engine":"hailo","error":"..."}
  -> {"type":"quit"}
  <- {"type":"ready","engine":"hailo"}         (after the models are loaded)
  <- {"type":"fatal","engine":"hailo","error"} (if the models cannot load)

Models are Hailo-8 HEF files from the official hailo-ai/hailo-apps
`standalone_apps/paddle_ocr` (download_resources.sh --arch 8):

  HPM_OCR_DET  default ~/.hyprmnesia/ocr-models/ocr_det.hef   (544x960x3 -> heat)
  HPM_OCR_REC  default ~/.hyprmnesia/ocr-models/ocr.hef      (48x320x3 -> CTC)

The recognition vocabulary is a 96-entry pure-ASCII set (95 printable
characters + the blank token); accented text comes out without accents.

Image strategy (measured on a 4K screen capture, see the 2026-09-11 note):
the detection model is run on exact-size 960x544 tiles with 64 px overlap,
never downscaled; boxes from overlapping tiles are deduped and re-merged;
each detected line is split into pieces of aspect ratio under 5.5 before
recognition, because the 48x320 recognizer input squashes longer lines.
"""

import base64
import contextlib
import glob
import io
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2
import numpy as np

from db_postprocess import DBPostProcess
from hailo_infer import HailoInfer

DET_H, DET_W = 544, 960
REC_H, REC_W = 48, 320
DEFAULT_OVERLAP = 64
DEFAULT_MIN_CONF = 0.5
# Aspect ratio beyond which the recognizer squashes the text. Kept below the
# 6.67 of the 48x320 input, with a margin.
MAX_RATIO = 5.5

# The 96-entry vocabulary of the recognizer (CTC decode order), verbatim from
# hailo_apps/python/standalone_apps/paddle_ocr/paddle_ocr_utils.py. Index 0 is
# the blank token. Pure ASCII: digits, punctuation, A-Z, a-z, space.
CHARACTERS = [
    "blank", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=",
    ">", "?", "@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
    "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "[", "\\",
    "]", "^", "_", "`", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
    "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "{",
    "|", "}", "~", "!", '"', "#", "$", "%", "&", "'", "(", ")", "*", "+", ",",
    "-", ".", "/", " ", " ",
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fatal(message):
    emit({"type": "fatal", "engine": "hailo", "error": message})
    sys.exit(1)


# ---------------------------------------------------------------------------
# Hailo inference
# ---------------------------------------------------------------------------


def infer(engine, frame):
    """Synchronous call on a HailoInfer, which only exposes async."""
    out = {}

    def done(completion_info, bindings_list):
        out["res"] = bindings_list[0].output().get_buffer()

    engine.run([frame], done).wait(10000)
    return out["res"]


# ---------------------------------------------------------------------------
# Recognition postprocess (CTC decode), from paddle_ocr_utils.py
# ---------------------------------------------------------------------------


def ocr_eval_postprocess(infer_results):
    """Decode raw recognizer outputs (LxC or BxLxC) into (text, confidence)."""
    dict_character = CHARACTERS
    ignored_tokens = [0]

    if isinstance(infer_results, list):
        infer_results = np.array(infer_results)
    if infer_results.ndim == 2:
        infer_results = np.expand_dims(infer_results, axis=0)

    text_prob = infer_results.max(axis=2)  # BxL
    text_index = infer_results.argmax(axis=2)  # BxL

    results = []
    for batch_idx in range(len(text_index)):
        selection = np.ones(len(text_index[batch_idx]), dtype=bool)
        selection[1:] = text_index[batch_idx][1:] != text_index[batch_idx][:-1]
        for ignored_token in ignored_tokens:
            selection &= text_index[batch_idx] != ignored_token
        char_list = [dict_character[text_id] for text_id in text_index[batch_idx][selection]]
        conf_list = text_prob[batch_idx][selection] if text_prob is not None else [1] * len(selection)
        if len(conf_list) == 0:
            conf_list = [0]
        results.append(("".join(char_list), np.mean(conf_list).tolist()))
    return results


def resize_with_padding(image, target_height=REC_H, target_width=REC_W, pad_value=128):
    """Resize preserving aspect ratio, center-padded to the recognizer input."""
    h, w = image.shape[:2]
    scale = min(target_width / w, target_height / h)
    new_w, new_h = int(w * scale), int(h * scale)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
    pad_top = (target_height - new_h) // 2
    pad_bottom = target_height - new_h - pad_top
    pad_left = (target_width - new_w) // 2
    pad_right = target_width - new_w - pad_left
    if image.ndim == 3:
        padded = cv2.copyMakeBorder(
            resized, pad_top, pad_bottom, pad_left, pad_right,
            borderType=cv2.BORDER_CONSTANT, value=[pad_value] * 3,
        )
    else:
        padded = cv2.copyMakeBorder(
            resized, pad_top, pad_bottom, pad_left, pad_right,
            borderType=cv2.BORDER_CONSTANT, value=pad_value,
        )
    return padded


# ---------------------------------------------------------------------------
# Detection postprocess (DB), from paddle_ocr_utils.py + db_postprocess.py
# ---------------------------------------------------------------------------


def resize_heatmap_to_original(heatmap, original_size, model_w, model_h):
    """Resize the model heatmap back to the original image size."""
    orig_h, orig_w = original_size
    scale = min(model_w / orig_w, model_h / orig_h)
    new_w, new_h = int(orig_w * scale), int(orig_h * scale)
    x_offset = (model_w - new_w) // 2
    y_offset = (model_h - new_h) // 2
    cropped = heatmap[y_offset:y_offset + new_h, x_offset:x_offset + new_w]
    return cv2.resize(cropped, (orig_w, orig_h), interpolation=cv2.INTER_CUBIC)


def warp_to_rectangle(image, poly):
    """Warp a quadrilateral region into a rectangle for recognition."""
    poly = poly.astype(np.float32)
    w = int(np.linalg.norm(poly[0] - poly[1]))
    h = int(np.linalg.norm(poly[0] - poly[3]))
    dst_pts = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(poly, dst_pts)
    return cv2.warpPerspective(image, m, (w, h), flags=cv2.INTER_LINEAR)


def get_cropped_text_images(heatmap, orig_img, model_height, model_width, bin_thresh=0.3):
    """Extract rectified text-line crops and their boxes from a heat map."""
    postprocess = DBPostProcess(
        thresh=bin_thresh, box_thresh=0.6, max_candidates=1000, unclip_ratio=1.5,
    )
    heatmap_resized = resize_heatmap_to_original(
        heatmap, original_size=orig_img.shape[:2],
        model_w=model_width, model_h=model_height,
    )
    preds = {"maps": heatmap_resized[None, None, :, :]}
    boxes_batch = postprocess(preds, [(*orig_img.shape[:2], 1.0, 1.0)])
    boxes = boxes_batch[0]["points"]

    cropped_images = []
    boxes_location = []
    for box in boxes:
        try:
            box = np.array(box).astype(np.int32)
            x, y, w, h = cv2.boundingRect(box)
            boxes_location.append([x, y, w, h])
            cropped = orig_img[y:y + h, x:x + w].copy()
            box[:, 0] -= x
            box[:, 1] -= y
            mask = np.zeros((h, w), dtype=np.uint8)
            cv2.fillPoly(mask, [box], 255)
            cropped = cv2.bitwise_and(cropped, cropped, mask=mask)
            cropped_images.append(warp_to_rectangle(cropped, box))
        except Exception:
            # Boxes glued to the tile edge can fail here; the caller keeps
            # stdout clean while this runs.
            pass
    return cropped_images, boxes_location


# ---------------------------------------------------------------------------
# Tiled detection: exact-size tiles, dedupe, row re-merge
# ---------------------------------------------------------------------------


def detect_boxes(det, image, overlap):
    """Text boxes over the whole image, in exact-size 960x544 tiles."""
    h, w = image.shape[:2]
    step_y, step_x = DET_H - overlap, DET_W - overlap
    boxes = []
    for y0 in range(0, max(h - overlap, 1), step_y):
        for x0 in range(0, max(w - overlap, 1), step_x):
            tile = image[y0:y0 + DET_H, x0:x0 + DET_W]
            th, tw = tile.shape[:2]
            if th < DET_H or tw < DET_W:
                tile = cv2.copyMakeBorder(
                    tile, 0, DET_H - th, 0, DET_W - tw,
                    cv2.BORDER_CONSTANT, value=(255, 255, 255),
                )
            heat = infer(det, cv2.cvtColor(tile, cv2.COLOR_BGR2RGB))[:, :, 0]
            with contextlib.redirect_stdout(io.StringIO()):
                _, locs = get_cropped_text_images(heat, tile, DET_H, DET_W)
            for x, y, bw, bh in locs:
                if x >= tw or y >= th:
                    continue
                boxes.append([x0 + x, y0 + y, min(bw, tw - x), min(bh, th - y)])
    return merge_rows(dedupe(boxes))


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def dedupe(boxes, iou_thresh=0.4):
    """Overlapping tiles can yield the same line twice."""
    kept = []
    for box in sorted(boxes, key=lambda b: -b[2] * b[3]):
        if any(iou(box, k) > iou_thresh for k in kept):
            continue
        kept.append(box)
    return sorted(kept, key=lambda b: (b[1], b[0]))


def merge_rows(boxes):
    """Re-stitch pieces of one line cut by a tile border."""
    rows = []
    for box in sorted(boxes, key=lambda b: (b[1], b[0])):
        x, y, w, h = box
        for row in rows:
            ry, rh = row[0][1], row[0][3]
            if min(y + h, ry + rh) - max(y, ry) > 0.6 * min(h, rh):
                row.append(box)
                break
        else:
            rows.append([box])

    merged = []
    for row in rows:
        row.sort(key=lambda b: b[0])
        cur = list(row[0])
        for x, y, w, h in row[1:]:
            gap = x - (cur[0] + cur[2])
            if gap <= max(cur[3], h):
                top, bot = min(cur[1], y), max(cur[1] + cur[3], y + h)
                cur = [cur[0], top, max(cur[0] + cur[2], x + w) - cur[0], bot - top]
            else:
                merged.append(cur)
                cur = [x, y, w, h]
        merged.append(cur)
    return sorted(merged, key=lambda b: (b[1], b[0]))


def read_box(rec, crop):
    """Recognize a line, splitting it into short enough pieces first."""
    h, w = crop.shape[:2]
    if h < 4 or w < 4:
        return "", 0.0
    chunks = max(1, int(np.ceil(w / (h * MAX_RATIO))))
    edges = np.linspace(0, w, chunks + 1).astype(int)
    parts, confs = [], []
    for i in range(chunks):
        piece = crop[:, edges[i]:edges[i + 1]]
        if piece.shape[1] < 4:
            continue
        padded = resize_with_padding(cv2.cvtColor(piece, cv2.COLOR_BGR2RGB))
        text, conf = ocr_eval_postprocess(infer(rec, padded))[0]
        parts.append(text)
        confs.append(conf)
    return "".join(parts), float(np.mean(confs)) if confs else 0.0


def ocr_image(det, rec, image, scale=1.0, min_conf=DEFAULT_MIN_CONF,
              overlap=DEFAULT_OVERLAP):
    """Full pipeline: tiled detection, then recognition per line."""
    if scale != 1.0:
        image = cv2.resize(image, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_CUBIC)
    boxes = detect_boxes(det, image, overlap)
    lines = []
    for x, y, w, h in boxes:
        text, conf = read_box(rec, image[y:y + h, x:x + w])
        if text.strip() and conf >= min_conf:
            lines.append(text)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Server loop
# ---------------------------------------------------------------------------


def main():
    if not any(glob.glob("/dev/hailo*")):
        fatal("no Hailo device under /dev/hailo*")
    det_path = os.environ.get("HPM_OCR_DET") or str(
        Path.home() / ".hyprmnesia" / "ocr-models" / "ocr_det.hef")
    rec_path = os.environ.get("HPM_OCR_REC") or str(
        Path.home() / ".hyprmnesia" / "ocr-models" / "ocr.hef")
    for path in (det_path, rec_path):
        if not os.path.isfile(path):
            fatal(f"model not found: {path}")

    det = HailoInfer(det_path, 1)
    rec = HailoInfer(rec_path, 1, priority=1)
    emit({"type": "ready", "engine": "hailo"})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "quit":
                break
            if msg.get("type") != "ocr":
                continue
            mid = msg.get("id")
            started = time.perf_counter()
            try:
                raw = base64.b64decode(msg.get("image", ""))
                image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("image could not be decoded")
                scale = float(msg.get("scale") or 1.0)
                min_conf = float(msg.get("min_conf") or DEFAULT_MIN_CONF)
                overlap = int(msg.get("overlap") or DEFAULT_OVERLAP)
                text = ocr_image(det, rec, image, scale=scale,
                                 min_conf=min_conf, overlap=overlap)
                elapsed = time.perf_counter() - started
                sys.stderr.write(f"hpm-ocr-hailo: ocr id={mid} {elapsed:.2f}s\n")
                sys.stderr.flush()
                emit({"type": "result", "id": mid, "ok": True,
                      "engine": "hailo", "text": text})
            except Exception as e:  # noqa: BLE001 - report, keep serving
                emit({"type": "result", "id": mid, "ok": False,
                      "engine": "hailo", "error": str(e)})
    finally:
        det.close()
        rec.close()


if __name__ == "__main__":
    main()
