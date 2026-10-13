"""Object storage for CV files.

Files are encrypted by the application before they leave the process, whatever
the backend:
  local — a mounted volume (single-host Docker)
  s3    — MinIO in Docker Compose, or Amazon S3
  azure — Azure Blob Storage
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from . import config, crypto

log = logging.getLogger("storage")


class Storage:
    def __init__(self) -> None:
        self.driver = config.storage_driver
        self._s3 = None
        self._azure = None

    async def init(self) -> None:
        if self.driver == "s3":
            self._s3 = await asyncio.to_thread(self._make_s3)
        elif self.driver == "azure":
            self._azure = await asyncio.to_thread(self._make_azure)
        else:
            Path(config.storage_local_dir).mkdir(parents=True, exist_ok=True)
        log.info("Storage driver: %s", self.driver)

    # ---------------------------------------------------------------- drivers
    def _make_s3(self):
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=config.s3_endpoint or None,
            region_name=config.s3_region,
            aws_access_key_id=config.s3_access_key_id or None,
            aws_secret_access_key=config.s3_secret_access_key or None,
            config=Config(s3={"addressing_style": "path" if config.s3_force_path_style else "auto"}),
        )
        try:
            client.head_bucket(Bucket=config.s3_bucket)
        except Exception:
            client.create_bucket(Bucket=config.s3_bucket)
            log.info("Created bucket %s", config.s3_bucket)
        return client

    def _make_azure(self):
        from azure.storage.blob import BlobServiceClient

        svc = BlobServiceClient.from_connection_string(config.azure_connection_string)
        container = svc.get_container_client(config.azure_container)
        try:
            container.create_container()
        except Exception:
            pass
        return container

    def _local(self, key: str) -> Path:
        safe = key.replace("..", "").lstrip("/")
        return Path(config.storage_local_dir) / safe

    # ------------------------------------------------------------------ api
    async def put(self, key: str, data: bytes) -> None:
        enc = crypto.encrypt_buffer(data)
        if self._s3 is not None:
            await asyncio.to_thread(
                self._s3.put_object, Bucket=config.s3_bucket, Key=key, Body=enc,
                ContentType="application/octet-stream",
            )
        elif self._azure is not None:
            await asyncio.to_thread(self._azure.get_blob_client(key).upload_blob, enc, True)
        else:
            await asyncio.to_thread(self._local_write, key, enc)

    def _local_write(self, key: str, enc: bytes) -> None:
        p = self._local(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(enc)

    async def get(self, key: str) -> bytes:
        if self._s3 is not None:
            def _get() -> bytes:
                r = self._s3.get_object(Bucket=config.s3_bucket, Key=key)
                return r["Body"].read()

            enc = await asyncio.to_thread(_get)
        elif self._azure is not None:
            enc = await asyncio.to_thread(self._azure.get_blob_client(key).download_blob().readall)
        else:
            enc = await asyncio.to_thread(self._local(key).read_bytes)
        return crypto.decrypt_buffer(enc)

    async def remove(self, key: str) -> None:
        if self._s3 is not None:
            await asyncio.to_thread(self._s3.delete_object, Bucket=config.s3_bucket, Key=key)
        elif self._azure is not None:
            try:
                await asyncio.to_thread(self._azure.delete_blob, key)
            except Exception:
                pass
        else:
            await asyncio.to_thread(self._local(key).unlink, True)

    async def close(self) -> None:
        return None


_instance: Storage | None = None


async def get() -> Storage:
    global _instance
    if _instance is None:
        _instance = Storage()
        await _instance.init()
    return _instance


def reset() -> None:
    global _instance
    _instance = None
