# Hailo OCR helper

Python server that runs the official PaddleOCR-on-Hailo pipeline (text
detection + recognition) on a Hailo-8 NPU. The hyprmnesia daemon spawns it as
a resident worker and talks NDJSON over stdio; see `hpm-ocr-hailo.py`.

The `hailo` OCR engine (`processing.ocr.engine: hailo`) is for machines with a
Hailo accelerator, e.g. a Raspberry Pi 5 with the Hailo-8 HAT. Everywhere
else keep the default (`auto`, tesseract).

## Install (Raspberry Pi 5, Debian)

```sh
# driver + runtime + python binding (Raspberry Pi repo)
sudo apt install hailo-all
# OCR pipeline dependencies
sudo apt install python3-shapely python3-pyclipper
```

Download the compiled models (Hailo-8, from hailo-ai/hailo-apps):

```sh
mkdir -p ~/.hyprmnesia/ocr-models
cd ~/.hyprmnesia/ocr-models
wget https://hailo-csdata.s3.eu-west-2.amazonaws.com/resources/hefs/h8/ocr_det.hef
wget https://hailo-csdata.s3.eu-west-2.amazonaws.com/resources/hefs/h8/ocr.hef
```

Select the engine in `~/.hyprmnesia/config.yaml` and restart the daemon:

```yaml
processing:
  ocr:
    engine: hailo
    options:
      # scale: 1 on large screens, 2 on small ones with fine text
      scale: 1
```

Verify the NPU is visible: `hailortcli scan` and `ls /dev/hailo0`.

## Files

- `hpm-ocr-hailo.py` — the worker. NDJSON protocol, tiled detection, CTC decode.
- `hailo_infer.py` — trimmed from `hailo-ai/hailo-apps` (Apache-2.0).
- `db_postprocess.py` — from PaddleOCR via `hailo-ai/hailo-apps` (Apache-2.0).

## Environment variables

- `HPM_OCR_DET` — detection HEF, default `~/.hyprmnesia/ocr-models/ocr_det.hef`
- `HPM_OCR_REC` — recognition HEF, default `~/.hyprmnesia/ocr-models/ocr.hef`
- `HPM_OCR_PYTHON` — interpreter used by the daemon to spawn the worker,
  default `python3`

## Known limitations

- The recognition vocabulary is a 96-entry ASCII set (95 printable
  characters + blank): no accents.
- Spaces are dropped between some words; `l`/`1` and `i`/`l` are confused.
  Fine for full-text search, not for faithful transcription.
- Measured on a 4K capture: ~2.7 s per frame (22 text lines), ~5.9 s on a
  busy browser (140 lines). One frame per 5 s is the capture pace, so a very
  busy screen makes the OCR queue lag, like any slow engine.
