#!/usr/bin/env python3
"""hpm-ocr-rapid: screen OCR with RapidOCR (PaddleOCR models) on the CPU.

Spawns resident, speaks NDJSON over stdio (one JSON object per line), the
same protocol as hpm-ocr-hailo.py:

  -> {"type":"ocr","id":1,"image":"<base64>","det_limit_side_len":1280,
      "min_conf":0.5,"scale":1.0}
  <- {"type":"result","id":1,"ok":true,"engine":"rapidocr","text":"..."}
  <- {"type":"result","id":1,"ok":false,"engine":"rapidocr","error":"..."}
  -> {"type":"quit"}
  <- {"type":"ready","engine":"rapidocr","backend":"openvino"}
  <- {"type":"fatal","engine":"rapidocr","error":"..."}   (if the backend
     cannot be imported or the models cannot load)

Backend selection (env HPM_OCR_RAPID_BACKEND):
  openvino     -> rapidocr_openvino   (fastest measured: ~3 s/frame)
  onnxruntime  -> rapidocr_onnxruntime (~6 s/frame)
  auto (default) -> openvino if importable, else onnxruntime

The PaddleOCR models (ch_PP-OCRv3 mobile det/rec/cls) ship inside the
rapidocr_* wheel, so there is nothing to download. Run the worker from a
venv that has `rapidocr_openvino` (recommended) or `rapidocr_onnxruntime`
installed; point the daemon at it with processing.ocr.options.python or
HPM_OCR_PYTHON.

Known quality notes: the recognition vocabulary is the Chinese PP-OCRv3
dictionary; Latin text comes out clean, accented letters are dropped (the
same limitation as the Hailo engine). Fine for full-text search, not for
faithful transcription.
"""

import base64
import json
import os
import sys
import time

ENGINE = "rapidocr"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fatal(message):
    emit({"type": "fatal", "engine": ENGINE, "error": message})
    sys.exit(1)


def pick_backend():
    """Return (RapidOCR class, backend name) for the requested backend."""
    import warnings

    requested = os.environ.get("HPM_OCR_RAPID_BACKEND", "auto").lower()
    order = [requested] if requested in ("openvino", "onnxruntime") \
        else ["openvino", "onnxruntime"]
    last_err = None
    with warnings.catch_warnings():
        # rapidocr_openvino imports the deprecated openvino.runtime shim;
        # keep its DeprecationWarning out of the worker stderr.
        warnings.simplefilter("ignore")
        for name in order:
            try:
                if name == "openvino":
                    from rapidocr_openvino import RapidOCR
                else:
                    from rapidocr_onnxruntime import RapidOCR
                return RapidOCR, name
            except ImportError as e:
                last_err = e
    fatal(
        "no RapidOCR backend importable "
        "(tried: %s): %s. Install rapidocr_openvino or "
        "rapidocr_onnxruntime in the python environment." % (", ".join(order), last_err)
    )


def build_engine(RapidOCR, backend):
    """Construct the RapidOCR engine.

    The models live next to the installed backend package; their path is
    resolved from the module so the worker works from any cwd.
    """
    import importlib
    import warnings
    from pathlib import Path

    pkg_mod = importlib.import_module("rapidocr_" + backend)
    pkg_dir = Path(pkg_mod.__file__).parent
    det_model = pkg_dir / "models" / "ch_PP-OCRv3_det_infer.onnx"
    if not det_model.is_file():
        fatal("model file missing: %s (broken rapidocr installation?)" % det_model)
    # RapidOCR 1.2.x requires det_model_path whenever any det_* kwarg is
    # given (see UpdateParameters.update_det_params).
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return RapidOCR(
            det_model_path=str(det_model),
            det_limit_side_len=1280,
        )


def decode_image(raw_b64):
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(base64.b64decode(raw_b64), np.uint8),
                         cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image could not be decoded")
    return image


def order_key(item):
    # Reading order: top to bottom, then left to right.
    box = item[0]
    cy = (box[0][1] + box[2][1]) / 2.0
    cx = (box[0][0] + box[2][0]) / 2.0
    return (cy, cx)


def ocr_image(engine, raw_b64, scale=1.0, min_conf=0.5, det_limit_side_len=1280):
    image = decode_image(raw_b64)
    if scale != 1.0:
        import cv2

        image = cv2.resize(image, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_AREA if scale < 1.0
                           else cv2.INTER_CUBIC)
    # det_limit_side_len is read from the engine config at inference time;
    # rebuild is avoided by patching the live config when it differs.
    if det_limit_side_len != 1280:
        det_cfg = getattr(engine.text_detector, "det_cfg", None)
        if isinstance(det_cfg, dict):
            try:
                det_cfg["pre_process"]["DetResizeForTest"]["limit_side_len"] = int(
                    det_limit_side_len)
            except (KeyError, TypeError):
                pass
    res, elapse = engine(image)
    if res is None:
        return "", elapse
    lines = []
    for item in sorted(res, key=order_key):
        _box, text, score = item
        try:
            conf = float(score)
        except (TypeError, ValueError):
            conf = 0.0
        if text and conf >= min_conf:
            lines.append(text)
    return "\n".join(lines), elapse


def main():
    RapidOCR, backend = pick_backend()
    engine = build_engine(RapidOCR, backend)
    emit({"type": "ready", "engine": ENGINE, "backend": backend})

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
            scale = float(msg.get("scale") or 1.0)
            min_conf = float(msg.get("min_conf") or 0.5)
            det_len = int(msg.get("det_limit_side_len") or 1280)
            text, elapse = ocr_image(engine, msg.get("image", ""),
                                     scale=scale, min_conf=min_conf,
                                     det_limit_side_len=det_len)
            elapsed = time.perf_counter() - started
            parts = " ".join("%.2f" % e for e in (elapse or []))
            sys.stderr.write(
                "hpm-ocr-rapid: ocr id=%s %.2fs [%s]\n" % (mid, elapsed, parts)
            )
            sys.stderr.flush()
            emit({"type": "result", "id": mid, "ok": True,
                  "engine": ENGINE, "backend": backend, "text": text})
        except Exception as e:  # noqa: BLE001 - report, keep serving
            emit({"type": "result", "id": mid, "ok": False,
                  "engine": ENGINE, "error": str(e)})


if __name__ == "__main__":
    main()
