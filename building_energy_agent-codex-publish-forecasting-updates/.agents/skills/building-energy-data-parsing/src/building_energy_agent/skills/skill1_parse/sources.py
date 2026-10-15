"""Local source registration without exposing filesystem paths to contracts."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    """Return a streaming SHA-256 digest for one local file."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class RegisteredSource:
    """Resolved local source metadata held outside the public request model."""

    source_ref: str
    path: Path
    sha256: str
    size_bytes: int
    original_filename: str


class LocalSourceRegistry:
    """In-process mapping from stable content references to local files."""

    def __init__(self) -> None:
        self._sources: dict[str, RegisteredSource] = {}

    def register(self, source_path: str | Path) -> RegisteredSource:
        path = Path(source_path).expanduser().resolve(strict=True)
        if not path.is_file():
            raise ValueError(f"source is not a regular file: {path.name}")
        digest = sha256_file(path)
        source_ref = f"local-sha256:{digest}"
        registered = RegisteredSource(
            source_ref=source_ref,
            path=path,
            sha256=digest,
            size_bytes=path.stat().st_size,
            original_filename=path.name,
        )
        self._sources[source_ref] = registered
        return registered

    def resolve(self, source_ref: str) -> RegisteredSource:
        try:
            return self._sources[source_ref]
        except KeyError as exc:
            raise KeyError(f"unregistered source_ref: {source_ref}") from exc
