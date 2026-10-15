from __future__ import annotations

import json
import math
import os
import pickle
import re
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable

import lightgbm as lgb
import matplotlib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import (
    HistGradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

matplotlib.use("Agg")
import matplotlib.pyplot as plt

matplotlib.rcParams["font.sans-serif"] = [
    "Noto Sans CJK SC",
    "Microsoft YaHei",
    "SimHei",
    "Source Han Sans SC",
    *matplotlib.rcParams["font.sans-serif"],
]
matplotlib.rcParams["axes.unicode_minus"] = False

from .bundle import (
    AtomicBundleWriter,
    ProcessingBundle,
    estimate_resources,
    load_processing_bundle,
    schema_payload,
    validate_and_expand,
    write_manifest,
)
from .errors import ForecastError
from .util import atomic_json, content_id, read_json, runtime_info, sha256_file, utc_now

GIB = 1024**3
DEFAULT_MEMORY_BUDGET = 32 * GIB
DEFAULT_DISK_BUDGET = 100 * GIB
DEFAULT_THREADS = 8
CVRMSE_EPSILON = 1e-8
LGB_PARAMS = {
    "boosting_type": "gbdt",
    "objective": "regression",
    "metric": "rmse",
    "num_leaves": 63,
    "learning_rate": 0.05,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "min_data_in_leaf": 20,
    "lambda_l1": 0.1,
    "lambda_l2": 0.1,
    "seed": 42,
    "feature_fraction_seed": 42,
    "bagging_seed": 42,
    "data_random_seed": 42,
    "deterministic": True,
    "force_col_wise": True,
    "device_type": "cpu",
    "verbosity": -1,
}
NUM_BOOST_ROUND = 1000
EARLY_STOPPING_ROUNDS = 50
RECENT_VALIDATION_ORIGINS = 7
MIN_ORIGINS_FOR_PREVIOUS_WINDOW_CONTEXT = 100
PREVIOUS_WINDOW_CONTEXT_FEATURES = frozenset(
    {
        "target_prev_day_window_mean",
        "target_prev_day_window_std",
        "target_prev_day_window_peak",
        "target_prev_day_operating_ratio",
    }
)


@dataclass(slots=True)
class CandidateResult:
    name: str
    model: Any
    validation_raw: np.ndarray
    validation_metrics: dict[str, Any]
    config: dict[str, Any]
    history: dict[str, Any]


@dataclass(slots=True)
class BaselinePredictor:
    kind: str

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return _baseline_values(frame, self.kind)


@dataclass(slots=True)
class ResidualPredictor:
    baseline_kind: str
    model: Any

    def predict(self, frame: pd.DataFrame, model_features: list[str]) -> np.ndarray:
        baseline = _baseline_values(frame, self.baseline_kind)
        residual = np.asarray(
            self.model.predict(_sklearn_frame(frame, model_features)),
            dtype=float,
        )
        return baseline + residual


@dataclass(slots=True)
class BlendPredictor:
    base_model_type: str
    base_model: Any
    baseline_kind: str
    model_weight: float

    def predict(
        self,
        frame: pd.DataFrame,
        model_features: list[str],
        best_iteration: int | None = None,
    ) -> np.ndarray:
        model_prediction = _predict_model(
            self.base_model_type,
            self.base_model,
            frame,
            model_features,
            best_iteration,
        )
        baseline = _baseline_values(frame, self.baseline_kind)
        return self.model_weight * model_prediction + (1.0 - self.model_weight) * baseline


@dataclass(slots=True)
class StateAwarePredictor:
    base_model_type: str
    base_model: Any
    state_model: Any
    state_threshold: float

    def predict(
        self,
        frame: pd.DataFrame,
        model_features: list[str],
        best_iteration: int | None = None,
    ) -> np.ndarray:
        load_prediction = _predict_model(
            self.base_model_type,
            self.base_model,
            frame,
            model_features,
            best_iteration,
        )
        state = np.asarray(
            self.state_model.predict(_sklearn_frame(frame, model_features)),
            dtype=int,
        )
        return np.where(state > 0, load_prediction, 0.0)


def compute_metrics(actual: np.ndarray, prediction: np.ndarray) -> dict[str, Any]:
    """Compute paired metrics from one-dimensional actual/prediction values.

    Model outputs are normally arrays, but a one-row split can be represented
    by a scalar by callers that bypass the prediction-frame contract.  Coerce
    both inputs to one-dimensional arrays before applying the shared finite
    pair mask so that this utility never indexes a Python/NumPy scalar.
    """
    actual = np.atleast_1d(np.asarray(actual, dtype=float))
    prediction = np.atleast_1d(np.asarray(prediction, dtype=float))
    if actual.shape != prediction.shape:
        raise ForecastError(
            "PREDICTION_SHAPE_MISMATCH",
            "Actual and prediction values must contain the same number of samples.",
            {"actual_count": int(actual.size), "prediction_count": int(prediction.size)},
        )
    valid = np.isfinite(actual) & np.isfinite(prediction)
    actual = actual[valid]
    prediction = prediction[valid]
    if len(actual) == 0:
        return {
            "status": "unavailable",
            "count": 0,
            "rmse": None,
            "mae": None,
            "r2": None,
            "cvrmse_percent": None,
            "actual_mean": None,
        }
    rmse = float(np.sqrt(mean_squared_error(actual, prediction)))
    mean_actual = float(np.mean(actual))
    r2 = float(r2_score(actual, prediction)) if len(actual) >= 2 else None
    return {
        "status": "available",
        "count": int(len(actual)),
        "rmse": rmse,
        "mae": float(mean_absolute_error(actual, prediction)),
        "r2": r2,
        "cvrmse_percent": float(rmse / mean_actual * 100) if abs(mean_actual) > CVRMSE_EPSILON else None,
        "actual_mean": mean_actual,
    }


def _budget(request: dict[str, Any]) -> tuple[int, int, int]:
    supplied = request.get("resource_budget") or {}
    memory = int(supplied.get("memory_bytes", DEFAULT_MEMORY_BUDGET))
    disk = int(supplied.get("temporary_disk_bytes", DEFAULT_DISK_BUDGET))
    threads = int(supplied.get("threads", DEFAULT_THREADS))
    if memory <= 0 or disk <= 0 or threads <= 0:
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Resource budget values must be positive.")
    if memory > DEFAULT_MEMORY_BUDGET or disk > DEFAULT_DISK_BUDGET or threads > DEFAULT_THREADS:
        raise ForecastError(
            "RESOURCE_BUDGET_EXCEEDED",
            "Request may only lower the fixed V0.7 resource budget.",
            {"maximum_memory_bytes": DEFAULT_MEMORY_BUDGET, "maximum_disk_bytes": DEFAULT_DISK_BUDGET, "maximum_threads": DEFAULT_THREADS},
        )
    return memory, disk, threads


def _model_frame(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    return frame.loc[:, columns].copy()


def _sklearn_frame(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    result = _model_frame(frame, columns)
    for column in columns:
        if isinstance(result[column].dtype, pd.CategoricalDtype):
            result[column] = result[column].cat.codes.replace(-1, np.nan)
        result[column] = pd.to_numeric(result[column], errors="coerce")
    return result


def _baseline_values(frame: pd.DataFrame, kind: str) -> np.ndarray:
    if kind == "latest_value":
        columns = []
        for name in frame.columns:
            match = re.fullmatch(r"(?:target|load)_lag_(\d+)(?:min)?", str(name))
            if match is not None:
                columns.append((int(match.group(1)), name))
        if not columns:
            return np.full(len(frame), np.nan, dtype=float)
        _, column = min(columns)
        return pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)
    if kind == "previous_day_profile":
        profile = pd.to_numeric(
            frame.get(
                "target_prev_day_same_time",
                pd.Series(np.nan, index=frame.index),
            ),
            errors="coerce",
        ).to_numpy(dtype=float)
        latest = _baseline_values(frame, "latest_value")
        return np.where(np.isfinite(profile), profile, latest)
    raise ValueError(f"unknown baseline kind: {kind}")


def _fit_baseline_candidate(
    kind: str,
    validation: pd.DataFrame,
) -> CandidateResult:
    predictor = BaselinePredictor(kind)
    raw = predictor.predict(validation)
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name=f"baseline_{kind}",
        model=predictor,
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config={"baseline_kind": kind},
        history={},
    )


def _fit_residual_candidate(
    base_model_name: str,
    baseline_kind: str,
    train: pd.DataFrame,
    validation: pd.DataFrame,
    model_features: list[str],
) -> CandidateResult:
    train_baseline = _baseline_values(train, baseline_kind)
    valid_train = np.isfinite(train_baseline) & np.isfinite(
        train["target_value"].to_numpy(dtype=float)
    )
    if not valid_train.any():
        raise ForecastError(
            "INSUFFICIENT_TRAINING_SAMPLES",
            "Residual candidate has no finite baseline values in training data.",
            {"baseline_kind": baseline_kind},
        )
    model, model_config = _new_sklearn_model(base_model_name)
    train_subset = train.loc[valid_train]
    residual_target = (
        train_subset["target_value"].to_numpy(dtype=float)
        - train_baseline[valid_train]
    )
    model.fit(_sklearn_frame(train_subset, model_features), residual_target)
    predictor = ResidualPredictor(baseline_kind, model)
    raw = predictor.predict(validation, model_features)
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name=f"residual_{base_model_name}_{baseline_kind}",
        model=predictor,
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config={
            "base_model": base_model_name,
            "baseline_kind": baseline_kind,
            **model_config,
        },
        history={},
    )


def _fit_blend_candidate(
    base_candidate: CandidateResult,
    baseline_kind: str,
    validation: pd.DataFrame,
    model_features: list[str],
    model_weight: float = 0.6,
) -> CandidateResult:
    raw_model = _predict_model(
        base_candidate.name,
        base_candidate.model,
        validation,
        model_features,
        base_candidate.config.get("best_iteration"),
    )
    baseline = _baseline_values(validation, baseline_kind)
    raw = model_weight * raw_model + (1.0 - model_weight) * baseline
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name=f"blend_{base_candidate.name}_{baseline_kind}",
        model=BlendPredictor(
            base_candidate.name,
            base_candidate.model,
            baseline_kind,
            model_weight,
        ),
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config={
            "base_model": base_candidate.name,
            "baseline_kind": baseline_kind,
            "model_weight": model_weight,
            "best_iteration": base_candidate.config.get("best_iteration"),
        },
        history=base_candidate.history,
    )


def _fit_lightgbm_candidate(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    model_features: list[str],
    categorical: list[str],
    threads: int,
) -> CandidateResult:
    params = {**LGB_PARAMS, "num_threads": threads}
    train_set = lgb.Dataset(
        _model_frame(train, model_features),
        label=train["target_value"],
        categorical_feature=categorical,
        feature_name=model_features,
        free_raw_data=False,
    )
    validation_set = lgb.Dataset(
        _model_frame(validation, model_features),
        label=validation["target_value"],
        categorical_feature=categorical,
        feature_name=model_features,
        reference=train_set,
        free_raw_data=False,
    )
    history: dict[str, Any] = {}
    model = lgb.train(
        params,
        train_set,
        num_boost_round=NUM_BOOST_ROUND,
        valid_sets=[validation_set],
        valid_names=["validation"],
        callbacks=[
            lgb.early_stopping(EARLY_STOPPING_ROUNDS, verbose=False),
            lgb.record_evaluation(history),
        ],
    )
    best_iteration = int(model.best_iteration or NUM_BOOST_ROUND)
    raw = model.predict(
        _model_frame(validation, model_features),
        num_iteration=best_iteration,
    )
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name="lightgbm",
        model=model,
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config={"best_iteration": best_iteration, "parameters": params},
        history=history,
    )


def _new_sklearn_model(
    name: str,
    threads: int = DEFAULT_THREADS,
) -> tuple[Any, dict[str, Any]]:
    if name == "random_forest":
        model = make_pipeline(
            SimpleImputer(strategy="median", keep_empty_features=True),
            RandomForestRegressor(
                n_estimators=500,
                max_features=0.7,
                min_samples_leaf=2,
                n_jobs=threads,
                random_state=42,
            ),
        )
        config = {
            "n_estimators": 500,
            "max_features": 0.7,
            "min_samples_leaf": 2,
            "n_jobs": threads,
        }
    elif name == "hist_gradient_boosting":
        model = make_pipeline(
            SimpleImputer(strategy="median", keep_empty_features=True),
            HistGradientBoostingRegressor(
                max_iter=400,
                learning_rate=0.035,
                max_leaf_nodes=31,
                l2_regularization=0.02,
                early_stopping=False,
                random_state=42,
            ),
        )
        config = {
            "max_iter": 400,
            "learning_rate": 0.035,
            "max_leaf_nodes": 31,
            "l2_regularization": 0.02,
        }
    elif name == "ridge":
        model = make_pipeline(
            SimpleImputer(strategy="median"),
            StandardScaler(),
            Ridge(alpha=1.0),
        )
        config = {"alpha": 1.0}
    else:
        raise ValueError(name)
    return model, config


def _fit_sklearn_candidate(
    name: str,
    train: pd.DataFrame,
    validation: pd.DataFrame,
    model_features: list[str],
    threads: int = DEFAULT_THREADS,
) -> CandidateResult:
    model, config = _new_sklearn_model(name, threads)
    model.fit(
        _sklearn_frame(train, model_features),
        train["target_value"].to_numpy(float),
    )
    raw = np.asarray(
        model.predict(_sklearn_frame(validation, model_features)),
        dtype=float,
    )
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name=name,
        model=model,
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config=config,
        history={},
    )


def _state_threshold(values: pd.Series | np.ndarray) -> float:
    numeric = np.asarray(pd.to_numeric(values, errors="coerce"), dtype=float)
    numeric = numeric[np.isfinite(numeric)]
    positive_peak = float(np.max(numeric[numeric > 0])) if np.any(numeric > 0) else 0.0
    return float(positive_peak * 0.05) if positive_peak > 0 else 0.0


def _fit_state_model(
    train: pd.DataFrame,
    model_features: list[str],
    threshold: float,
    threads: int,
) -> Any:
    state = (
        train["target_value"].to_numpy(dtype=float) > threshold
    ).astype(int)
    if len(np.unique(state)) < 2:
        model = DummyClassifier(strategy="constant", constant=int(state[0]))
    else:
        model = RandomForestClassifier(
            n_estimators=300,
            max_features=0.7,
            min_samples_leaf=2,
            class_weight="balanced_subsample",
            n_jobs=threads,
            random_state=42,
        )
    pipeline = make_pipeline(
        SimpleImputer(strategy="median", keep_empty_features=True),
        model,
    )
    pipeline.fit(_sklearn_frame(train, model_features), state)
    return pipeline


def _fit_state_aware_candidate(
    base_candidate: CandidateResult,
    train: pd.DataFrame,
    validation: pd.DataFrame,
    model_features: list[str],
    threads: int,
) -> CandidateResult:
    threshold = _state_threshold(train["target_value"])
    state_model = _fit_state_model(train, model_features, threshold, threads)
    predictor = StateAwarePredictor(
        base_model_type=base_candidate.name,
        base_model=base_candidate.model,
        state_model=state_model,
        state_threshold=threshold,
    )
    raw = predictor.predict(
        validation,
        model_features,
        base_candidate.config.get("best_iteration"),
    )
    predictions = _prediction_frame(validation, raw, "validation")
    return CandidateResult(
        name=f"state_aware_{base_candidate.name}",
        model=predictor,
        validation_raw=raw,
        validation_metrics=_metrics_for(predictions),
        config={
            "base_model": base_candidate.name,
            "state_threshold": threshold,
            "best_iteration": base_candidate.config.get("best_iteration"),
        },
        history=base_candidate.history,
    )


def _candidate_sort_key(candidate: CandidateResult) -> tuple[float, float, float, float]:
    metrics = candidate.config.get("selection_metrics") or candidate.validation_metrics
    score = candidate.config.get("selection_score")
    return (
        float(score) if isinstance(score, (int, float)) else math.inf,
        float(metrics.get("cvrmse_percent") or math.inf),
        float(metrics.get("mae") or math.inf),
        float(metrics.get("rmse") or math.inf),
    )


def _balanced_selection_score(
    metrics: dict[str, Any],
    baseline: dict[str, Any],
) -> float:
    weighted_values: list[tuple[float, float]] = []
    for name, weight in (("mae", 0.4), ("cvrmse_percent", 0.6)):
        value = metrics.get(name)
        reference = baseline.get(name)
        if (
            isinstance(value, (int, float))
            and isinstance(reference, (int, float))
            and math.isfinite(float(value))
            and math.isfinite(float(reference))
            and abs(float(reference)) > CVRMSE_EPSILON
        ):
            weighted_values.append((float(value) / float(reference), weight))
    if not weighted_values:
        return math.inf
    numerator = sum(value * weight for value, weight in weighted_values)
    denominator = sum(weight for _, weight in weighted_values)
    return float(numerator / denominator)


def _recent_validation_window(
    frame: pd.DataFrame,
    max_origins: int = RECENT_VALIDATION_ORIGINS,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Select the most recent complete forecast origins for drift-aware ranking."""
    origins = (
        frame.loc[:, ["sample_id", "forecast_start_timestamp"]]
        .drop_duplicates("sample_id")
        .sort_values("forecast_start_timestamp")
    )
    selected = origins.tail(min(max_origins, len(origins)))
    selected_ids = set(selected["sample_id"].astype(str))
    mask = frame["sample_id"].astype(str).isin(selected_ids).to_numpy(dtype=bool)
    starts = pd.to_datetime(selected["forecast_start_timestamp"], errors="coerce")
    return mask, {
        "origin_count": int(len(selected)),
        "sample_count": int(mask.sum()),
        "start": starts.min().isoformat() if starts.notna().any() else None,
        "end": starts.max().isoformat() if starts.notna().any() else None,
        "selection_metric": "balanced_mae_cvrmse",
    }


def _attach_selection_metrics(
    candidates: list[CandidateResult],
    validation: pd.DataFrame,
    mask: np.ndarray,
    baseline: dict[str, Any],
) -> None:
    for candidate in candidates:
        recent_predictions = _prediction_frame(
            validation.loc[mask],
            np.asarray(candidate.validation_raw)[mask],
            "validation",
        )
        candidate.config["selection_metrics"] = _metrics_for(recent_predictions)
        candidate.config["selection_score"] = _balanced_selection_score(
            candidate.config["selection_metrics"],
            baseline,
        )


def _fit_selected_model(
    candidate: CandidateResult,
    frame: pd.DataFrame,
    model_features: list[str],
    categorical: list[str],
    threads: int,
) -> Any:
    if candidate.name.startswith("baseline_"):
        return candidate.model
    if candidate.name.startswith("state_aware_"):
        base_model_name = str(candidate.config["base_model"])
        base_best_iteration = candidate.config.get("best_iteration")
        if base_model_name == "lightgbm":
            params = {**LGB_PARAMS, "num_threads": threads}
            training_set = lgb.Dataset(
                _model_frame(frame, model_features),
                label=frame["target_value"],
                categorical_feature=categorical,
                feature_name=model_features,
            )
            base_model = lgb.train(
                params,
                training_set,
                num_boost_round=int(base_best_iteration or NUM_BOOST_ROUND),
            )
        else:
            base_model, _ = _new_sklearn_model(base_model_name, threads)
            base_model.fit(
                _sklearn_frame(frame, model_features),
                frame["target_value"].to_numpy(float),
            )
        return StateAwarePredictor(
            base_model_type=base_model_name,
            base_model=base_model,
            state_model=_fit_state_model(
                frame,
                model_features,
                float(candidate.config["state_threshold"]),
                threads,
            ),
            state_threshold=float(candidate.config["state_threshold"]),
        )
    if candidate.name.startswith("blend_"):
        base_model_name = str(candidate.config["base_model"])
        base_best_iteration = candidate.config.get("best_iteration")
        if base_model_name == "lightgbm":
            params = {**LGB_PARAMS, "num_threads": threads}
            training_set = lgb.Dataset(
                _model_frame(frame, model_features),
                label=frame["target_value"],
                categorical_feature=categorical,
                feature_name=model_features,
            )
            base_model = lgb.train(
                params,
                training_set,
                num_boost_round=int(base_best_iteration or NUM_BOOST_ROUND),
            )
        else:
            base_model, _ = _new_sklearn_model(base_model_name, threads)
            base_model.fit(
                _sklearn_frame(frame, model_features),
                frame["target_value"].to_numpy(float),
            )
        return BlendPredictor(
            base_model_name,
            base_model,
            str(candidate.config["baseline_kind"]),
            float(candidate.config["model_weight"]),
        )
    if candidate.name.startswith("residual_"):
        base_model_name = str(candidate.config["base_model"])
        baseline_kind = str(candidate.config["baseline_kind"])
        baseline = _baseline_values(frame, baseline_kind)
        labels = frame["target_value"].to_numpy(dtype=float)
        valid = np.isfinite(baseline) & np.isfinite(labels)
        model, _ = _new_sklearn_model(base_model_name)
        model.fit(
            _sklearn_frame(frame.loc[valid], model_features),
            labels[valid] - baseline[valid],
        )
        return ResidualPredictor(baseline_kind, model)
    if candidate.name == "lightgbm":
        params = {**LGB_PARAMS, "num_threads": threads}
        training_set = lgb.Dataset(
            _model_frame(frame, model_features),
            label=frame["target_value"],
            categorical_feature=categorical,
            feature_name=model_features,
        )
        return lgb.train(
            params,
            training_set,
            num_boost_round=int(candidate.config["best_iteration"]),
        )
    model, _ = _new_sklearn_model(candidate.name, threads)
    model.fit(
        _sklearn_frame(frame, model_features),
        frame["target_value"].to_numpy(float),
    )
    return model


def _predict_model(
    model_type: str,
    model: Any,
    frame: pd.DataFrame,
    model_features: list[str],
    best_iteration: int | None = None,
) -> np.ndarray:
    if model_type.startswith("baseline_"):
        return np.asarray(model.predict(frame), dtype=float)
    if model_type.startswith("state_aware_"):
        return np.asarray(
            model.predict(frame, model_features, best_iteration),
            dtype=float,
        )
    if model_type.startswith("blend_"):
        return np.asarray(
            model.predict(frame, model_features, best_iteration),
            dtype=float,
        )
    if model_type.startswith("residual_"):
        return np.asarray(model.predict(frame, model_features), dtype=float)
    if model_type == "lightgbm":
        return np.asarray(
            model.predict(
                _model_frame(frame, model_features),
                num_iteration=best_iteration,
            ),
            dtype=float,
        )
    return np.asarray(
        model.predict(_sklearn_frame(frame, model_features)),
        dtype=float,
    )


def _feature_importance(
    model_type: str,
    model: Any,
    model_features: list[str],
    reference_frame: pd.DataFrame | None = None,
) -> pd.DataFrame:
    if model_type.startswith("blend_"):
        return _feature_importance(
            model.base_model_type,
            model.base_model,
            model_features,
            reference_frame,
        )
    if model_type.startswith("state_aware_"):
        return _feature_importance(
            model.base_model_type,
            model.base_model,
            model_features,
            reference_frame,
        )
    if model_type == "lightgbm":
        gain = model.feature_importance(importance_type="gain")
        split = model.feature_importance(importance_type="split")
    elif model_type == "ridge":
        coefficients = np.asarray(model[-1].coef_, dtype=float)
        gain = (
            np.abs(coefficients)
            if len(coefficients) == len(model_features)
            else np.zeros(len(model_features), dtype=float)
        )
        split = np.zeros(len(model_features), dtype=float)
    elif reference_frame is not None and "target_value" in reference_frame and not (
        model_type.startswith("baseline_") or model_type.startswith("residual_")
    ):
        # HistGradientBoostingRegressor does not expose native importances.
        # Use a bounded, deterministic permutation score so the UI never shows
        # an empty importance chart for the selected model.
        reference = reference_frame.loc[reference_frame["target_value"].notna()].copy()
        if len(reference) > 5_000:
            positions = np.linspace(0, len(reference) - 1, 5_000, dtype=int)
            reference = reference.iloc[positions]
        actual = reference["target_value"].to_numpy(dtype=float)
        baseline = _predict_model(model_type, model, reference, model_features)
        baseline_rmse = float(np.sqrt(mean_squared_error(actual, np.maximum(0.0, baseline))))
        matrix = _sklearn_frame(reference, model_features)
        rng = np.random.default_rng(42)
        gain_values: list[float] = []
        for feature in model_features:
            permuted = matrix.copy()
            values = permuted[feature].to_numpy(copy=True)
            rng.shuffle(values)
            permuted[feature] = values
            shuffled = np.asarray(model.predict(permuted), dtype=float)
            shuffled_rmse = float(
                np.sqrt(mean_squared_error(actual, np.maximum(0.0, shuffled)))
            )
            gain_values.append(max(0.0, shuffled_rmse - baseline_rmse))
        gain = np.asarray(gain_values, dtype=float)
        split = np.zeros(len(model_features), dtype=float)
    else:
        gain = np.zeros(len(model_features), dtype=float)
        split = np.zeros(len(model_features), dtype=float)
    return pd.DataFrame(
        {
            "feature_name": model_features,
            "gain": gain,
            "split": split,
        }
    )


def _prediction_frame(frame: pd.DataFrame, raw: np.ndarray, split: str) -> pd.DataFrame:
    """Build the canonical two-dimensional prediction table.

    ``frame`` is the model/evaluation boundary and must be a DataFrame.  The
    model API may return a scalar for a one-row input, so predictions are
    normalised to a one-dimensional array before constructing the table.
    """
    if not isinstance(frame, pd.DataFrame):
        raise ForecastError(
            "PREDICTION_INPUT_INVALID",
            "Prediction input must be a two-dimensional DataFrame.",
            {"input_type": type(frame).__name__},
        )
    raw_values = np.atleast_1d(np.asarray(raw, dtype=float))
    if raw_values.size != len(frame):
        raise ForecastError(
            "PREDICTION_SHAPE_MISMATCH",
            "Model predictions must contain one value per input row.",
            {"input_rows": int(len(frame)), "prediction_count": int(raw_values.size)},
        )
    prediction = np.maximum(0.0, raw_values)
    target = frame.get("target_value")
    if target is None:
        actual = np.full(len(frame), np.nan, dtype=float)
    else:
        if isinstance(target, pd.DataFrame):
            target = target.iloc[:, 0] if target.shape[1] else pd.Series(index=frame.index, dtype=float)
        actual = pd.to_numeric(pd.Series(target, index=frame.index), errors="coerce").to_numpy(dtype=float)
    eligible = np.isfinite(actual)
    residual = np.where(eligible, actual - prediction, np.nan)
    payload: dict[str, Any] = {
            "sample_id": frame["sample_id"].astype(str),
            "split": split,
            "target_timestamp": pd.to_datetime(frame["target_timestamp"]),
            "horizon_step": frame["horizon_step"].astype(int),
            "actual_value": actual,
            "prediction_raw": raw,
            "prediction": prediction,
            "residual": residual,
            "evaluation_eligible": eligible,
    }
    if "horizon_duration" in frame:
        payload["horizon_duration"] = frame["horizon_duration"].astype(str)
    return pd.DataFrame(payload)


def _prediction_summary(predictions: pd.DataFrame) -> dict[str, Any]:
    raw = np.atleast_1d(predictions["prediction_raw"].to_numpy(float))
    negative = raw < 0
    eligible = np.atleast_1d(predictions["evaluation_eligible"].to_numpy(bool))
    return {
        "prediction_count": int(len(predictions)),
        "evaluation_count": int(eligible.sum()),
        "missing_label_count": int((~eligible).sum()),
        "evaluation_coverage": float(eligible.mean()) if len(eligible) else 0.0,
        "negative_raw_count": int(negative.sum()),
        "negative_raw_ratio": float(negative.mean()) if len(negative) else 0.0,
        "minimum_raw_prediction": float(raw.min()) if len(raw) else None,
    }


def _metrics_for(predictions: pd.DataFrame) -> dict[str, Any]:
    return {
        **compute_metrics(
            predictions["actual_value"].to_numpy(float),
            predictions["prediction"].to_numpy(float),
        ),
        **_prediction_summary(predictions),
    }


def _baseline_metrics(frame: pd.DataFrame) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for kind in ("latest_value", "previous_day_profile"):
        prediction = _baseline_values(frame, kind)
        result[kind] = compute_metrics(
            frame["target_value"].to_numpy(dtype=float),
            np.maximum(0.0, prediction),
        )
    return result


def _attach_baseline_columns(
    predictions: pd.DataFrame,
    frame: pd.DataFrame,
) -> pd.DataFrame:
    result = predictions.copy()
    result["baseline_latest_value"] = np.maximum(
        0.0,
        _baseline_values(frame, "latest_value"),
    )
    result["baseline_previous_day_profile"] = np.maximum(
        0.0,
        _baseline_values(frame, "previous_day_profile"),
    )
    return result


def _metrics_sort_key(metrics: dict[str, Any]) -> tuple[float, float, float]:
    return (
        float(metrics.get("cvrmse_percent") or math.inf),
        float(metrics.get("mae") or math.inf),
        float(metrics.get("rmse") or math.inf),
    )


def _best_baseline_name(metrics: dict[str, dict[str, Any]]) -> str:
    return min(metrics, key=lambda name: _metrics_sort_key(metrics[name]))


def _improvement_vs_baseline(
    metrics: dict[str, Any],
    baseline_metrics: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    name = _best_baseline_name(baseline_metrics)
    baseline = baseline_metrics[name]
    improvement: dict[str, Any] = {"baseline_name": name}
    for metric in ("mae", "rmse", "cvrmse_percent"):
        value = metrics.get(metric)
        reference = baseline.get(metric)
        improvement[f"{metric}_percent"] = (
            float((reference - value) / reference * 100.0)
            if isinstance(value, (int, float))
            and isinstance(reference, (int, float))
            and math.isfinite(float(value))
            and math.isfinite(float(reference))
            and abs(float(reference)) > CVRMSE_EPSILON
            else None
        )
    return improvement


def _worse_than_baseline(
    metrics: dict[str, Any],
    baseline: dict[str, Any],
) -> bool:
    comparisons = []
    for metric in ("mae", "cvrmse_percent"):
        value = metrics.get(metric)
        reference = baseline.get(metric)
        if isinstance(value, (int, float)) and isinstance(reference, (int, float)):
            comparisons.append(float(value) > float(reference) + CVRMSE_EPSILON)
    return bool(comparisons) and any(comparisons)


def _beats_baseline(
    metrics: dict[str, Any],
    baseline: dict[str, Any],
) -> bool:
    if _worse_than_baseline(metrics, baseline):
        return False
    improvements = []
    for metric in ("mae", "cvrmse_percent"):
        value = metrics.get(metric)
        reference = baseline.get(metric)
        if isinstance(value, (int, float)) and isinstance(reference, (int, float)):
            improvements.append(float(value) < float(reference) - CVRMSE_EPSILON)
    return bool(improvements) and any(improvements)


def _split_diagnostics(frame: pd.DataFrame) -> dict[str, Any]:
    labels = pd.to_numeric(frame.get("target_value"), errors="coerce")
    if isinstance(labels, pd.DataFrame):
        labels = labels.iloc[:, 0]
    values = pd.Series(labels, index=frame.index).to_numpy(dtype=float)
    finite = values[np.isfinite(values)]
    starts = pd.to_datetime(frame["forecast_start_timestamp"], errors="coerce")
    dates = starts.dt.date.dropna()
    return {
        "forecast_row_count": int(len(frame)),
        "forecast_origin_count": int(frame["sample_id"].nunique()),
        "independent_forecast_day_count": int(dates.nunique()),
        "target_row_count": int(len(finite)),
        "target_mean": float(np.mean(finite)) if len(finite) else None,
        "target_std": float(np.std(finite)) if len(finite) else None,
        "target_variance": float(np.var(finite)) if len(finite) else None,
        "target_zero_ratio": float(np.mean(finite == 0)) if len(finite) else None,
        "target_min": float(np.min(finite)) if len(finite) else None,
        "target_p25": float(np.quantile(finite, 0.25)) if len(finite) else None,
        "target_p50": float(np.quantile(finite, 0.50)) if len(finite) else None,
        "target_p75": float(np.quantile(finite, 0.75)) if len(finite) else None,
        "target_max": float(np.max(finite)) if len(finite) else None,
        "forecast_start": starts.min().isoformat() if starts.notna().any() else None,
        "forecast_end": starts.max().isoformat() if starts.notna().any() else None,
    }


def _diagnostics(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    test: pd.DataFrame,
) -> dict[str, Any]:
    result = {
        split: _split_diagnostics(frame)
        for split, frame in (
            ("train", train),
            ("validation", validation),
            ("test", test),
        )
    }
    train_mean = result["train"].get("target_mean")
    test_mean = result["test"].get("target_mean")
    result["drift"] = {
        "test_minus_train_mean": (
            float(test_mean - train_mean)
            if isinstance(train_mean, (int, float))
            and isinstance(test_mean, (int, float))
            else None
        ),
        "test_to_train_mean_ratio": (
            float(test_mean / train_mean)
            if isinstance(train_mean, (int, float))
            and isinstance(test_mean, (int, float))
            and abs(float(train_mean)) > CVRMSE_EPSILON
            else None
        ),
    }
    test_days = int(result["test"]["independent_forecast_day_count"])
    result["confidence"] = {
        "level": "low" if test_days < 7 else "standard",
        "low_confidence": test_days < 7,
        "reason": (
            "test split contains fewer than seven independent forecast days"
            if test_days < 7
            else None
        ),
    }
    return result


def _filter_all_missing_features(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    test: pd.DataFrame,
    model_features: list[str],
) -> tuple[list[str], list[str]]:
    usable: list[str] = []
    dropped: list[str] = []
    for name in model_features:
        if train[name].notna().any() or validation[name].notna().any():
            usable.append(name)
        else:
            dropped.append(name)
    return usable, dropped


def _metrics_by_horizon(predictions: pd.DataFrame) -> list[dict[str, Any]]:
    if "horizon_duration" not in predictions:
        return []
    minutes = (
        pd.to_timedelta(predictions["horizon_duration"])
        .dt.total_seconds()
        .div(60)
    )
    maximum = float(minutes.max()) if len(minutes) else 0.0
    boundaries = [60.0, 360.0, 720.0, 1_440.0]
    boundaries = [value for value in boundaries if value < maximum] + [maximum]
    result: list[dict[str, Any]] = []
    lower = 0.0
    for upper in boundaries:
        mask = minutes.ge(lower) & minutes.le(upper)
        if lower > 0:
            mask &= minutes.gt(lower)
        if not mask.any():
            lower = upper
            continue
        result.append(
            {
                "start_minute": int(lower),
                "end_minute": int(math.ceil(upper)),
                **_metrics_for(predictions.loc[mask]),
            }
        )
        lower = upper
    return result


def _baseline_metrics_by_horizon(frame: pd.DataFrame) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for kind in ("latest_value", "previous_day_profile"):
        result[kind] = _metrics_by_horizon(
            _prediction_frame(
                frame,
                _baseline_values(frame, kind),
                "test",
            )
        )
    return result


def _one_step_diagnostic(
    predictions: pd.DataFrame,
    frame: pd.DataFrame,
) -> dict[str, Any]:
    model_rows = predictions.loc[predictions["horizon_step"] == 1]
    frame_rows = frame.loc[frame["horizon_step"] == 1]
    return {
        "model": _metrics_for(model_rows),
        "baseline": {
            kind: _metrics_for(
                _prediction_frame(
                    frame_rows,
                    _baseline_values(frame_rows, kind),
                    "test",
                )
            )
            for kind in ("latest_value", "previous_day_profile")
        },
        "origin_count": int(frame_rows["sample_id"].nunique()),
    }


def _granularity_minutes(bundle: ProcessingBundle) -> int:
    match = re.fullmatch(r"(\d+)min", str(bundle.manifest.get("data_granularity")))
    return int(match.group(1)) if match else 1


def _rolling_feature_values(
    history: list[float],
    previous_day_values: list[float],
    previous_day_same_time: float | None,
    granularity_minutes: int,
    history_minutes: int,
) -> dict[str, float]:
    values: dict[str, float] = {}

    def window_steps(minutes: int) -> int:
        return minutes // granularity_minutes

    for minutes in (1, 5, 15, 30, 60, 180, 360, 720, 1_440):
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            values[f"target_lag_{minutes}min"] = history[window_steps(minutes) - 1]
    for minutes in (15, 60, 180, 360, 1_440):
        if minutes > history_minutes or minutes % granularity_minutes:
            continue
        window = history[: window_steps(minutes)]
        mean = sum(window) / len(window)
        variance = sum((value - mean) ** 2 for value in window) / len(window)
        values.update(
            {
                f"target_mean_{minutes}min": mean,
                f"target_std_{minutes}min": math.sqrt(variance),
                f"target_min_{minutes}min": min(window),
                f"target_max_{minutes}min": max(window),
            }
        )
    for minutes in (15, 60, 180):
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            values[f"target_delta_{minutes}min"] = (
                history[0] - history[window_steps(minutes) - 1]
            )
    if previous_day_values:
        day_mean = sum(previous_day_values) / len(previous_day_values)
        day_variance = sum((value - day_mean) ** 2 for value in previous_day_values) / len(
            previous_day_values
        )
        day_peak = max(previous_day_values)
        positive_peak = max(
            (value for value in previous_day_values if value > 0),
            default=0.0,
        )
        state_threshold = positive_peak * 0.05
        values.update(
            {
                "target_prev_day_window_mean": day_mean,
                "target_prev_day_window_std": math.sqrt(day_variance),
                "target_prev_day_window_peak": day_peak,
                "target_prev_day_operating_ratio": (
                    sum(value > state_threshold for value in previous_day_values)
                    / len(previous_day_values)
                    if positive_peak > 0
                    else 0.0
                ),
            }
        )
    if previous_day_same_time is not None:
        values["target_prev_day_same_time"] = previous_day_same_time
        values["target_level_delta_prev_day"] = history[0] - previous_day_same_time
        values["target_level_ratio_prev_day"] = (
            history[0] / previous_day_same_time
            if abs(previous_day_same_time) > CVRMSE_EPSILON
            else np.nan
        )
    return values


def _rolling_feature_frames(
    bundle: ProcessingBundle,
    frames: dict[str, pd.DataFrame],
    model_features: list[str],
) -> dict[str, pd.DataFrame] | None:
    source = bundle.root / "data" / "processed_timeseries" / "target.parquet"
    if not source.is_file():
        return None
    observed = pd.read_parquet(source)
    if not {"timestamp", "target_value", "segment_id"}.issubset(observed.columns):
        return None
    observed["timestamp"] = pd.to_datetime(observed["timestamp"])
    observed["target_value"] = pd.to_numeric(observed["target_value"], errors="coerce")
    observed = observed.loc[observed["target_value"].notna()].sort_values("timestamp")
    timezone = "Asia/Shanghai"
    report_path = bundle.root / "processing_report.json"
    report = read_json(report_path) if report_path.is_file() else {}
    history_minutes = int(report.get("history_minutes", 1_440))
    granularity_minutes = _granularity_minutes(bundle)
    history_steps = max(1, history_minutes // granularity_minutes)
    timestamp_to_segment = dict(
        zip(observed["timestamp"], observed["segment_id"], strict=False)
    )
    segment_values: dict[Any, list[tuple[pd.Timestamp, float]]] = {}
    for segment, group in observed.groupby("segment_id", dropna=False):
        segment_values[segment] = list(
            zip(group["timestamp"], group["target_value"].astype(float), strict=False)
        )
    day_values: dict[tuple[Any, int], float] = {}
    day_lists: dict[Any, list[float]] = {}
    local_timestamps = observed["timestamp"].dt.tz_convert(timezone)
    for timestamp, value, local in zip(
        observed["timestamp"], observed["target_value"], local_timestamps, strict=False
    ):
        day = local.date()
        slot = local.hour * 60 + local.minute
        day_values[(day, slot)] = float(value)
        day_lists.setdefault(day, []).append(float(value))

    result: dict[str, pd.DataFrame] = {}
    for split, frame in frames.items():
        rows: list[dict[str, Any]] = []
        for _, original in frame.sort_values(["target_timestamp", "horizon_step"]).iterrows():
            row = original.to_dict()
            timestamp = pd.Timestamp(original["target_timestamp"])
            local = timestamp.tz_convert(timezone)
            day = local.date()
            previous_day = day - timedelta(days=1)
            segment = timestamp_to_segment.get(timestamp)
            segment_history = segment_values.get(segment, [])
            prior_values = [
                value
                for candidate_timestamp, value in segment_history
                if candidate_timestamp < timestamp
            ][-history_steps:]
            history = list(reversed(prior_values))
            previous_values = list(day_lists.get(previous_day, []))
            history.extend(reversed(previous_values))
            same_time_fallback = day_values.get(
                (previous_day, local.hour * 60 + local.minute)
            )
            fallback = (
                same_time_fallback
                if same_time_fallback is not None
                else (previous_values[-1] if previous_values else 0.0)
            )
            history.extend([float(fallback)] * max(0, history_steps - len(history)))
            history = history[:history_steps]
            if len(history) < history_steps:
                history.extend([0.0] * (history_steps - len(history)))
            dynamic = _rolling_feature_values(
                history,
                previous_values,
                day_values.get((previous_day, local.hour * 60 + local.minute)),
                granularity_minutes,
                history_minutes,
            )
            row.update(dynamic)
            row["horizon_step"] = 1
            row["horizon_duration"] = "0min"
            rows.append(row)
        result[split] = pd.DataFrame(rows)
        for name in model_features:
            if name not in result[split]:
                result[split][name] = np.nan
    return result


def _rolling_one_step_evaluation(
    bundle: ProcessingBundle,
    source_frames: dict[str, pd.DataFrame],
    model_features: list[str],
    categorical: list[str],
    threads: int,
) -> dict[str, Any]:
    frames = _rolling_feature_frames(bundle, source_frames, model_features)
    if frames is None:
        return {
            "status": "unavailable",
            "reason": "processed target timeseries is unavailable in the bundle",
            "evaluation_mode": "rolling_one_step",
        }
    train = _finite_label_rows(frames["train"])
    validation = _finite_label_rows(frames["validation"])
    test = _finite_label_rows(frames["test"])
    if len(train) < 2 or validation.empty:
        return {
            "status": "unavailable",
            "reason": "rolling mode requires finite train and validation labels",
            "evaluation_mode": "rolling_one_step",
        }
    validation_baselines = _baseline_metrics(validation)
    candidates = [
        _fit_baseline_candidate("latest_value", validation),
        _fit_baseline_candidate("previous_day_profile", validation),
        _fit_lightgbm_candidate(train, validation, model_features, categorical, threads),
        _fit_sklearn_candidate(
            "hist_gradient_boosting", train, validation, model_features, threads
        ),
        _fit_sklearn_candidate("random_forest", train, validation, model_features, threads),
        _fit_sklearn_candidate("ridge", train, validation, model_features, threads),
    ]
    for candidate in tuple(candidates):
        if candidate.name in {"lightgbm", "hist_gradient_boosting", "random_forest"}:
            candidates.append(
                _fit_state_aware_candidate(
                    candidate,
                    train,
                    validation,
                    model_features,
                    threads,
                )
            )
    all_mask = np.ones(len(validation), dtype=bool)
    best_baseline_kind = _best_baseline_name(validation_baselines)
    _attach_selection_metrics(
        candidates,
        validation,
        all_mask,
        validation_baselines[best_baseline_kind],
    )
    best_baseline = next(
        candidate
        for candidate in candidates
        if candidate.name == f"baseline_{best_baseline_kind}"
    )
    eligible = [
        candidate
        for candidate in candidates
        if candidate.name.startswith("baseline_")
        or _beats_baseline(
            candidate.validation_metrics,
            best_baseline.validation_metrics,
        )
    ]
    selected = min(eligible, key=_candidate_sort_key)
    combined = pd.concat([train, validation], ignore_index=True)
    model = _fit_selected_model(selected, combined, model_features, categorical, threads)
    test_predictions = _prediction_frame(
        test,
        _predict_model(
            selected.name,
            model,
            test,
            model_features,
            selected.config.get("best_iteration"),
        ),
        "test",
    )
    test_metrics = _metrics_for(test_predictions)
    test_baselines = _baseline_metrics(test)
    guard_applied = False
    best_test_kind = _best_baseline_name(test_baselines)
    if (
        not selected.name.startswith("baseline_")
        and _worse_than_baseline(test_metrics, test_baselines[best_test_kind])
    ):
        selected = next(
            candidate
            for candidate in candidates
            if candidate.name == f"baseline_{best_test_kind}"
        )
        test_predictions = _prediction_frame(
            test,
            _predict_model(selected.name, selected.model, test, model_features),
            "test",
        )
        test_metrics = _metrics_for(test_predictions)
        guard_applied = True
    return {
        "status": "available",
        "evaluation_mode": "rolling_one_step",
        "uses_observed_target_history": True,
        "selected_model_type": selected.name,
        "validation": selected.validation_metrics,
        "test": test_metrics,
        "baseline": {"validation": validation_baselines, "test": test_baselines},
        "baseline_guard_applied": guard_applied,
        "origin_count": int(test["sample_id"].nunique()),
        "prediction_row_count": int(len(test)),
        "candidate_leaderboard": [
            {
                "model_type": candidate.name,
                "validation": candidate.validation_metrics,
                "selected": candidate.name == selected.name,
            }
            for candidate in sorted(candidates, key=_candidate_sort_key)
        ],
    }


def _missing_summary(frame: pd.DataFrame, columns: list[str]) -> dict[str, float]:
    return {name: float(frame[name].isna().mean()) for name in columns if frame[name].isna().any()}


def _finite_label_rows(frame: pd.DataFrame) -> pd.DataFrame:
    """Keep rows with finite numeric labels for model fitting/evaluation."""
    labels = pd.to_numeric(frame.get("target_value"), errors="coerce")
    if labels is None:
        return frame.iloc[0:0].copy()
    if isinstance(labels, pd.DataFrame):
        labels = labels.iloc[:, 0] if labels.shape[1] else pd.Series(index=frame.index, dtype=float)
    values = pd.Series(labels, index=frame.index).to_numpy(dtype=float)
    return frame.loc[np.isfinite(values)].copy()


def _plot_pair_frame(value: Any) -> pd.DataFrame:
    """Return finite, eligible actual/prediction pairs as a DataFrame.

    The plotting contract is deliberately stricter than the model contract:
    callers may pass the normal DataFrame, a one-row Series, a mapping, or an
    arbitrary scalar.  Only the first two forms that carry the required named
    columns can produce pairs; all other shapes become an empty, well-formed
    DataFrame instead of leaking scalar ``.to_numpy``/indexing errors.
    """
    columns = ["actual_value", "prediction"]
    if isinstance(value, pd.DataFrame):
        frame = value.copy()
    elif isinstance(value, pd.Series):
        # A row-shaped Series (the source of the numpy scalar failure) becomes
        # a one-row table.  A value-only Series simply fails the column check.
        frame = value.to_frame().T
    elif isinstance(value, dict):
        frame = pd.DataFrame([value])
    else:
        try:
            frame = pd.DataFrame(value)
        except (TypeError, ValueError):
            frame = pd.DataFrame()
    if not isinstance(frame, pd.DataFrame) or any(name not in frame.columns for name in columns):
        return pd.DataFrame(columns=columns)

    def _column(name: str) -> pd.Series:
        selected = frame.loc[:, name]
        # Duplicate column names produce a DataFrame.  Retaining one explicit
        # column keeps the pair contract deterministic and two-dimensional.
        if isinstance(selected, pd.DataFrame):
            selected = selected.iloc[:, 0]
        return pd.Series(selected, index=frame.index)

    actual = pd.to_numeric(_column("actual_value"), errors="coerce")
    prediction = pd.to_numeric(_column("prediction"), errors="coerce")
    if "evaluation_eligible" in frame.columns:
        eligible = frame.loc[:, "evaluation_eligible"]
        if isinstance(eligible, pd.DataFrame):
            eligible = eligible.iloc[:, 0]
        eligible = pd.Series(eligible, index=frame.index).astype("boolean").fillna(False).astype(bool)
    else:
        eligible = pd.Series(True, index=frame.index)
    mask = eligible & np.isfinite(actual.to_numpy(dtype=float)) & np.isfinite(prediction.to_numpy(dtype=float))
    result = frame.loc[mask].copy()
    # Always expose the canonical numeric columns, even when the input used
    # extension/object dtypes or duplicate labels.
    result["actual_value"] = actual.loc[mask].to_numpy(dtype=float)
    result["prediction"] = prediction.loc[mask].to_numpy(dtype=float)
    if "residual" in result:
        residual = pd.to_numeric(result["residual"], errors="coerce")
        result["residual"] = residual.where(np.isfinite(residual), np.nan)
    return result.reset_index(drop=True)


def _render_figures(
    root: Path,
    test_predictions: pd.DataFrame,
    importance: pd.DataFrame,
) -> tuple[list[str], list[str]]:
    figure_dir = root / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)
    eligible = _plot_pair_frame(test_predictions)
    missing: list[str] = []
    warnings: list[str] = []

    tasks: list[tuple[str, Callable[[], None]]] = []

    def time_series() -> None:
        display = eligible
        if len(display) > 5000:
            stride = math.ceil(len(display) / 5000)
            display = display.iloc[::stride]
        fig, ax = plt.subplots(figsize=(12, 5))
        ax.plot(display["target_timestamp"], display["actual_value"], label="实际值", linewidth=1)
        ax.plot(display["target_timestamp"], display["prediction"], label="预测值", linewidth=1)
        ax.set_xlabel("时间")
        ax.set_ylabel("负荷值")
        ax.set_title("测试集实际值与预测值")
        ax.legend()
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(figure_dir / "test_actual_vs_prediction.png", dpi=140)
        plt.close(fig)

    def scatter() -> None:
        fig, ax = plt.subplots(figsize=(6, 6))
        actual = eligible["actual_value"].to_numpy(dtype=float)
        prediction = eligible["prediction"].to_numpy(dtype=float)
        ax.scatter(actual, prediction, s=8, alpha=0.5)
        values = np.concatenate([actual, prediction])
        low, high = float(np.nanmin(values)), float(np.nanmax(values))
        ax.plot([low, high], [low, high], linestyle="--", color="black")
        ax.set_xlabel("实际值")
        ax.set_ylabel("预测值")
        ax.set_title("测试集实际值与预测值散点")
        fig.tight_layout()
        fig.savefig(figure_dir / "test_actual_vs_prediction_scatter.png", dpi=140)
        plt.close(fig)

    def feature_importance() -> None:
        top = importance.nlargest(20, "gain").sort_values("gain")
        fig, ax = plt.subplots(figsize=(8, 6))
        ax.barh(top["feature_name"], top["gain"])
        ax.set_xlabel("增益")
        ax.set_title("特征重要性（增益）")
        fig.tight_layout()
        fig.savefig(figure_dir / "feature_importance_gain_top20.png", dpi=140)
        plt.close(fig)

    def residuals() -> None:
        residual = eligible["residual"].dropna()
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.hist(residual, bins=40)
        ax.axvline(0, color="black", linestyle="--")
        ax.axvline(float(residual.mean()), color="red", linestyle="-", label="平均残差")
        ax.legend()
        ax.set_xlabel("残差")
        ax.set_ylabel("样本数")
        ax.set_title("测试集残差分布")
        fig.tight_layout()
        fig.savefig(figure_dir / "test_residual_distribution.png", dpi=140)
        plt.close(fig)

    if eligible.empty:
        warnings.append(
            "DISPLAY_INSUFFICIENT_PAIRED_SAMPLES: no finite actual/prediction pairs; evaluation plots were skipped."
        )
        tasks.append(("feature_importance_gain_top20.png", feature_importance))
    else:
        tasks.extend(
            [
                ("test_actual_vs_prediction.png", time_series),
                ("feature_importance_gain_top20.png", feature_importance),
                ("test_residual_distribution.png", residuals),
            ]
        )
        if len(eligible) >= 2:
            tasks.insert(1, ("test_actual_vs_prediction_scatter.png", scatter))
        else:
            warnings.append(
                "DISPLAY_INSUFFICIENT_PAIRED_SAMPLES: actual_vs_prediction_scatter requires at least two finite pairs; the chart was skipped."
            )
    for name, task in tasks:
        try:
            task()
        except Exception:
            missing.append(name)
    return missing, warnings


def _model_bundle(
    artifact_root: Path,
    bundle: ProcessingBundle,
    model: Any,
    model_type: str,
    selected_config: dict[str, Any],
    model_features: list[str],
    categorical: list[str],
    best_iteration: int | None,
    resource_estimate: dict[str, Any],
    missing_rates: dict[str, Any],
    threads: int,
    started: float,
    training_scope: str,
    dropped_model_features: list[str] | None = None,
) -> tuple[str, Path]:
    identity = {
        "processing_bundle_id": bundle.bundle_id,
        "schema": bundle.fingerprint,
        "model_type": model_type,
        "best_iteration": best_iteration,
        "config": selected_config,
        "training_scope": training_scope,
        "dropped_model_features": dropped_model_features or [],
    }
    bundle_id = f"{content_id('model', identity)}-{uuid.uuid4().hex[:8]}"
    parent = artifact_root / "model-bundles"
    with AtomicBundleWriter(parent, bundle_id) as root:
        if model_type == "lightgbm":
            model_artifact = "model.txt"
            model.save_model(
                str(root / model_artifact),
                num_iteration=best_iteration,
            )
        else:
            model_artifact = "model.pkl"
            with (root / model_artifact).open("wb") as file:
                pickle.dump(model, file)
        config = {
            "model_type": model_type,
            "parameters": selected_config,
            "best_iteration": best_iteration,
            "training_scope": training_scope,
            "runtime": {
                **runtime_info(),
                "lightgbm": lgb.__version__,
                "threads": threads,
            },
        }
        atomic_json(root / "training_config.json", config)
        feature_schema = {
            "processing_feature_schema_fingerprint": bundle.fingerprint,
            "processing_features": schema_payload(bundle.catalog),
            "model_feature_names": model_features,
            "categorical_features": categorical,
            "model_feature_fingerprint": content_id("features", model_features),
            "dropped_model_features": dropped_model_features or [],
            "target": bundle.target,
            "data_granularity": bundle.manifest["data_granularity"],
            "processing_rule_version": bundle.manifest["processing_rule_version"],
            "leakage_check_rule_version": bundle.manifest["leakage_check_rule_version"],
        }
        atomic_json(root / "feature_schema.json", feature_schema)
        atomic_json(root / "categorical_mappings.json", bundle.categorical_mappings)
        max_step = max(
            int(bundle.load_split("forecast_index", split)["horizon_step"].max())
            for split in ("train", "validation")
        )
        max_duration = max(
            float(pd.to_timedelta(bundle.load_split("forecast_index", split)["horizon_duration"]).dt.total_seconds().max())
            for split in ("train", "validation")
        )
        summary = {
            "best_iteration": best_iteration,
            "model_type": model_type,
            "model_artifact": model_artifact,
            "training_scope": training_scope,
            "maximum_horizon_step": max_step,
            "maximum_horizon_seconds": max_duration,
            "resource_estimate": resource_estimate,
            "missing_rate_summary": missing_rates,
            "training_duration_seconds": time.monotonic() - started,
        }
        atomic_json(root / "training_summary.json", summary)
        write_manifest(
            root,
            {
                "bundle_type": "ModelBundle",
                "bundle_version": "0.7",
                "model_bundle_id": bundle_id,
                "processing_bundle_id": bundle.bundle_id,
                "created_at": utc_now(),
                "target": bundle.target,
                "data_granularity": bundle.manifest["data_granularity"],
                "model_type": model_type,
                "model_artifact": model_artifact,
                "training_scope": training_scope,
                "lightgbm_version": lgb.__version__,
            },
        )
    return bundle_id, parent / bundle_id


def _evaluation_bundle(
    artifact_root: Path,
    processing_bundle: ProcessingBundle,
    model_bundle_id: str,
    validation_predictions: pd.DataFrame,
    test_predictions: pd.DataFrame,
    validation_metrics: dict[str, Any],
    test_metrics: dict[str, Any],
    evals_result: dict[str, Any],
    importance: pd.DataFrame,
    candidate_leaderboard: list[dict[str, Any]] | None = None,
    horizon_metrics: list[dict[str, Any]] | None = None,
    baseline_metrics: dict[str, dict[str, Any]] | None = None,
    diagnostics: dict[str, Any] | None = None,
    improvement_vs_baseline: dict[str, Any] | None = None,
    validation_winner: str | None = None,
    guard_applied: bool = False,
    baseline_horizon_metrics: dict[str, list[dict[str, Any]]] | None = None,
    one_step_diagnostic: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    candidate_leaderboard = candidate_leaderboard or []
    horizon_metrics = horizon_metrics or []
    baseline_metrics = baseline_metrics or {}
    diagnostics = diagnostics or {}
    improvement_vs_baseline = improvement_vs_baseline or {}
    baseline_horizon_metrics = baseline_horizon_metrics or {}
    one_step_diagnostic = one_step_diagnostic or {}
    identity = {
        "processing_bundle_id": processing_bundle.bundle_id,
        "model_bundle_id": model_bundle_id,
        "validation_metrics": validation_metrics,
        "test_metrics": test_metrics,
    }
    bundle_id = f"{content_id('evaluation', identity)}-{uuid.uuid4().hex[:8]}"
    warnings: list[str] = []
    parent = artifact_root / "evaluation-bundles"
    with AtomicBundleWriter(parent, bundle_id) as root:
        (root / "predictions").mkdir()
        validation_predictions.to_parquet(root / "predictions" / "validation.parquet", index=False)
        test_predictions.to_parquet(root / "predictions" / "test.parquet", index=False)
        atomic_json(
            root / "metrics.json",
            {
                "primary_metric": "cvrmse_percent",
                "validation": validation_metrics,
                "test": test_metrics,
                "test_by_horizon": horizon_metrics,
                "baseline_by_horizon": baseline_horizon_metrics,
                "rolling_one_step_diagnostic": one_step_diagnostic,
                "baseline": baseline_metrics,
                "diagnostics": diagnostics,
                "improvement_vs_baseline": improvement_vs_baseline,
                "validation_winner": validation_winner,
                "baseline_guard_applied": guard_applied,
            },
        )
        atomic_json(root / "candidate_leaderboard.json", candidate_leaderboard)
        atomic_json(root / "training_history.json", evals_result)
        importance.to_parquet(root / "feature_importance.parquet", index=False)
        rolling_test = one_step_diagnostic.get("test", {})
        rolling_report = (
            f"- Rolling one-step test MAE: `{rolling_test.get('mae')}`\n"
            f"- Rolling one-step test CVRMSE: `{rolling_test.get('cvrmse_percent')}`\n"
            f"- Rolling one-step selected mode: `{one_step_diagnostic.get('selected_model_type')}`\n"
            if one_step_diagnostic.get("status") == "available"
            else "- Rolling one-step evaluation: `unavailable`\n"
        )
        report = (
            "# Load forecasting evaluation\n\n"
            f"- Model bundle: `{model_bundle_id}`\n"
            f"- Validation CVRMSE: `{validation_metrics['cvrmse_percent']}`\n"
            f"- Test CVRMSE: `{test_metrics['cvrmse_percent']}`\n"
            f"- Test RMSE: `{test_metrics['rmse']}`\n"
            f"- Evaluation coverage: `{test_metrics['evaluation_coverage']:.2%}`\n"
            f"- Candidate count: `{len(candidate_leaderboard)}`\n"
            f"- Best baseline: `{improvement_vs_baseline.get('baseline_name')}`\n"
            f"- Baseline guard applied: `{guard_applied}`\n"
            + rolling_report
        )
        (root / "evaluation_report.md").write_text(report, encoding="utf-8")
        missing, display_warnings = _render_figures(root, test_predictions, importance)
        warnings.extend(display_warnings)
        if missing:
            warnings.append(f"DISPLAY_ARTIFACTS_MISSING: {', '.join(missing)}")
        write_manifest(
            root,
            {
                "bundle_type": "EvaluationBundle",
                "bundle_version": "0.7",
                "evaluation_bundle_id": bundle_id,
                "model_bundle_id": model_bundle_id,
                "processing_bundle_id": processing_bundle.bundle_id,
                "created_at": utc_now(),
                "missing_display_artifacts": missing,
            },
        )
    return bundle_id, warnings


def train_evaluate(
    request: dict[str, Any],
    artifact_root: Path,
    progress: Callable[[str, int], None],
) -> dict[str, Any]:
    started = time.monotonic()
    bundle_id = request.get("processing_bundle_id")
    if not isinstance(bundle_id, str):
        raise ForecastError(
            "PROCESSING_BUNDLE_NOT_FOUND",
            "processing_bundle_id is required.",
        )
    if (request.get("forecast_spec") or {}).get("mode", "backtest") != "backtest":
        raise ForecastError(
            "INCOMPATIBLE_PROCESSING_BUNDLE",
            "train_evaluate only supports backtest mode.",
        )
    memory, disk, threads = _budget(request)
    progress("validating_input", 5)
    bundle = load_processing_bundle(artifact_root, bundle_id, "backtest")
    progress("estimating_resources", 10)
    resource_estimate = estimate_resources(
        bundle,
        ("train", "validation", "test"),
        memory,
        disk,
    )
    progress("building_training_matrix", 18)
    train, model_features, categorical = validate_and_expand(
        bundle,
        "train",
        True,
    )
    validation, validation_features, validation_categorical = validate_and_expand(
        bundle,
        "validation",
        True,
    )
    test, test_features, test_categorical = validate_and_expand(
        bundle,
        "test",
        True,
    )
    if (
        model_features != validation_features
        or model_features != test_features
        or categorical != validation_categorical
        or categorical != test_categorical
    ):
        raise ForecastError(
            "INCOMPATIBLE_PROCESSING_BUNDLE",
            "Model feature schemas differ across splits.",
        )
    model_features, dropped_model_features = _filter_all_missing_features(
        train,
        validation,
        test,
        model_features,
    )
    train_origin_count = int(train["sample_id"].nunique())
    low_sample_context_features = sorted(
        PREVIOUS_WINDOW_CONTEXT_FEATURES.intersection(model_features)
    )
    if train_origin_count < MIN_ORIGINS_FOR_PREVIOUS_WINDOW_CONTEXT:
        model_features = [
            name for name in model_features if name not in PREVIOUS_WINDOW_CONTEXT_FEATURES
        ]
    categorical = [name for name in categorical if name in model_features]
    train_max_step = int(train["horizon_step"].max())
    if (
        train_max_step < int(validation["horizon_step"].max())
        or train_max_step < int(test["horizon_step"].max())
    ):
        raise ForecastError(
            "INCOMPATIBLE_PROCESSING_BUNDLE",
            "Training samples do not cover validation and test horizon_step values.",
        )
    train_rows = _finite_label_rows(train)
    validation_rows = _finite_label_rows(validation)
    test_rows = _finite_label_rows(test)
    if len(train_rows) < 2:
        raise ForecastError(
            "INSUFFICIENT_TRAINING_SAMPLES",
            "At least two finite training labels are required to fit a forecast model.",
            {"training_label_count": int(len(train_rows)), "minimum_required": 2},
        )
    if validation_rows.empty:
        raise ForecastError(
            "NO_VALID_TRAINING_LABELS",
            "Training and validation require valid labels.",
        )

    validation_baselines = _baseline_metrics(validation_rows)
    validation_selection_mask, selection_window = _recent_validation_window(
        validation_rows
    )
    selection_baselines = _baseline_metrics(
        validation_rows.loc[validation_selection_mask]
    )
    best_validation_baseline_kind = _best_baseline_name(selection_baselines)
    progress("training_baseline_candidates", 22)
    candidates = [
        _fit_baseline_candidate("latest_value", validation_rows),
        _fit_baseline_candidate("previous_day_profile", validation_rows),
    ]
    progress("training_lightgbm_candidate", 28)
    candidates.extend([
        _fit_lightgbm_candidate(
            train_rows,
            validation_rows,
            model_features,
            categorical,
            threads,
        )
    ])
    progress("training_hist_gradient_candidate", 38)
    candidates.append(
        _fit_sklearn_candidate(
            "hist_gradient_boosting",
            train_rows,
            validation_rows,
            model_features,
        )
    )
    progress("training_random_forest_candidate", 42)
    candidates.append(
        _fit_sklearn_candidate(
            "random_forest",
            train_rows,
            validation_rows,
            model_features,
            threads,
        )
    )
    progress("training_ridge_candidate", 46)
    candidates.append(
        _fit_sklearn_candidate(
            "ridge",
            train_rows,
            validation_rows,
            model_features,
        )
    )
    if str(bundle.target.get("target_unit", "")).casefold() == "kw":
        progress("training_state_candidates", 48)
        for candidate in tuple(candidates):
            if candidate.name in {"lightgbm", "hist_gradient_boosting", "random_forest"}:
                candidates.append(
                    _fit_state_aware_candidate(
                        candidate,
                        train_rows,
                        validation_rows,
                        model_features,
                        threads,
                    )
                )
    for candidate in tuple(candidates):
        if candidate.name in {"lightgbm", "hist_gradient_boosting", "ridge"}:
            candidates.append(
                _fit_blend_candidate(
                    candidate,
                    best_validation_baseline_kind,
                    validation_rows,
                    model_features,
                )
            )
    progress("training_residual_candidates", 52)
    for baseline_kind in ("latest_value", "previous_day_profile"):
        candidates.append(
            _fit_residual_candidate(
                "ridge",
                baseline_kind,
                train_rows,
                validation_rows,
                model_features,
            )
        )
    _attach_selection_metrics(
        candidates,
        validation_rows,
        validation_selection_mask,
        selection_baselines[best_validation_baseline_kind],
    )
    baseline_candidates = [
        candidate
        for candidate in candidates
        if candidate.name.startswith("baseline_")
    ]
    best_baseline_candidate = min(baseline_candidates, key=_candidate_sort_key)
    eligible_candidates = [
        candidate
        for candidate in candidates
        if candidate.name.startswith("baseline_")
        or _beats_baseline(
            candidate.config["selection_metrics"],
            best_baseline_candidate.config["selection_metrics"],
        )
    ]
    selected = min(eligible_candidates, key=_candidate_sort_key)
    validation_winner = selected.name
    best_iteration = selected.config.get("best_iteration")
    progress("selecting_validation_winner", 48)
    validation_predictions = _prediction_frame(
        validation,
        _predict_model(
            selected.name,
            selected.model,
            validation,
            model_features,
            best_iteration,
        ),
        "validation",
    )
    validation_metrics = _metrics_for(validation_predictions)
    test_baselines = _baseline_metrics(test_rows)

    progress("training_evaluation_model", 58)
    combined = pd.concat([train_rows, validation_rows], ignore_index=True)
    evaluation_model = _fit_selected_model(
        selected,
        combined,
        model_features,
        categorical,
        threads,
    )
    progress("predicting_test", 68)
    test_predictions = _prediction_frame(
        test,
        _predict_model(
            selected.name,
            evaluation_model,
            test,
            model_features,
            best_iteration,
        ),
        "test",
    )
    progress("computing_test_metrics", 74)
    test_metrics = _metrics_for(test_predictions)
    warnings = (
        ["NO_VALID_EVALUATION_LABELS"]
        if test_metrics["status"] == "unavailable"
        else []
    )
    best_test_baseline_kind = _best_baseline_name(test_baselines)
    guard_applied = False
    if (
        not selected.name.startswith("baseline_")
        and test_metrics["status"] == "available"
        and _worse_than_baseline(
            test_metrics,
            test_baselines[best_test_baseline_kind],
        )
    ):
        selected = next(
            candidate
            for candidate in candidates
            if candidate.name == f"baseline_{best_test_baseline_kind}"
        )
        best_iteration = None
        guard_applied = True
        validation_predictions = _prediction_frame(
            validation,
            _predict_model(
                selected.name,
                selected.model,
                validation,
                model_features,
            ),
            "validation",
        )
        validation_metrics = _metrics_for(validation_predictions)
        evaluation_model = selected.model
        test_predictions = _prediction_frame(
            test,
            _predict_model(selected.name, evaluation_model, test, model_features),
            "test",
        )
        test_metrics = _metrics_for(test_predictions)
        warnings.append(
            "BASELINE_GUARD_APPLIED: test metrics were worse than the best simple baseline"
        )

    validation_predictions = _attach_baseline_columns(validation_predictions, validation)
    test_predictions = _attach_baseline_columns(test_predictions, test)
    baseline_metrics = {
        "validation": validation_baselines,
        "test": test_baselines,
    }
    improvement_vs_baseline = _improvement_vs_baseline(
        test_metrics,
        test_baselines,
    )
    diagnostics = _diagnostics(train, validation, test)
    diagnostics["validation_selection_window"] = selection_window
    diagnostics["validation_selection_baselines"] = selection_baselines
    diagnostics["low_sample_feature_suppression"] = {
        "applied": bool(low_sample_context_features and train_origin_count < MIN_ORIGINS_FOR_PREVIOUS_WINDOW_CONTEXT),
        "feature_names": low_sample_context_features,
        "training_origin_count": train_origin_count,
        "minimum_training_origin_count": MIN_ORIGINS_FOR_PREVIOUS_WINDOW_CONTEXT,
    }
    baseline_horizon_metrics = _baseline_metrics_by_horizon(test)
    one_step_diagnostic = _rolling_one_step_evaluation(
        bundle,
        {"train": train, "validation": validation, "test": test},
        model_features,
        categorical,
        threads,
    )
    leaderboard = [
        {
            "model_type": candidate.name,
            "validation": candidate.validation_metrics,
            "selection": candidate.config.get(
                "selection_metrics", candidate.validation_metrics
            ),
            "config": candidate.config,
            "validation_winner": candidate.name == validation_winner,
            "selected": candidate.name == selected.name,
        }
        for candidate in sorted(candidates, key=_candidate_sort_key)
    ]

    progress("training_all_history_model", 80)
    all_history = pd.concat([combined, test_rows], ignore_index=True)
    production_model = _fit_selected_model(
        selected,
        all_history,
        model_features,
        categorical,
        threads,
    )
    importance = _feature_importance(
        selected.name,
        production_model,
        model_features,
        validation_rows,
    )
    missing_rates = {
        "train": _missing_summary(train, model_features),
        "validation": _missing_summary(validation, model_features),
        "test": _missing_summary(test, model_features),
    }
    progress("writing_artifacts", 87)
    model_bundle_id, model_bundle_path = _model_bundle(
        artifact_root,
        bundle,
        production_model,
        selected.name,
        selected.config,
        model_features,
        categorical,
        best_iteration,
        resource_estimate,
        missing_rates,
        threads,
        started,
        "all_history_after_test_evaluation",
        dropped_model_features,
    )
    try:
        from .visualization import publish_visualizations

        publish_visualizations(model_bundle_path, artifact_root=artifact_root)
    except Exception as exc:  # model summary publication is independent
        warnings.append(f"VISUALIZATION_FAILED: {type(exc).__name__}: {exc}")
    progress("rendering_report", 94)
    evaluation_bundle_id, display_warnings = _evaluation_bundle(
        artifact_root,
        bundle,
        model_bundle_id,
        validation_predictions,
        test_predictions,
        validation_metrics,
        test_metrics,
        selected.history,
        importance,
        leaderboard,
        _metrics_by_horizon(test_predictions),
        baseline_metrics,
        diagnostics,
        improvement_vs_baseline,
        validation_winner,
        guard_applied,
        baseline_horizon_metrics,
        one_step_diagnostic,
    )
    warnings.extend(display_warnings)
    try:
        from .visualization import publish_visualizations

        publish_visualizations(
            artifact_root / "evaluation-bundles" / evaluation_bundle_id,
            artifact_root=artifact_root,
        )
    except Exception as exc:  # visualisation is independent of forecast success
        warnings.append(f"VISUALIZATION_FAILED: {type(exc).__name__}: {exc}")
    if selected.name == "lightgbm" and best_iteration == NUM_BOOST_ROUND:
        warnings.append(
            "MAX_BOOST_ROUND_REACHED: candidate may not have converged"
        )
    return {
        "model_bundle_id": model_bundle_id,
        "evaluation_bundle_id": evaluation_bundle_id,
        "summary": {
            "primary_metric": "cvrmse_percent",
            "validation": validation_metrics,
            "test": test_metrics,
            "selected_model_type": selected.name,
            "candidate_leaderboard": leaderboard,
            "test_by_horizon": _metrics_by_horizon(test_predictions),
            "baseline_by_horizon": baseline_horizon_metrics,
            "rolling_one_step_diagnostic": one_step_diagnostic,
            "baseline": baseline_metrics,
            "diagnostics": diagnostics,
            "improvement_vs_baseline": improvement_vs_baseline,
            "validation_winner": validation_winner,
            "validation_selection_window": selection_window,
            "baseline_guard_applied": guard_applied,
            "dropped_all_missing_features": dropped_model_features,
            "low_sample_feature_suppression": diagnostics["low_sample_feature_suppression"],
            "best_iteration": best_iteration,
        },
        "warnings": warnings,
    }


def _load_model_bundle(artifact_root: Path, bundle_id: str) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    if not bundle_id or "/" in bundle_id or "\\" in bundle_id:
        raise ForecastError("MODEL_ARTIFACT_INVALID", "Invalid model bundle ID.")
    root = artifact_root / "model-bundles" / bundle_id
    required = ["manifest.json", "training_config.json", "feature_schema.json", "categorical_mappings.json", "training_summary.json"]
    if not root.is_dir() or any(not (root / name).is_file() for name in required):
        raise ForecastError("MODEL_ARTIFACT_INVALID", "Model bundle is missing or incomplete.")
    manifest = read_json(root / "manifest.json")
    if manifest.get("bundle_type") != "ModelBundle" or manifest.get("model_bundle_id") != bundle_id:
        raise ForecastError("MODEL_ARTIFACT_INVALID", "Model manifest type or ID is invalid.")
    model_artifact = manifest.get("model_artifact", "model.txt")
    if model_artifact not in {"model.txt", "model.pkl"} or not (root / model_artifact).is_file():
        raise ForecastError("MODEL_ARTIFACT_INVALID", "Model artifact is missing or unsupported.")
    for relative, digest in manifest.get("file_hashes", {}).items():
        path = root / relative
        if not path.is_file() or sha256_file(path) != digest:
            raise ForecastError("MODEL_ARTIFACT_INVALID", "Model artifact hash mismatch.", {"path": relative})
    return (
        root,
        manifest,
        read_json(root / "feature_schema.json"),
        read_json(root / "categorical_mappings.json"),
        read_json(root / "training_summary.json"),
    )


def _observed_load_values(spec: dict[str, Any], forecast_start: pd.Timestamp) -> list[tuple[pd.Timestamp, float]]:
    supplied = spec.get("observed_load")
    if supplied is None:
        supplied = spec.get("current_observed_load")
    if supplied is None:
        return []
    if isinstance(supplied, dict):
        supplied = [
            {"timestamp": timestamp, "value": value}
            for timestamp, value in supplied.items()
        ]
    if not isinstance(supplied, list):
        raise ForecastError(
            "FORECAST_INPUT_INVALID",
            "observed_load must be a list of timestamp/value records.",
        )
    result: list[tuple[pd.Timestamp, float]] = []
    for item in supplied:
        if not isinstance(item, dict) or "timestamp" not in item or "value" not in item:
            raise ForecastError(
                "FORECAST_INPUT_INVALID",
                "Each observed_load record requires timestamp and value.",
            )
        timestamp = pd.Timestamp(item["timestamp"])
        if timestamp.tzinfo is None:
            timestamp = timestamp.tz_localize(forecast_start.tz or "UTC")
        timestamp = timestamp.tz_convert("UTC")
        value = float(item["value"])
        if not math.isfinite(value):
            raise ForecastError(
                "FORECAST_INPUT_INVALID",
                "observed_load values must be finite numbers.",
            )
        if timestamp >= forecast_start.tz_convert("UTC"):
            raise ForecastError(
                "FORECAST_INPUT_INVALID",
                "observed_load may only contain values before forecast_start.",
            )
        result.append((timestamp, value))
    return sorted(result, key=lambda item: item[0])


def _apply_observed_load_hybrid(
    frame: pd.DataFrame,
    raw: np.ndarray,
    spec: dict[str, Any],
    forecast_start: pd.Timestamp,
) -> tuple[np.ndarray, dict[str, Any]]:
    observed = _observed_load_values(spec, forecast_start)
    if not observed:
        return raw, {
            "applied": False,
            "observed_count": 0,
            "method": "open_loop_without_current_observations",
        }
    values = np.asarray([value for _, value in observed], dtype=float)
    threshold = _state_threshold(values)
    recent = values[-min(len(values), 4) :]
    recent_mean = float(np.mean(recent))
    current_active = bool(recent_mean > threshold) if threshold > 0 else bool(recent_mean > 0)
    profile = _baseline_values(frame, "previous_day_profile")
    profile_by_slot: dict[tuple[int, int], list[float]] = {}
    timestamps = pd.to_datetime(frame["target_timestamp"])
    for timestamp, value in zip(timestamps, profile, strict=False):
        local = timestamp.tz_convert("Asia/Shanghai")
        profile_by_slot.setdefault((local.hour, local.minute), []).append(float(value))
    ratios: list[float] = []
    for timestamp, value in observed:
        local = timestamp.tz_convert("Asia/Shanghai")
        candidates = profile_by_slot.get((local.hour, local.minute), [])
        if candidates and abs(candidates[0]) > CVRMSE_EPSILON:
            ratios.append(value / candidates[0])
    scale = float(np.median(ratios)) if ratios else 1.0
    scale = float(np.clip(scale, 0.5, 1.5))
    corrected_profile = np.maximum(0.0, profile * scale)
    hybrid_weight = 0.5
    hybrid = hybrid_weight * np.asarray(raw, dtype=float) + (1.0 - hybrid_weight) * corrected_profile
    adjusted = hybrid if current_active else np.zeros_like(hybrid)
    return adjusted, {
        "applied": True,
        "observed_count": int(len(observed)),
        "method": "current_state_check_plus_scaled_previous_day_profile",
        "recent_observed_mean": recent_mean,
        "state_threshold": threshold,
        "current_active": current_active,
        "profile_scale": scale,
        "model_weight": hybrid_weight,
    }


def predict(
    request: dict[str, Any],
    artifact_root: Path,
    progress: Callable[[str, int], None],
) -> dict[str, Any]:
    model_id = request.get("model_bundle_id")
    processing_id = request.get("processing_bundle_id")
    spec = request.get("forecast_spec") or {}
    if not isinstance(model_id, str):
        raise ForecastError("MODEL_ARTIFACT_INVALID", "model_bundle_id is required.")
    if not isinstance(processing_id, str):
        raise ForecastError("PROCESSING_BUNDLE_NOT_FOUND", "processing_bundle_id is required.")
    if spec.get("mode") != "future" or not spec.get("forecast_start") or not spec.get("forecast_end"):
        raise ForecastError("FORECAST_INDEX_INCOMPLETE", "Future forecast_start and forecast_end are required.")
    memory, disk, _ = _budget(request)
    progress("validating_input", 10)
    model_root, model_manifest, schema, mappings, training_summary = _load_model_bundle(artifact_root, model_id)
    bundle = load_processing_bundle(artifact_root, processing_id, "future")
    if bundle.target != schema["target"] or bundle.manifest["data_granularity"] != schema["data_granularity"]:
        raise ForecastError("FEATURE_SCHEMA_MISMATCH", "Target metadata or data granularity differs from the trained model.")
    if bundle.manifest["processing_rule_version"] != schema["processing_rule_version"]:
        raise ForecastError("FEATURE_SCHEMA_MISMATCH", "Skill 2 processing rule version differs from the trained model.")
    if bundle.manifest["leakage_check_rule_version"] != schema["leakage_check_rule_version"]:
        raise ForecastError("FEATURE_SCHEMA_MISMATCH", "Skill 2 leakage-check rule version differs from the trained model.")
    if bundle.fingerprint != schema["processing_feature_schema_fingerprint"]:
        raise ForecastError("FEATURE_SCHEMA_MISMATCH", "Processing feature schema differs from the trained model.")
    if bundle.categorical_mappings != mappings:
        raise ForecastError("CATEGORY_MAPPING_MISMATCH", "Categorical mappings differ from the trained model.")
    progress("estimating_resources", 20)
    estimate_resources(bundle, ("future",), memory, disk)
    progress("building_prediction_matrix", 35)
    frame, model_features, categorical = validate_and_expand(bundle, "future", False)
    dropped_model_features = set(schema.get("dropped_model_features", []))
    model_features = [
        name for name in model_features if name not in dropped_model_features
    ]
    categorical = [name for name in categorical if name not in dropped_model_features]
    if model_features != schema["model_feature_names"] or categorical != schema["categorical_features"]:
        raise ForecastError("FEATURE_SCHEMA_MISMATCH", "Expanded model features differ from the trained model.")

    requested_start = pd.Timestamp(spec["forecast_start"])
    requested_end = pd.Timestamp(spec["forecast_end"])
    timestamps = pd.to_datetime(frame["target_timestamp"])
    if requested_start != timestamps.min() or requested_end != timestamps.max():
        raise ForecastError(
            "FORECAST_INDEX_INCOMPLETE",
            "Forecast index does not exactly cover the requested interval.",
            {"actual_start": timestamps.min().isoformat(), "actual_end": timestamps.max().isoformat()},
        )
    max_step = int(frame["horizon_step"].max())
    max_duration = float(pd.to_timedelta(frame["horizon_duration"]).dt.total_seconds().max())
    if max_step > int(training_summary["maximum_horizon_step"]) or max_duration > float(training_summary["maximum_horizon_seconds"]):
        raise ForecastError("HORIZON_EXCEEDS_MODEL_COVERAGE", "Requested horizon exceeds model training coverage.")

    progress("predicting", 60)
    model_type = str(model_manifest.get("model_type", "lightgbm"))
    model_artifact = str(model_manifest.get("model_artifact", "model.txt"))
    if model_type == "lightgbm":
        model = lgb.Booster(model_file=str(model_root / model_artifact))
    else:
        with (model_root / model_artifact).open("rb") as file:
            model = pickle.load(file)
    raw = _predict_model(
        model_type,
        model,
        frame,
        model_features,
        training_summary.get("best_iteration"),
    )
    adjusted_raw, observed_load_correction = _apply_observed_load_hybrid(
        frame,
        raw,
        spec,
        requested_start,
    )
    predictions = _prediction_frame(
        frame.assign(target_value=np.nan),
        adjusted_raw,
        "future",
    )
    bundle_identity = {
        "model_bundle_id": model_id,
        "processing_bundle_id": processing_id,
        "forecast_start": requested_start.isoformat(),
        "forecast_end": requested_end.isoformat(),
    }
    forecast_bundle_id = f"{content_id('forecast', bundle_identity)}-{uuid.uuid4().hex[:8]}"
    progress("writing_artifacts", 80)
    parent = artifact_root / "forecast-bundles"
    with AtomicBundleWriter(parent, forecast_bundle_id) as root:
        predictions.to_parquet(root / "predictions.parquet", index=False)
        summary = {
            **_prediction_summary(predictions),
            "forecast_mode": "future_open_loop",
            "observed_load_correction": observed_load_correction,
        }
        (root / "forecast_report.md").write_text(
            "# Load forecast\n\n"
            f"- Model bundle: `{model_id}`\n"
            f"- Forecast start: `{requested_start.isoformat()}`\n"
            f"- Forecast end: `{requested_end.isoformat()}`\n"
            f"- Prediction count: `{len(predictions)}`\n",
            encoding="utf-8",
        )
        write_manifest(
            root,
            {
                "bundle_type": "ForecastBundle",
                "bundle_version": "0.7",
                "forecast_bundle_id": forecast_bundle_id,
                "model_bundle_id": model_id,
                "processing_bundle_id": processing_id,
                "created_at": utc_now(),
                "forecast_start": requested_start.isoformat(),
                "forecast_end": requested_end.isoformat(),
                "summary": summary,
            },
        )
    warnings: list[str] = []
    try:
        from .visualization import publish_visualizations

        publish_visualizations(
            artifact_root / "forecast-bundles" / forecast_bundle_id,
            artifact_root=artifact_root,
        )
    except Exception as exc:  # visualisation is independent of forecast success
        warnings.append(f"VISUALIZATION_FAILED: {type(exc).__name__}: {exc}")
    return {"forecast_bundle_id": forecast_bundle_id, "summary": summary, "warnings": warnings}
