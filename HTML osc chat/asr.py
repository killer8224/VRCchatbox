"""Local speech-to-text for VRC Chatbox (Qwen3-ASR via sherpa-onnx).

This module only adds a Flask blueprint under /api/asr/*. It never creates its
own app, never opens its own port and never touches the original OSC routes, so
the rest of VRC Chatbox keeps working when sherpa-onnx or the model files are
missing: the failure is reported through GET /api/asr/status instead.

Audio flow (same contract as the standalone prototype):
    browser captures mic -> resamples to 16 kHz float32 -> base64 PCM frames
    -> POST /api/asr/audio (final=false while speaking, final=true on pause)
    -> the accumulated utterance is re-decoded so interim text can be revised.
"""
from __future__ import annotations

import base64
import json
import sys
import threading
import time
from pathlib import Path

from flask import Blueprint, jsonify, request

asr_api = Blueprint("asr_api", __name__)


def _runtime_base() -> Path:
    # In PyInstaller distributions user data lives beside the EXE, matching
    # osc_viewer.py and frontend_store.py.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = _runtime_base()
CONFIG_DIR = BASE_DIR / "config"
CONFIG_PATH = CONFIG_DIR / "asr.json"

DEFAULT_CONFIG = {
    "model_dir": "models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    "num_threads": 6,
    "max_new_tokens": 128,
    "max_utterance_seconds": 18,
    "sample_rate": 16000,
    "feature_dim": 128,
    "provider": "cpu",
    "language": "",
}

# Qwen3-ASR turns this value into a "language <name>" prompt, so only English
# language names are accepted. An empty string means "do not inject the hint".
ALLOWED_LANGUAGES = {
    "", "Chinese", "English", "Japanese", "Korean", "Cantonese",
    "French", "German", "Spanish", "Russian", "Italian", "Portuguese",
    "Arabic", "Thai", "Vietnamese", "Indonesian", "Hindi", "Turkish",
    "Dutch", "Polish", "Ukrainian", "Czech", "Persian", "Malay",
}

CONFIG = dict(DEFAULT_CONFIG)


def _coerce(raw) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if isinstance(raw, dict):
        for key, default in DEFAULT_CONFIG.items():
            value = raw.get(key, default)
            if isinstance(default, int):
                try:
                    cfg[key] = int(value)
                except (TypeError, ValueError):
                    cfg[key] = default
            else:
                cfg[key] = str(value) if value is not None else default
    for key, low, high in (
        ("num_threads", 1, 32),
        ("max_new_tokens", 16, 4096),
        ("max_utterance_seconds", 2, 120),
        ("sample_rate", 8000, 48000),
        ("feature_dim", 40, 512),
    ):
        cfg[key] = min(max(cfg[key], low), high)
    if cfg["language"] not in ALLOWED_LANGUAGES:
        cfg["language"] = ""
    return cfg


def _load_config() -> dict:
    try:
        return _coerce(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return dict(DEFAULT_CONFIG)
    except (OSError, ValueError, TypeError):
        return dict(DEFAULT_CONFIG)


def _write_default_config() -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError:
        pass  # Read-only install: defaults still work in memory.


CONFIG = _load_config()
if not CONFIG_PATH.exists():
    _write_default_config()

_np = None
_np_error = ""
_recognizer = None
_state = {"status": "idle", "error": "", "loaded_at": 0.0, "load_seconds": 0.0}
_state_lock = threading.Lock()
_model_lock = threading.Lock()
_audio_lock = threading.Lock()
_utterance = None
_utterance_id = 0


def _numpy():
    """Import numpy lazily so a missing dependency only disables this tab."""
    global _np, _np_error
    if _np is not None:
        return _np
    if _np_error:
        raise RuntimeError(_np_error)
    try:
        import numpy
    except Exception as exc:  # pragma: no cover - depends on install
        _np_error = f"缺少 numpy：{type(exc).__name__}: {exc}"
        raise RuntimeError(_np_error)
    _np = numpy
    return _np


def _empty_audio():
    np = _numpy()
    return np.zeros(0, dtype=np.float32)


def model_paths():
    directory = (BASE_DIR / CONFIG["model_dir"]).resolve()
    return directory, {
        "conv_frontend": directory / "conv_frontend.onnx",
        "encoder": directory / "encoder.int8.onnx",
        "decoder": directory / "decoder.int8.onnx",
        "tokenizer": directory / "tokenizer",
    }


def _load_model() -> None:
    global _recognizer
    started = time.time()
    try:
        np = _numpy()  # noqa: F841 - fail fast with a readable message
        import sherpa_onnx
        directory, paths = model_paths()
        missing = [str(path) for path in paths.values() if not path.exists()]
        if missing:
            raise RuntimeError(
                "找不到模型文件：\n" + "\n".join(missing)
                + "\n请把模型目录放到 " + str(directory)
            )
        recognizer = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=str(paths["conv_frontend"]),
            encoder=str(paths["encoder"]),
            decoder=str(paths["decoder"]),
            tokenizer=str(paths["tokenizer"]),
            num_threads=int(CONFIG["num_threads"]),
            sample_rate=int(CONFIG["sample_rate"]),
            feature_dim=int(CONFIG["feature_dim"]),
            provider=str(CONFIG["provider"]),
            max_new_tokens=int(CONFIG["max_new_tokens"]),
        )
        _recognizer = recognizer
        with _state_lock:
            _state.update(status="ready", error="", loaded_at=time.time(),
                          load_seconds=round(time.time() - started, 2))
        print(f"[asr] 模型已加载（{_state['load_seconds']}s）：{directory}", flush=True)
    except Exception as exc:
        _recognizer = None
        with _state_lock:
            _state.update(status="error", loaded_at=0.0, load_seconds=0.0,
                          error=f"模型加载失败：{type(exc).__name__}: {exc}")
        print(f"[asr] {_state['error']}", flush=True)


def start_loading() -> None:
    with _state_lock:
        if _state["status"] in ("loading", "ready"):
            return
        _state.update(status="loading", error="")
    threading.Thread(target=_load_model, name="asr-model-loader", daemon=True).start()


def _language(value):
    # Missing field -> config default; explicit "" -> auto (no hint).
    if value is None:
        return str(CONFIG.get("language", ""))
    text = str(value).strip()
    return text if text in ALLOWED_LANGUAGES else str(CONFIG.get("language", ""))


def _decode(audio, language: str) -> str:
    if _recognizer is None or len(audio) == 0:
        return ""
    stream = _recognizer.create_stream()
    if language:
        stream.set_option("language", language)
    stream.accept_waveform(int(CONFIG["sample_rate"]), audio)
    _recognizer.decode_stream(stream)
    return (getattr(stream.result, "text", "") or "").strip()


@asr_api.get("/api/asr/status")
def asr_status():
    if request.args.get("load") == "1":
        start_loading()
    directory, _ = model_paths()
    with _state_lock:
        snapshot = dict(_state)
    return jsonify({
        "status": snapshot["status"],
        "error": snapshot["error"],
        "load_seconds": snapshot["load_seconds"],
        "model_dir": str(directory),
        "model_ready": snapshot["status"] == "ready",
        "threads": int(CONFIG["num_threads"]),
        "sample_rate": int(CONFIG["sample_rate"]),
        "language": str(CONFIG.get("language", "")),
        "languages": sorted(x for x in ALLOWED_LANGUAGES if x),
        "max_utterance_seconds": int(CONFIG["max_utterance_seconds"]),
    })


@asr_api.post("/api/asr/audio")
def asr_audio():
    global _utterance, _utterance_id
    with _state_lock:
        status = _state["status"]
        error = _state["error"]
    if _recognizer is None:
        message = error or ("模型正在加载，请稍候…" if status == "loading" else "模型未加载")
        return jsonify({"error": message}), 503

    data = request.get_json(silent=True) or {}
    final = bool(data.get("final", False))
    language = _language(data.get("language"))
    np = _numpy()
    try:
        raw = base64.b64decode(data.get("pcm", "") or "", validate=False)
        samples = np.frombuffer(raw, dtype="<f4").copy() if raw else _empty_audio()
    except Exception as exc:
        return jsonify({"error": f"音频数据无效：{exc}"}), 400

    max_samples = int(CONFIG["max_utterance_seconds"]) * int(CONFIG["sample_rate"])
    with _audio_lock:
        if _utterance is None:
            _utterance = _empty_audio()
        if len(samples):
            _utterance = np.concatenate((_utterance, samples))
            if len(_utterance) > max_samples:
                # Bounded rolling window; the browser can finalize sooner.
                _utterance = _utterance[-max_samples:]
        current = _utterance.copy()
        current_id = _utterance_id
        if final:
            _utterance = _empty_audio()
            _utterance_id += 1

    if len(current) == 0:
        return jsonify({"text": "", "final": final, "utterance_id": current_id})

    try:
        with _model_lock:  # one decode at a time
            text = _decode(current, language)
    except Exception as exc:
        return jsonify({"error": f"识别失败：{type(exc).__name__}: {exc}"}), 500

    return jsonify({"text": text, "final": final, "utterance_id": current_id})


@asr_api.post("/api/asr/reset")
def asr_reset():
    global _utterance, _utterance_id
    try:
        with _audio_lock:
            _utterance = _empty_audio()
            _utterance_id += 1
    except RuntimeError:
        # numpy missing: there is no buffer to clear, so this is not an error.
        pass
    return jsonify({"ok": True})
