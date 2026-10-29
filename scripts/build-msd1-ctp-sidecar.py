#!/usr/bin/env python3
"""Build a compact, read-only Browse index from a completed MSD1 run."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = APP_DIR / "data"
INDEX_DB = DATA_DIR / "annotation-index.sqlite"
LANGUAGE_DB = DATA_DIR / "language-share-frames.sqlite"
LANGUAGE_MANIFEST = DATA_DIR / "language-share-frames.manifest.json"
FRAME_ID = "english_ge_90"
EXPECTED_FRAME_COUNT = 308_962
LABELS = {"yes", "no", "unclear"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--output", type=Path, default=DATA_DIR / "msd1-ctp-screening.sqlite")
    args = parser.parse_args()
    if len(args.config_sha256) != 64 or any(c not in "0123456789abcdef" for c in args.config_sha256):
        raise SystemExit("Invalid config SHA-256.")

    index = sqlite3.connect(f"file:{INDEX_DB}?mode=ro", uri=True)
    language = sqlite3.connect(f"file:{LANGUAGE_DB}?mode=ro", uri=True)
    try:
        index_meta = dict(index.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','records')"))
        language_meta = dict(language.execute("SELECT key,value FROM meta"))
        frame = language.execute(
            "SELECT retained_records FROM frames WHERE frame_id=?", (FRAME_ID,)
        ).fetchone()
        if not frame or int(frame[0]) != EXPECTED_FRAME_COUNT:
            raise SystemExit("The ≥90% English source frame count is unexpected.")
        fingerprint = index_meta.get("fingerprint", "")
        if not fingerprint or language_meta.get("source_annotation_fingerprint") != fingerprint:
            raise SystemExit("The language frame does not match the active annotation index.")
        if language_meta.get("schema_version") != "1":
            raise SystemExit("Unsupported language frame schema.")
        expected_language_sha = json.loads(LANGUAGE_MANIFEST.read_text()).get("sidecar_sha256")
        actual_language_sha = sha256_file(LANGUAGE_DB)
        if expected_language_sha != actual_language_sha:
            raise SystemExit("The language-frame sidecar does not match its manifest.")
        frame_members = language.execute(
            "SELECT count(*),count(DISTINCT record_id),count(DISTINCT row_index) "
            "FROM language_frame_flags WHERE frame_id=?", (FRAME_ID,)
        ).fetchone()
        if tuple(map(int, frame_members)) != (EXPECTED_FRAME_COUNT, EXPECTED_FRAME_COUNT, EXPECTED_FRAME_COUNT):
            raise SystemExit("The language-frame member IDs or row positions are not unique and complete.")
        expected = {
            row[0]: int(row[1])
            for row in language.execute(
                "SELECT f.record_id,f.row_index FROM language_frame_flags f "
                "WHERE f.frame_id=? ORDER BY f.row_index", (FRAME_ID,)
            )
        }
        if len(expected) != EXPECTED_FRAME_COUNT:
            raise SystemExit("The language-frame member IDs are not unique or complete.")
    finally:
        index.close()
        language.close()

    latest: dict[str, dict] = {}
    with args.results.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                item = json.loads(line)
                record = item["record"]
                record_id = record["record_id"]
            except (json.JSONDecodeError, KeyError, TypeError) as error:
                raise SystemExit(f"Malformed result row {line_number}.") from error
            if record_id not in expected:
                raise SystemExit(f"Result row {line_number} is outside the source frame.")
            latest[record_id] = item

    if set(latest) != set(expected):
        missing = len(set(expected) - set(latest))
        extra = len(set(latest) - set(expected))
        raise SystemExit(f"Result IDs do not match the source frame (missing={missing}, extra={extra}).")

    rows = []
    counts: Counter[str] = Counter()
    for record_id, item in latest.items():
        record = item["record"]
        choice = item.get("choice")
        if item.get("status") != "success" or choice not in LABELS:
            raise SystemExit(f"Record {record_id} has no final successful CTP decision.")
        if item.get("config_sha256") != args.config_sha256:
            raise SystemExit(f"Record {record_id} was produced with a different pinned configuration.")
        if int(record.get("row_index", -1)) != expected[record_id]:
            raise SystemExit(f"Record {record_id} is mapped to the wrong source-frame position.")
        confidence = item.get("confidence")
        probabilities = item.get("probabilities") or {}
        if not isinstance(confidence, (float, int)) or not 0 <= confidence <= 1:
            raise SystemExit(f"Record {record_id} has invalid selected-label confidence.")
        if set(probabilities) != LABELS or any(
            not isinstance(probabilities[label], (float, int)) or not 0 <= probabilities[label] <= 1
            for label in LABELS
        ):
            raise SystemExit(f"Record {record_id} has invalid decision probabilities.")
        if abs(float(confidence) - float(probabilities[choice])) > 1e-9:
            raise SystemExit(f"Record {record_id} confidence does not match its selected-label probability.")
        fallback = item.get("segmented_fallback") or {}
        segmented = bool(fallback)
        coverage_complete = bool(fallback.get("coverage_complete", True))
        rows.append((
            record_id, expected[record_id], choice, float(confidence),
            float(probabilities["yes"]), float(probabilities["no"]), float(probabilities["unclear"]),
            int(segmented), int(coverage_complete),
        ))
        counts[choice] += 1

    if sum(counts.values()) != EXPECTED_FRAME_COUNT:
        raise SystemExit("Final decision counts do not reconcile with the source frame.")
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temp = Path(temp_name)
    try:
        con = sqlite3.connect(temp)
        con.executescript("""
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL;
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE ctp_results(
                record_id TEXT PRIMARY KEY,
                row_index INTEGER NOT NULL UNIQUE,
                label TEXT NOT NULL CHECK(label IN ('yes','no','unclear')),
                confidence REAL NOT NULL,
                p_yes REAL NOT NULL,
                p_no REAL NOT NULL,
                p_unclear REAL NOT NULL,
                segmented INTEGER NOT NULL CHECK(segmented IN (0,1)),
                coverage_complete INTEGER NOT NULL CHECK(coverage_complete IN (0,1))
            ) WITHOUT ROWID;
            CREATE INDEX ctp_results_label_order ON ctp_results(label,row_index);
        """)
        con.executemany("INSERT INTO ctp_results VALUES(?,?,?,?,?,?,?,?,?)", rows)
        metadata = {
            "schema_version": "1",
            "frame_id": FRAME_ID,
            "frame_records": str(EXPECTED_FRAME_COUNT),
            "source_annotation_fingerprint": fingerprint,
            "source_language_sidecar_sha256": actual_language_sha,
            "source_language_scored_csv_sha256": language_meta.get("source_scored_csv_sha256", ""),
            "run_id": args.run_id,
            "config_sha256": args.config_sha256,
            "run_results_sha256": sha256_file(args.results),
            "built_at": datetime.now(timezone.utc).isoformat(),
            "label_yes": str(counts["yes"]),
            "label_no": str(counts["no"]),
            "label_unclear": str(counts["unclear"]),
            "segmented_records": str(sum(row[7] for row in rows)),
            "incomplete_segment_coverage": str(sum(row[7] and not row[8] for row in rows)),
        }
        con.executemany("INSERT INTO meta VALUES(?,?)", metadata.items())
        if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("SQLite integrity check failed.")
        if con.execute("SELECT count(*) FROM ctp_results").fetchone()[0] != EXPECTED_FRAME_COUNT:
            raise SystemExit("Built sidecar row count does not match the source frame.")
        con.commit()
        con.close()
        os.chmod(temp, 0o600)
        os.replace(temp, output)
        os.chmod(output, 0o600)
    finally:
        if temp.exists():
            temp.unlink()
    print(json.dumps({"output": str(output), "frame_records": EXPECTED_FRAME_COUNT,
                      "counts": {label: counts[label] for label in ("yes", "no", "unclear")},
                      "segmented_records": sum(row[7] for row in rows),
                      "incomplete_segment_coverage": sum(row[7] and not row[8] for row in rows),
                      "sidecar_sha256": sha256_file(output)}, separators=(",", ":")))


if __name__ == "__main__":
    main()
