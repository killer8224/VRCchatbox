"""Local speech-to-text for VRC Chatbox (Qwen3-ASR via llama.cpp on the GPU).

This module only adds a Flask blueprint under /api/asr/*. It never creates its
own app and never touches the original OSC routes, so the rest of VRC Chatbox
keeps working when llama.cpp or the model files are missing: the failure is
reported through GET /api/asr/status instead.

Why llama.cpp instead of sherpa-onnx / ONNX Runtime
---------------------------------------------------
The same Qwen3-ASR 0.6B model used to run through sherpa-onnx on the CPU. That
needed ~1.0 s for a 15 s utterance when the machine was idle and ~3.4 s while
VRChat saturated all 8 cores, which is what made live subtitles feel slow.
Running the identical model as a GGUF through llama.cpp's Vulkan backend on a
Radeon RX 7900 XTX answers the same 15 s utterance in ~0.14 s and keeps the
compute off the cores VRChat needs. DirectML (ONNX Runtime's AMD path) was
measured at 18 tok/s versus 62 tok/s on the CPU, so it is not used here.

Audio flow (unchanged contract with the browser):
    browser captures mic -> resamples to 16 kHz float32 -> base64 PCM frames
    -> POST /api/asr/audio (final=false while speaking, final=true on pause)
    -> the accumulated utterance is re-decoded so interim text can be revised.

llama.cpp is not streaming, but a full re-decode costs ~0.14 s, so the interim
preview keeps working exactly as before.
"""
from __future__ import annotations

import atexit
import base64
import ctypes
import io
import json
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from ctypes import wintypes
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
LOG_PATH = CONFIG_DIR / "llama-server.log"

DEFAULT_CONFIG = {
    "model_dir": "models/llama-qwen3-asr",
    "server_exe": "llama-server.exe",
    "model_file": "Qwen3-ASR-0.6B-Q8_0.gguf",
    "mmproj_file": "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    # Empty = auto-detect the GPU whose name contains device_match.
    # Set to an exact id such as "Vulkan1" to force a specific card.
    "device": "",
    "device_match": "AMD",
    "port": 18760,
    "num_threads": 4,
    "max_utterance_seconds": 18,
    "sample_rate": 16000,
    "language": "",
}

# Qwen3-ASR returns "language <name><asr_text>…". The hint below only nudges it;
# the model still self-detects when language is empty.
ALLOWED_LANGUAGES = {
    "", "Chinese", "English", "Japanese", "Korean", "Cantonese",
    "French", "German", "Spanish", "Russian", "Italian", "Portuguese",
    "Arabic", "Thai", "Vietnamese", "Indonesian", "Hindi", "Turkish",
    "Dutch", "Polish", "Ukrainian", "Czech", "Persian", "Malay",
}

PROMPT_PLAIN = "Transcribe the audio."
PROMPT_HINT = "Transcribe the audio in {language}."

CONFIG = dict(DEFAULT_CONFIG)

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ---------------------------------------------------------------------------
# Windows job object: make the llama-server child die with this process.
#
# atexit only covers a clean shutdown. Closing the console window, killing the
# app from Task Manager or a crash all skip it, and the orphaned server keeps
# holding ~1 GB of VRAM and the port. Putting the child in a job with
# KILL_ON_JOB_CLOSE makes the kernel clean it up as soon as we are gone.
# ---------------------------------------------------------------------------
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9
_job_handle = None


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64)]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD)]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


def _bind_child_lifetime(proc: subprocess.Popen) -> None:
    global _job_handle
    if sys.platform != "win32":
        return
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        if _job_handle is None:
            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                return
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(
                handle, _JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info),
            ):
                kernel32.CloseHandle(handle)
                return
            _job_handle = handle
        kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(_job_handle), wintypes.HANDLE(int(proc._handle))
        )
    except Exception:
        pass  # best effort: atexit still covers a normal exit


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
        ("port", 1024, 65535),
        ("num_threads", 1, 32),
        ("max_utterance_seconds", 2, 120),
        ("sample_rate", 8000, 48000),
    ):
        cfg[key] = min(max(cfg[key], low), high)
    if cfg["language"] not in ALLOWED_LANGUAGES:
        cfg["language"] = ""
    return cfg


def _load_config() -> tuple[dict, bool]:
    """Return (config, needs_rewrite). Old sherpa-onnx configs are replaced."""
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(DEFAULT_CONFIG), True
    except (OSError, ValueError, TypeError):
        return dict(DEFAULT_CONFIG), True
    if isinstance(raw, dict) and "provider" in raw:
        # Pre-llama.cpp schema (sherpa-onnx, provider=cpu). Point it at the new
        # runtime instead of silently loading a model directory that no longer
        # exists.
        return dict(DEFAULT_CONFIG), True
    return _coerce(raw), False


def _write_config(cfg: dict) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass  # Read-only install: defaults still work in memory.


CONFIG, _NEEDS_REWRITE = _load_config()
if _NEEDS_REWRITE:
    _write_config(CONFIG)

_np = None
_np_error = ""
_proc: subprocess.Popen | None = None
_log_handle = None
_port = 0
_device = ""
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


def model_paths() -> dict:
    directory = (BASE_DIR / CONFIG["model_dir"]).resolve()
    return {
        "dir": directory,
        "server": directory / CONFIG["server_exe"],
        "model": directory / CONFIG["model_file"],
        "mmproj": directory / CONFIG["mmproj_file"],
    }


def _pick_port(preferred: int) -> int:
    for port in range(preferred, min(preferred + 20, 65535)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"从 {preferred} 起找不到可用端口")


def _list_devices(exe: Path) -> list[tuple[str, str]]:
    """Parse `llama-server --list-devices` into [(id, name), …]."""
    try:
        out = subprocess.run(
            [str(exe), "--list-devices"], cwd=str(exe.parent), timeout=90,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=_CREATE_NO_WINDOW, text=True, errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return []
    devices = []
    for line in (out.stdout or "").splitlines():
        match = re.match(r"\s*([A-Za-z]+\d+)\s*:\s*(.+?)\s*(?:\(|$)", line)
        if match:
            devices.append((match.group(1), match.group(2).strip()))
    return devices


def _choose_device(exe: Path) -> str:
    if CONFIG["device"]:
        return CONFIG["device"]
    wanted = CONFIG["device_match"].strip().lower()
    if not wanted:
        return ""
    for dev_id, name in _list_devices(exe):
        if wanted in name.lower():
            return dev_id
    # Nothing matched: let llama.cpp pick its own default instead of failing.
    return ""


def _spawn_server(paths: dict) -> subprocess.Popen:
    global _port, _device, _log_handle
    _port = _pick_port(int(CONFIG["port"]))
    _device = _choose_device(paths["server"])
    cmd = [
        str(paths["server"]),
        "-m", str(paths["model"]),
        "--mmproj", str(paths["mmproj"]),
        "-ngl", "99",                      # all layers on the GPU
        "--host", "127.0.0.1",
        "--port", str(_port),
        "-c", "4096",
        "-t", str(int(CONFIG["num_threads"])),
        "--no-webui",
    ]
    if _device:
        cmd += ["--device", _device, "-mmdev", _device]
    try:
        _log_handle = open(LOG_PATH, "wb")
    except OSError:
        _log_handle = None
    return subprocess.Popen(
        cmd, cwd=str(paths["server"].parent),
        stdout=_log_handle or subprocess.DEVNULL, stderr=subprocess.STDOUT,
        creationflags=_CREATE_NO_WINDOW,
    )


def _health(port: int, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=timeout
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _log_tail(lines: int = 12) -> str:
    try:
        text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.strip().splitlines()[-lines:])


def _stop_server() -> None:
    global _proc, _log_handle
    proc, _proc = _proc, None
    handle, _log_handle = _log_handle, None
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except (subprocess.SubprocessError, OSError):
            try:
                proc.kill()
            except OSError:
                pass
    if handle is not None:
        try:
            handle.close()
        except OSError:
            pass


atexit.register(_stop_server)


def _warmup() -> None:
    """Prime the compute graph so the first real utterance is not ~1 s slower.

    llama.cpp compiles its Vulkan pipelines on the first inference. Doing it
    here keeps that cost inside the "模型加载中" phase instead of the user's
    first sentence.
    """
    try:
        _decode(_numpy().zeros(int(CONFIG["sample_rate"]) // 2, dtype="float32"), "")
    except Exception:
        pass


def _load_model() -> None:
    global _proc
    started = time.time()
    try:
        _numpy()  # noqa: F841 - fail fast with a readable message
        paths = model_paths()
        missing = [str(p) for k, p in paths.items() if k != "dir" and not p.exists()]
        if missing:
            raise RuntimeError(
                "找不到 llama.cpp 运行时或模型文件：\n" + "\n".join(missing)
                + "\n请把 llama.cpp (Vulkan) 与 Qwen3-ASR GGUF 放到 " + str(paths["dir"])
            )
        _stop_server()
        proc = _spawn_server(paths)
        _proc = proc
        _bind_child_lifetime(proc)
        deadline = time.time() + 180
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"llama-server 启动失败（退出码 {proc.returncode}）：\n" + _log_tail()
                )
            if _health(_port):
                _warmup()
                with _state_lock:
                    _state.update(status="ready", error="", loaded_at=time.time(),
                                  load_seconds=round(time.time() - started, 2))
                print(
                    f"[asr] llama.cpp 就绪（{_state['load_seconds']}s，端口 {_port}，"
                    f"设备 {_device or 'auto'}）：{paths['model'].name}", flush=True,
                )
                return
            time.sleep(0.25)
        raise RuntimeError("llama-server 180 秒内没有就绪：\n" + _log_tail())
    except Exception as exc:
        _stop_server()
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


def _to_wav(audio, sample_rate: int) -> bytes:
    np = _numpy()
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _clean(text: str) -> str:
    """Drop the "language X<asr_text>" wrapper the model emits."""
    if not text:
        return ""
    if "<asr_text>" in text:
        text = text.split("<asr_text>", 1)[1]
    text = text.replace("</asr_text>", "")
    text = re.sub(r"^\s*language\s+\S+\s*", "", text, flags=re.IGNORECASE)
    return text.strip()


# A live microphone always carries some noise floor; a dead or muted device
# hands back exact zeros. Feeding those to the model makes it hallucinate
# short filler words ("嗯。"), which then land in the chatbox.
SILENCE_PEAK = 5e-4  # about -66 dBFS
NOISE_RMS = 0.006    # per-frame gate, about -44 dBFS
MIN_SPEECH_MS = 150  # a real word is longer than this; noise bursts are not
QUIET_PEAK = 0.06    # below this the clip is too soft to be intentional speech

# Qwen3-ASR answers a silent or noisy clip with one of these. They are only
# dropped when the audio is also quiet, so a deliberately spoken "嗯" survives.
FILLER_ONLY = {"嗯", "嗯嗯", "啊", "啊啊", "呃", "哦", "噢", "唔", "唉", "哎"}


def _activity(audio, rate: int) -> tuple[float, float]:
    """Return (milliseconds of frames above the noise floor, peak amplitude)."""
    np = _numpy()
    if len(audio) == 0:
        return 0.0, 0.0
    peak = float(np.max(np.abs(audio)))
    hop = max(1, int(rate * 0.02))  # 20 ms frames
    count = len(audio) // hop
    if count == 0:
        return 0.0, peak
    frames = audio[: count * hop].reshape(count, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    return float(np.count_nonzero(rms > NOISE_RMS)) * 20.0, peak


def _decode(audio, language: str) -> str:
    if _proc is None or _proc.poll() is not None or len(audio) == 0:
        return ""
    prompt = PROMPT_HINT.format(language=language) if language else PROMPT_PLAIN
    payload = {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "input_audio", "input_audio": {
                "data": base64.b64encode(
                    _to_wav(audio, int(CONFIG["sample_rate"]))
                ).decode("ascii"),
                "format": "wav",
            }},
        ]}],
        "temperature": 0,
        "max_tokens": 256,
        "cache_prompt": False,   # every utterance is unique; skip the lookup
    }
    req = urllib.request.Request(
        f"http://127.0.0.1:{_port}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    choices = data.get("choices") or []
    if not choices:
        return ""
    return _clean(choices[0].get("message", {}).get("content") or "")


@asr_api.get("/api/asr/status")
def asr_status():
    if request.args.get("load") == "1":
        start_loading()
    paths = model_paths()
    with _state_lock:
        snapshot = dict(_state)
    return jsonify({
        "status": snapshot["status"],
        "error": snapshot["error"],
        "load_seconds": snapshot["load_seconds"],
        "model_dir": str(paths["dir"]),
        "model_ready": snapshot["status"] == "ready",
        "backend": "llama.cpp / Vulkan",
        "device": _device or "auto",
        "port": _port,
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
    if _proc is None or _proc.poll() is not None:
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

    rate = int(CONFIG["sample_rate"])
    speech_ms, peak = _activity(current, rate)
    if peak < SILENCE_PEAK or speech_ms < MIN_SPEECH_MS:
        # Nothing worth transcribing: silence, a dead mic, or a noise blip.
        return jsonify({"text": "", "final": final, "utterance_id": current_id})

    try:
        with _model_lock:  # one decode at a time
            text = _decode(current, language)
    except Exception as exc:
        return jsonify({"error": f"识别失败：{type(exc).__name__}: {exc}"}), 500

    if text and peak < QUIET_PEAK and text.strip("。，、！？.!?… 　") in FILLER_ONLY:
        # Noise-level clip that the model answered with a lone filler word.
        text = ""

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
