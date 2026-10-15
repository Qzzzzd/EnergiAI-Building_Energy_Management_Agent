"""Versioned, machine-checkable relative path contracts for V0.7 bundles."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath


@dataclass(frozen=True, slots=True)
class BundleLayout:
    """A bundle's required files and directories, expressed as relative paths."""

    name: str
    version: str
    required_files: tuple[str, ...]
    required_directories: tuple[str, ...]

    def __post_init__(self) -> None:
        paths = self.required_files + self.required_directories
        if len(paths) != len(set(paths)):
            raise ValueError(f"{self.name} contains duplicate required paths")
        for path_text in paths:
            path = PurePosixPath(path_text)
            if (
                not path_text
                or path_text == "."
                or path.is_absolute()
                or ".." in path.parts
            ):
                raise ValueError(
                    f"{self.name} contains a non-relative path: {path_text!r}"
                )

    @property
    def required_paths(self) -> tuple[str, ...]:
        """Return all required relative paths in contract order."""

        return self.required_files + self.required_directories

    def missing_paths(self, root: str | Path) -> tuple[str, ...]:
        """Return required paths absent below a concrete bundle root."""

        bundle_root = Path(root)
        return tuple(
            relative_path
            for relative_path in self.required_paths
            if not (bundle_root / relative_path).exists()
        )

    def validate(self, root: str | Path) -> None:
        """Raise when a concrete bundle does not satisfy this layout."""

        missing = self.missing_paths(root)
        if missing:
            raise ValueError(f"{self.name} is missing required paths: {missing!r}")



DATASET_BUNDLE_V07 = BundleLayout(
    name="DatasetBundle",
    version="0.7",
    required_files=(
        "manifest.json",
        "points.parquet",
        "parse_report.json",
    ),
    required_directories=(
        "data/timeseries",
        "data/tables",
    ),
)


PROCESSING_COMMON_REQUIRED_FILES_V07 = (
    "manifest.json",
    "feature_catalog.parquet",
    "categorical_mappings.json",
    "target_metadata.json",
    "split_manifest.json",
    "processing_report.json",
)


PROCESSING_BACKTEST_BUNDLE_V07 = BundleLayout(
    name="ProcessingBundle[backtest]",
    version="0.7",
    required_files=PROCESSING_COMMON_REQUIRED_FILES_V07
    + (
        "features/split=train/data.parquet",
        "features/split=validation/data.parquet",
        "features/split=test/data.parquet",
        "labels/split=train/data.parquet",
        "labels/split=validation/data.parquet",
        "labels/split=test/data.parquet",
        "forecast_index/split=train/data.parquet",
        "forecast_index/split=validation/data.parquet",
        "forecast_index/split=test/data.parquet",
    ),
    required_directories=(
        "data/processed_timeseries",
        "features/split=train",
        "features/split=validation",
        "features/split=test",
        "labels/split=train",
        "labels/split=validation",
        "labels/split=test",
        "forecast_index/split=train",
        "forecast_index/split=validation",
        "forecast_index/split=test",
    ),
)


# Complete future-mode contract. It deliberately omits labels and historical
# train/validation/test partitions.
PROCESSING_FUTURE_BUNDLE_V07 = BundleLayout(
    name="ProcessingBundle[future]",
    version="0.7",
    required_files=PROCESSING_COMMON_REQUIRED_FILES_V07
    + (
        "features/split=future/data.parquet",
        "forecast_index/split=future/data.parquet",
    ),
    required_directories=(
        "data/processed_timeseries",
        "features/split=future",
        "forecast_index/split=future",
    ),
)


# Compatibility alias: the former unqualified layout always described
# backtest mode. New code must select an explicit mode-specific layout.
PROCESSING_BUNDLE_V07 = PROCESSING_BACKTEST_BUNDLE_V07


# Deprecated compatibility constant. This is only the pair of future
# partition files, not a complete future Bundle contract.
PROCESSING_FUTURE_REQUIRED_FILES_V07 = (
    "features/split=future/data.parquet",
    "forecast_index/split=future/data.parquet",
)
