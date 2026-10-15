#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from load_forecasting.mock import create_mock_processing_bundle
from load_forecasting_cli import default_artifact_root


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a deterministic development-only ProcessingBundle")
    parser.add_argument("--mode", choices=["backtest", "future"], default="backtest")
    parser.add_argument("--forecast-start", default="2025-10-01T00:00:00")
    parser.add_argument("--artifact-root", type=Path, default=default_artifact_root())
    args = parser.parse_args()
    result = create_mock_processing_bundle(args.artifact_root.resolve(), args.mode, args.forecast_start)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
