#!/usr/bin/env python3
"""Build the additive SQLite review index for embedding-similar first messages."""
from __future__ import annotations

import argparse
import csv
import hashlib
import gzip
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow.dataset as ds
import pyarrow as pa
import pyarrow.compute as pc


PRIMARY = 0.999
SENSITIVITY = 0.995
NEAR_VERBATIM = 0.9999


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path,
                        default=root.parent / "Prescreening" / "embedding_near_duplicates_20261026")
    parser.add_argument("--frame-db", type=Path, default=root / "data" / "paper-first-message-frame.sqlite")
    parser.add_argument("--index-db", type=Path, default=root / "data" / "annotation-index.sqlite")
    parser.add_argument("--output", type=Path, default=root / "data" / "embedding-similarities.sqlite")
    parser.add_argument("--manifest-output", type=Path)
    return parser.parse_args()


def load_row_map(path: Path, expected_rows: int) -> list[tuple[int, str]]:
    records: list[tuple[int, str]] = []
    with gzip.open(path, "rt", newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        required = {"row_index", "record_id"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("row_map.csv.gz is missing row_index or record_id.")
        for expected, row in enumerate(reader):
            row_index = int(row["row_index"])
            record_id = row["record_id"]
            if row_index != expected or not record_id:
                raise ValueError(f"Invalid row-map entry at row {expected}.")
            records.append((row_index, record_id))
    if len(records) != expected_rows or len({record_id for _, record_id in records}) != expected_rows:
        raise ValueError(f"Expected {expected_rows:,} contiguous, unique row-map records; found {len(records):,}.")
    return records


def main() -> int:
    args = parse_args()
    input_dir = args.input_dir.resolve()
    output = args.output.resolve()
    manifest = json.loads((input_dir / "input_manifest.json").read_text())
    complete = json.loads((input_dir / "embedding_complete.json").read_text())
    diagnostics = json.loads((input_dir / "threshold_diagnostics.json").read_text())
    rows = int(manifest.get("rows", 0))
    frame_fingerprint = manifest.get("frame_annotation_index_fingerprint")
    if (rows <= 0 or manifest.get("frame_stratum") != "with_person_reference_signal"
            or complete.get("rows") != rows
            or complete.get("config", {}).get("input_sha256") != manifest.get("output_sha256")):
        raise ValueError("Embedding outputs do not match the pinned, complete input manifest.")

    row_map = load_row_map(input_dir / "row_map.csv.gz", rows)
    args.frame_db = args.frame_db.resolve()
    args.index_db = args.index_db.resolve()
    if not args.frame_db.is_file() or not args.index_db.is_file():
        raise FileNotFoundError("Both the paper first-message frame and active annotation index are required for source validation.")

    with tempfile.TemporaryDirectory(prefix="embedding-similarities-") as temp_dir:
        temp_db = Path(temp_dir) / "embedding-similarities.sqlite"
        out_con = sqlite3.connect(temp_db)
        out_con.execute("PRAGMA journal_mode=OFF")
        out_con.execute("PRAGMA synchronous=OFF")
        out_con.execute("PRAGMA temp_store=FILE")
        out_con.executescript("""
            CREATE TABLE record_map(row_index INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE);
            CREATE TABLE pairs(left_index INTEGER NOT NULL, right_index INTEGER NOT NULL,
                               cosine_similarity REAL NOT NULL,
                               CHECK(left_index < right_index),
                               PRIMARY KEY(left_index,right_index)) WITHOUT ROWID;
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
        out_con.executemany("INSERT INTO record_map VALUES (?,?)", row_map)

        # Use an in-memory/temp database for lookup staging; source indexes stay read-only.
        verify_con = sqlite3.connect(":memory:")
        verify_con.execute("ATTACH DATABASE ? AS paper_frame", (f"file:{args.frame_db}?mode=ro",))
        verify_con.execute("ATTACH DATABASE ? AS annotation_index", (f"file:{args.index_db}?mode=ro",))
        verify_con.execute("CREATE TEMP TABLE requested_records(row_index INTEGER PRIMARY KEY,record_id TEXT UNIQUE NOT NULL)")
        verify_con.executemany("INSERT INTO requested_records VALUES (?,?)", row_map)
        frame_meta = dict(verify_con.execute("SELECT key,value FROM paper_frame.meta"))
        index_meta = dict(verify_con.execute("SELECT key,value FROM annotation_index.meta WHERE key='fingerprint'"))
        expected_fingerprint = frame_fingerprint
        if frame_meta.get("input_fingerprint") != expected_fingerprint or index_meta.get("fingerprint") != expected_fingerprint:
            raise ValueError("The source sidecars do not match the embedding frame fingerprint.")
        if int(frame_meta.get("retained_person_signal", -1)) != rows:
            raise ValueError("The paper frame's positive first-message count does not match the embedding input.")
        frame_counts = verify_con.execute("""SELECT count(f.record_id),
                   coalesce(sum(f.has_person_signal=1 AND f.is_representative=1),0)
            FROM requested_records q LEFT JOIN paper_frame.first_messages f ON f.record_id=q.record_id""").fetchone()
        if tuple(frame_counts) != (rows, rows):
            raise ValueError(f"Embedding IDs do not exactly match retained positive first messages: {tuple(frame_counts)}")
        index_count = verify_con.execute("""SELECT count(r.id) FROM requested_records q
            LEFT JOIN annotation_index.records r ON r.id=q.record_id""").fetchone()[0]
        if index_count != rows:
            raise ValueError(f"Only {index_count:,} of {rows:,} embedding IDs exist in the active annotation index.")
        verify_con.close()

        parquet_path = input_dir / "embedding_candidate_edges_ge_085.parquet"
        dataset = ds.dataset(parquet_path, format="parquet")
        selected = dataset.to_table(
            columns=["query_index", "neighbor_index", "query_record_id", "neighbor_record_id", "cosine_similarity"],
            filter=ds.field("cosine_similarity") >= SENSITIVITY,
        )
        query = selected.column("query_index").to_numpy(zero_copy_only=False).astype(np.int64, copy=False)
        neighbor = selected.column("neighbor_index").to_numpy(zero_copy_only=False).astype(np.int64, copy=False)
        scores = selected.column("cosine_similarity").to_numpy(zero_copy_only=False).astype(np.float32, copy=False)
        if len(scores) != int(diagnostics["top100_edge_counts_and_saturation"]["directed_candidate_edges"]["ge_9950"]):
            raise ValueError(f"Expected the documented directed >=0.995 edge count; found {len(scores)}.")
        if (np.any(query < 0) or np.any(query >= rows) or np.any(neighbor < 0) or np.any(neighbor >= rows)
                or np.any(query == neighbor) or not np.isfinite(scores).all()):
            raise ValueError("The directed candidate edges contain invalid indexes or scores.")
        row_ids = pa.array([record_id for _, record_id in row_map], type=pa.string())
        expected_queries = pc.take(row_ids, selected.column("query_index"))
        expected_neighbors = pc.take(row_ids, selected.column("neighbor_index"))
        if (not pc.all(pc.equal(expected_queries, selected.column("query_record_id"))).as_py()
                or not pc.all(pc.equal(expected_neighbors, selected.column("neighbor_record_id"))).as_py()):
            raise ValueError("Parquet edge indexes do not map to the stable record IDs in row_map.csv.gz.")
        left = np.minimum(query, neighbor)
        right = np.maximum(query, neighbor)
        keys = left * rows + right
        unique_keys, inverse = np.unique(keys, return_inverse=True)
        unique_scores = np.full(len(unique_keys), -np.inf, dtype=np.float32)
        np.maximum.at(unique_scores, inverse, scores)
        del selected, query, neighbor, scores, left, right, keys, inverse
        left_indices = unique_keys // rows
        right_indices = unique_keys % rows
        if np.any(unique_scores < SENSITIVITY) or np.any(unique_scores > 1.0) or np.any(left_indices >= right_indices):
            raise ValueError("Unique candidate edge normalization failed.")

        for start in range(0, len(unique_keys), 50_000):
            end = min(start + 50_000, len(unique_keys))
            values = ((int(left_indices[i]), int(right_indices[i]), float(unique_scores[i]))
                      for i in range(start, end))
            out_con.executemany("INSERT INTO pairs VALUES (?,?,?)", values)
            if start == 0 or end == len(unique_keys) or end % 1_000_000 == 0:
                print(f"stored {end:,} unique undirected candidate pairs", flush=True)
        out_con.commit()
        out_con.execute("CREATE INDEX pairs_by_score ON pairs(cosine_similarity DESC,left_index,right_index)")
        counts = {
            "primary": int(out_con.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=?", (PRIMARY,)).fetchone()[0]),
            "sensitivity": int(out_con.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=? AND cosine_similarity<?", (SENSITIVITY, PRIMARY)).fetchone()[0]),
            "near_verbatim": int(out_con.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=?", (NEAR_VERBATIM,)).fetchone()[0]),
            "all_sensitivity_candidates": int(out_con.execute("SELECT count(*) FROM pairs").fetchone()[0]),
        }
        expected = diagnostics["top100_edge_counts_and_saturation"]["directed_candidate_edges"]
        if counts["near_verbatim"] > counts["primary"] or counts["primary"] + counts["sensitivity"] != counts["all_sensitivity_candidates"]:
            raise ValueError("Threshold-band counts do not partition the sensitivity sidecar.")
        meta = {
            "schema_version": "1",
            "records": str(rows),
            "source_input_sha256": manifest["output_sha256"],
            "source_frame_fingerprint": expected_fingerprint,
            "embedding_model": complete["config"]["model_id"],
            "embedding_revision": complete["config"]["model_revision"],
            "directed_top100_edges_ge_0_995": str(expected["ge_9950"]),
            "unique_undirected_pairs_ge_0_995": str(counts["all_sensitivity_candidates"]),
            "unique_pairs_ge_0_999": str(counts["primary"]),
            "unique_pairs_0_995_to_0_999": str(counts["sensitivity"]),
            "unique_pairs_ge_0_9999": str(counts["near_verbatim"]),
            "edge_semantics": "Undirected union of directed exact top-100 neighbors; reciprocal edges deduplicated; only cosine >= 0.995 retained.",
            "coverage_warning": "Rows whose top-100 list is saturated at a threshold may have additional qualifying pairs not present in this sidecar.",
        }
        out_con.executemany("INSERT INTO meta VALUES (?,?)", meta.items())
        out_con.commit()
        integrity = out_con.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Sidecar SQLite integrity check failed: {integrity}")
        row_count = out_con.execute("SELECT count(*) FROM pairs").fetchone()[0]
        if row_count != counts["all_sensitivity_candidates"]:
            raise ValueError("Sidecar pair count changed while writing.")
        out_con.close()
        output.parent.mkdir(parents=True, exist_ok=True)
        staged = output.with_name(output.name + ".incoming")
        if staged.exists():
            staged.unlink()
        os.replace(temp_db, staged)
        os.replace(staged, output)

    digest = hashlib.sha256()
    with output.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    report = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "output": str(output),
        "bytes": output.stat().st_size,
        "sha256": digest.hexdigest(),
        "source_records": rows,
        "directed_edges_ge_0_995": expected["ge_9950"],
        "unique_undirected_pairs": counts["all_sensitivity_candidates"],
        "primary_ge_0_999": counts["primary"],
        "sensitivity_0_995_to_0_999": counts["sensitivity"],
        "near_verbatim_ge_0_9999_subset_of_primary": counts["near_verbatim"],
        "frame_fingerprint": expected_fingerprint,
        "integrity_check": "ok",
    }
    manifest_path = (args.manifest_output or input_dir / "annotation_tool_sidecar_manifest.json").resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_tmp = manifest_path.with_name(manifest_path.name + ".tmp")
    manifest_tmp.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(manifest_tmp, manifest_path)
    report["manifest"] = str(manifest_path)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
