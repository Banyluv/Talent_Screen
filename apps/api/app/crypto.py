"""Application-level encryption (AES-256-GCM) for personal data at rest.

Covers CV files, extracted CV text, candidate email and phone.

Format for strings:  v1:<iv b64>:<tag b64>:<ciphertext b64>
Format for buffers:  [1 byte version][12 iv][16 tag][ciphertext]
"""
from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config

_KEY = base64.b64decode(config.data_key)
if len(_KEY) != 32:
    raise RuntimeError(
        "DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)"
    )


def encrypt(text: str | None) -> str | None:
    if text is None or text == "":
        return None
    iv = secrets.token_bytes(12)
    ct = AESGCM(_KEY).encrypt(iv, text.encode("utf-8"), None)
    # AESGCM returns ciphertext||tag; the stored format keeps the tag separate.
    body, tag = ct[:-16], ct[-16:]
    return f"v1:{base64.b64encode(iv).decode()}:{base64.b64encode(tag).decode()}:{base64.b64encode(body).decode()}"


def decrypt(blob: str | None) -> str:
    if not blob:
        return ""
    parts = blob.split(":")
    if len(parts) != 4 or parts[0] != "v1":
        raise ValueError("Unknown ciphertext version")
    _, iv, tag, body = parts
    ct = base64.b64decode(body) + base64.b64decode(tag)
    return AESGCM(_KEY).decrypt(base64.b64decode(iv), ct, None).decode("utf-8")


def encrypt_buffer(buf: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    ct = AESGCM(_KEY).encrypt(iv, buf, None)
    body, tag = ct[:-16], ct[-16:]
    return bytes([1]) + iv + tag + body


def decrypt_buffer(buf: bytes) -> bytes:
    if not buf or buf[0] != 1:
        raise ValueError("Unknown file ciphertext version")
    iv = buf[1:13]
    tag = buf[13:29]
    return AESGCM(_KEY).decrypt(iv, buf[29:] + tag, None)


def sha256(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def token(nbytes: int = 48) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode().rstrip("=")
