from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from building_energy_agent.contracts.skill2_v07 import (
    FeatureSetRow,
    FeatureSpec,
    LabelSetRow,
    PredictionSample,
    PredictionSpec,
    ProcessingSpec,
    Skill2ResultResponse,
    TargetSpec,
)


def valid_processing_spec_data() -> dict[str, object]:
    return {
        "source_bundle_id": "dataset-bundle-id",
        "target": {"point_id": "target-point-id"},
        "prediction_spec": {},
        "feature_spec": {},
    }


def test_source_bundle_id_is_required() -> None:
    data = valid_processing_spec_data()
    del data["source_bundle_id"]

    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)


@pytest.mark.parametrize("bundle_id", ["../bundle", "a/b", r"a\b", ".", ".."])
def test_processing_spec_rejects_path_like_source_bundle_ids(bundle_id: str) -> None:
    data = valid_processing_spec_data()
    data["source_bundle_id"] = bundle_id

    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)


@pytest.mark.parametrize("bundle_id", ["../bundle", "a/b", r"a\b", ".", ".."])
def test_skill2_result_rejects_path_like_bundle_ids(bundle_id: str) -> None:
    with pytest.raises(ValidationError):
        Skill2ResultResponse(processing_bundle_id=bundle_id)


def test_target_is_required_and_accepts_one_point_id() -> None:
    data = valid_processing_spec_data()
    del data["target"]
    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)

    with pytest.raises(ValidationError):
        TargetSpec(point_id=["point-a", "point-b"])


def test_prediction_spec_object_is_required() -> None:
    data = valid_processing_spec_data()
    del data["prediction_spec"]

    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)


def test_feature_spec_object_is_required() -> None:
    data = valid_processing_spec_data()
    del data["feature_spec"]

    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)


def test_prediction_and_feature_defaults() -> None:
    assert PredictionSpec().forecast_horizon == "7d"
    assert FeatureSpec().preset == "default"

    request = ProcessingSpec.model_validate(valid_processing_spec_data())
    assert request.prediction_spec.forecast_horizon == "7d"
    assert request.feature_spec.preset == "default"


@pytest.mark.parametrize(
    "forbidden_field",
    ["source_ref", "file_path", "csv_path", "excel_path"],
)
def test_processing_spec_rejects_raw_file_inputs(forbidden_field: str) -> None:
    data = valid_processing_spec_data()
    data[forbidden_field] = "/unaccepted/raw-input"

    with pytest.raises(ValidationError):
        ProcessingSpec.model_validate(data)


def test_feature_and_label_sets_share_sample_id_semantics() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    feature = FeatureSetRow(
        sample_id="sample-1",
        feature_cutoff_timestamp=start,
        forecast_start_timestamp=start,
        forecast_end_timestamp=start + timedelta(days=7),
        future_feature_column=42,
    )
    labels = [
        LabelSetRow(
            sample_id="sample-1",
            target_timestamp=start + timedelta(hours=offset),
            target_value=float(offset),
        )
        for offset in (0, 1)
    ]

    assert feature.sample_id == labels[0].sample_id == labels[1].sample_id
    assert feature.model_extra == {"future_feature_column": 42}
    assert len(labels) == 2


def test_prediction_sample_contains_all_time_identity_fields() -> None:
    fields = set(PredictionSample.model_fields)

    assert fields == {
        "sample_id",
        "feature_cutoff_timestamp",
        "forecast_start_timestamp",
        "forecast_end_timestamp",
    }
