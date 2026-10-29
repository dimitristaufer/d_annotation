"""Shared verification and lookup helpers for the pinned MSD1 CTP frame."""

import json
import sqlite3


EXPECTED_RUN = "ctp_msd1_ge90_20261027T094333Z"
EXPECTED_CONFIG_SHA256 = "febe36913773dcd5e4f4a4942e05feb417275c240b3c2e5bed3bebe4af2b4c67"
VALID_LABELS = {"yes", "no", "unclear"}
EXPECTED_COUNTS = {"yes": 200_829, "no": 105_868, "unclear": 2_265}


def require_ctp_screening(con, verify_contents=True):
    """Verify pinned frame/run metadata; optionally recount every screening row."""
    try:
        meta = dict(con.execute("SELECT key,value FROM ctp_screening_index.meta"))
        index_meta = dict(con.execute("SELECT key,value FROM meta WHERE key='fingerprint'"))
        language_meta = dict(con.execute(
            "SELECT key,value FROM language_frame_index.meta "
            "WHERE key IN ('source_annotation_fingerprint','schema_version')"
        ))
        if verify_contents:
            row_count = int(con.execute("SELECT count(*) FROM ctp_screening_index.ctp_results").fetchone()[0])
            counts = {label: int(count) for label, count in con.execute(
                "SELECT label,count(*) FROM ctp_screening_index.ctp_results GROUP BY label"
            )}
        else:
            row_count = 308_962
            counts = EXPECTED_COUNTS
    except (sqlite3.Error, TypeError, ValueError) as error:
        raise ValueError("The completed MSD1 CTP screening index is not installed or readable.") from error

    metadata_counts = {label: int(meta.get(f"label_{label}", "-1")) for label in VALID_LABELS}
    if (meta.get("schema_version") != "1" or meta.get("frame_id") != "english_ge_90"
            or meta.get("frame_records") != "308962" or row_count != 308_962
            or set(counts) - VALID_LABELS or counts != EXPECTED_COUNTS or counts != metadata_counts
            or sum(counts.values()) != row_count
            or not index_meta.get("fingerprint")
            or meta.get("source_annotation_fingerprint") != index_meta["fingerprint"]
            or language_meta.get("source_annotation_fingerprint") != index_meta["fingerprint"]
            or language_meta.get("schema_version") != "1"):
        raise ValueError("The MSD1 CTP screening index does not match the active ≥90% English paper frame.")
    if meta.get("run_id") != EXPECTED_RUN or meta.get("config_sha256") != EXPECTED_CONFIG_SHA256:
        raise ValueError("The MSD1 CTP screening sidecar is from an unexpected completed run or configuration.")
    return {
        "frameId": "english_ge_90",
        "frameRecords": row_count,
        "counts": counts,
        "runId": meta["run_id"],
        "configSha256": meta.get("config_sha256", ""),
    }


def get_ctp_labels(request, con, verify_contents=True):
    """Return verified MSD1 labels for requested IDs and flag IDs outside the frame."""
    record_ids = request.get("record_ids")
    if not isinstance(record_ids, list) or len(record_ids) > 100_000:
        raise ValueError("Provide at most 100,000 record IDs.")
    if any(not isinstance(record_id, str) or not record_id or len(record_id) > 300 for record_id in record_ids):
        raise ValueError("Record IDs must be non-empty strings of at most 300 characters.")

    frame = require_ctp_screening(con, verify_contents=verify_contents)
    unique_ids = list(dict.fromkeys(record_ids))
    if not unique_ids:
        return {"frameId": frame["frameId"], "runId": frame["runId"], "labels": {}, "unlabeledRecordIds": []}
    rows = con.execute(
        "SELECT input.value,screening.label FROM json_each(:record_ids) input "
        "LEFT JOIN ctp_screening_index.ctp_results screening ON screening.record_id=input.value "
        "ORDER BY CAST(input.key AS INTEGER)",
        {"record_ids": json.dumps(unique_ids)},
    ).fetchall()
    labels = {}
    unlabeled = []
    for record_id, label in rows:
        if label in VALID_LABELS:
            labels[record_id] = label
        else:
            unlabeled.append(record_id)
    return {
        "frameId": frame["frameId"],
        "runId": frame["runId"],
        "labels": labels,
        "unlabeledRecordIds": unlabeled,
    }
