"""Tiny disk cache with atomic writes and per-key locks."""
import hashlib
import json
import os
import threading
from contextlib import contextmanager

import numpy as np

from .config import CACHE_DIR

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def key_hash(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:24]


def path(kind: str, key: str, ext: str):
    d = CACHE_DIR / kind
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{key}.{ext}"


@contextmanager
def key_lock(name: str):
    """Serialise identical work (two requests for the same frame wait for one fetch)."""
    with _locks_guard:
        lock = _locks.setdefault(name, threading.Lock())
    with lock:
        yield


def _atomic(p, writer):
    tmp = p.with_name(p.name + f".tmp{os.getpid()}_{threading.get_ident()}")
    with open(tmp, "wb") as f:
        writer(f)
    os.replace(tmp, p)


def read_json(kind, key):
    p = path(kind, key, "json")
    try:
        with open(p) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_json(kind, key, obj):
    _atomic(path(kind, key, "json"), lambda f: f.write(json.dumps(obj).encode()))


def read_npy(kind, key):
    p = path(kind, key, "npy")
    try:
        return np.load(p)
    except (FileNotFoundError, ValueError, OSError, EOFError):
        return None


def write_npy(kind, key, arr):
    _atomic(path(kind, key, "npy"), lambda f: np.save(f, arr))


def read_npz(kind, key):
    p = path(kind, key, "npz")
    try:
        with np.load(p) as z:
            return {k: z[k] for k in z.files}
    except (FileNotFoundError, ValueError, OSError, EOFError):
        return None


def write_npz(kind, key, **arrays):
    _atomic(path(kind, key, "npz"), lambda f: np.savez_compressed(f, **arrays))
