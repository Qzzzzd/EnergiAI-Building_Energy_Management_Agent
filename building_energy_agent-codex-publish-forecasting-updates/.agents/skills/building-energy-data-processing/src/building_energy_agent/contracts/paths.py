"""Safe opaque bundle identifiers and bundle-relative paths."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Annotated

from pydantic import AfterValidator, StringConstraints


OPAQUE_BUNDLE_ID_PATTERN = r"^[A-Za-z0-9._-]+$"


def validate_opaque_bundle_id(value: str) -> str:
    """Return one safe opaque bundle path segment."""

    if (
        not isinstance(value, str)
        or re.fullmatch(OPAQUE_BUNDLE_ID_PATTERN, value) is None
        or value in {".", ".."}
    ):
        raise ValueError("bundle ID must be one safe opaque path segment")
    return value


OpaqueBundleId = Annotated[
    str,
    StringConstraints(min_length=1, pattern=OPAQUE_BUNDLE_ID_PATTERN),
    AfterValidator(validate_opaque_bundle_id),
]


def validate_bundle_relative_path(value: str) -> str:
    """Return a canonical POSIX path that remains below its bundle root."""

    if not value or "\\" in value:
        raise ValueError("bundle-relative path must be non-empty POSIX syntax")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or value == "."
        or any(part in {".", ".."} for part in path.parts)
        or path.as_posix() != value
    ):
        raise ValueError(
            "bundle-relative path must be canonical and stay below the bundle root"
        )
    return value
