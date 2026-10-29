#!/usr/bin/env python3
"""Build additive language-share browsing frames without changing annotations."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sqlite3
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
ANNOTATION_DB = DATA_DIR / "annotation-index.sqlite"
EMBEDDING_DB = DATA_DIR / "embedding-deduplicated-frames.sqlite"
OUTPUT_DB = DATA_DIR / "language-share-frames.sqlite"
FRAME_NAMES = {
    "english_ge_90": ("English share ≥90%", ("90-100%",)),
    "english_ge_80": ("English share ≥80%", ("90-100%", "80-<90%")),
    "english_ge_50": ("English share ≥50%", ("90-100%", "80-<90%", "50-<80%")),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def truth(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes"}


def build(frame_csv: Path, manifest_path: Path, normalization_manifest_path: Path, output_db: Path) -> dict:
    csv.field_size_limit(2**31 - 1)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    normalization_manifest = json.loads(normalization_manifest_path.read_text(encoding="utf-8"))
    if int(manifest.get("artifacts", {}).get("scored_frame", {}).get("rows", -1)) != 904_447:
        raise RuntimeError("Language frame manifest has an unexpected retained row count.")
    if int(manifest.get("cumulative_counts", {}).get("ge90", -1)) != 308_962:
        raise RuntimeError("Language frame manifest is not the validated 80%-coverage run.")
    actual_frame_hash = sha256_file(frame_csv)
    if actual_frame_hash != manifest["artifacts"]["scored_frame"]["sha256"]:
        raise RuntimeError("The scored CSV does not match the frame hash recorded by its manifest.")
    if (manifest["frame_input"].get("sha256") != normalization_manifest.get("outputs", {}).get("normalized_frame", {}).get("sha256")
            or int(manifest["frame_input"].get("rows", -1)) != int(normalization_manifest.get("normalization", {}).get("retained_rows", -2))):
        raise RuntimeError("The language pass does not match the short-normalized source frame.")

    output_db.parent.mkdir(parents=True, exist_ok=True)
    temp_db = output_db.with_suffix(output_db.suffix + ".tmp")
    temp_db.unlink(missing_ok=True)
    con = sqlite3.connect(temp_db)
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("PRAGMA synchronous=FULL")
    con.execute("PRAGMA temp_store=MEMORY")
    con.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE frames(frame_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, retained_records INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE language_members(
            record_id TEXT PRIMARY KEY,
            row_index INTEGER NOT NULL UNIQUE,
            english_share REAL,
            classified_coverage REAL NOT NULL,
            band TEXT NOT NULL,
            alphabetic_characters INTEGER NOT NULL,
            classified_characters INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE language_frame_flags(
            frame_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            PRIMARY KEY(frame_id, record_id)
        ) WITHOUT ROWID;
        CREATE INDEX language_frame_order ON language_frame_flags(frame_id, row_index, record_id);
        CREATE INDEX language_frame_record ON language_frame_flags(record_id, frame_id);
    """)
    con.execute("ATTACH DATABASE ? AS active_index", (f"file:{ANNOTATION_DB.resolve()}?mode=ro",))
    con.execute("ATTACH DATABASE ? AS embedding_index", (f"file:{EMBEDDING_DB.resolve()}?mode=ro",))
    active_meta = dict(con.execute("SELECT key,value FROM active_index.meta WHERE key IN ('fingerprint','records')"))
    embedding_meta = dict(con.execute("SELECT key,value FROM embedding_index.meta"))
    if not active_meta.get("fingerprint"):
        raise RuntimeError("The active annotation index has no frame fingerprint.")
    if embedding_meta.get("schema_version") != "1":
        raise RuntimeError("The installed embedding frame sidecar is unsupported.")
    if embedding_meta.get("source_frame_fingerprint") != active_meta["fingerprint"]:
        raise RuntimeError("The embedding frame sidecar does not match the active annotation index.")
    source_candidate_count = int(embedding_meta["embedding_near_verbatim_count"])
    input_candidate_count = int(normalization_manifest["source_embedding_frame_records"])
    excluded_count = int(normalization_manifest["normalization"]["excluded_rows"])
    retained_count = int(normalization_manifest["normalization"]["retained_rows"])
    if source_candidate_count != input_candidate_count or input_candidate_count - excluded_count != retained_count:
        raise RuntimeError("The normalized frame does not reconcile to the installed conservative embedding frame.")

    expected_bands = manifest["band_counts"]
    observed_bands = {key: 0 for key in expected_bands}
    frame_counts = {name: 0 for name in FRAME_NAMES}
    members_batch = []
    flags_batch = []
    row_count = 0
    last_order = (-1, -1)
    with __import__("gzip").open(frame_csv, "rt", encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        required = {"record_id", "source_shard", "source_row", "person_reference_signal", "is_ctp_screening_candidate",
                    "english_share", "classified_coverage", "alphabetic_characters", "classified_characters", "english_share_band"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise RuntimeError(f"Scored frame lacks required fields: {sorted(missing)}")
        for row_count, row in enumerate(reader, 1):
            match = __import__("re").search(r"-(\d+)-of-\d+$", row["source_shard"])
            if not match:
                raise RuntimeError(f"Invalid source_shard at row {row_count}")
            order = (int(match.group(1)), int(row["source_row"]))
            if order < last_order:
                raise RuntimeError(f"Scored frame lost source order at row {row_count}")
            last_order = order
            if not truth(row["person_reference_signal"]) or not truth(row["is_ctp_screening_candidate"]):
                raise RuntimeError(f"Language frame contains a non-candidate record: {row['record_id']}")
            band = row["english_share_band"]
            if band not in observed_bands:
                raise RuntimeError(f"Unexpected English-share band {band!r}")
            observed_bands[band] += 1
            members_batch.append((
                row["record_id"], row_count - 1,
                float(row["english_share"]) if row["english_share"] else None,
                float(row["classified_coverage"]), band,
                int(row["alphabetic_characters"]), int(row["classified_characters"]),
            ))
            for frame_id, (_label, included_bands) in FRAME_NAMES.items():
                if band in included_bands:
                    flags_batch.append((frame_id, row["record_id"], row_count - 1))
                    frame_counts[frame_id] += 1
            if len(members_batch) >= 5000:
                con.executemany("INSERT INTO language_members VALUES (?,?,?,?,?,?,?)", members_batch)
                con.executemany("INSERT INTO language_frame_flags VALUES (?,?,?)", flags_batch)
                members_batch.clear()
                flags_batch.clear()
            if row_count % 100_000 == 0:
                print(f"indexed_language_rows={row_count:,}/904,447", flush=True)
    if members_batch:
        con.executemany("INSERT INTO language_members VALUES (?,?,?,?,?,?,?)", members_batch)
    if flags_batch:
        con.executemany("INSERT INTO language_frame_flags VALUES (?,?,?)", flags_batch)
    con.commit()
    if row_count != retained_count or row_count != 904_447:
        raise RuntimeError(f"Scored frame has {row_count:,} rows; expected {retained_count:,}")
    if observed_bands != {key: int(value) for key, value in expected_bands.items()}:
        raise RuntimeError(f"Scored CSV band totals mismatch: {observed_bands}")
    expected_frames = {
        "english_ge_90": int(manifest["cumulative_counts"]["ge90"]),
        "english_ge_80": int(manifest["cumulative_counts"]["ge80"]),
        "english_ge_50": int(manifest["cumulative_counts"]["ge50"]),
    }
    if frame_counts != expected_frames:
        raise RuntimeError(f"Cumulative language frame totals mismatch: {frame_counts}")

    missing_records = con.execute(
        "SELECT count(*) FROM language_members l LEFT JOIN active_index.records r ON r.id=l.record_id WHERE r.id IS NULL"
    ).fetchone()[0]
    missing_embedding_members = con.execute(
        "SELECT count(*) FROM language_members l LEFT JOIN embedding_index.members e "
        "ON e.record_id=l.record_id AND e.frame_id='embedding_near_verbatim' WHERE e.record_id IS NULL"
    ).fetchone()[0]
    if missing_records or missing_embedding_members:
        raise RuntimeError(f"Frame references missing records ({missing_records}) or nonmembers of the conservative embedding frame ({missing_embedding_members}).")

    for frame_id, (label, _bands) in FRAME_NAMES.items():
        con.execute("INSERT INTO frames VALUES (?,?,?)", (frame_id, label, frame_counts[frame_id]))
    metadata = {
        "schema_version": "1",
        "source_annotation_fingerprint": active_meta["fingerprint"],
        "source_annotation_records": active_meta["records"],
        "source_embedding_frame_id": "embedding_near_verbatim",
        "source_embedding_frame_records": str(source_candidate_count),
        "source_short_normalized_frame_records": str(retained_count),
        "short_normalized_exclusions": str(excluded_count),
        "source_scored_csv_sha256": actual_frame_hash,
        "source_score_sha256": manifest["score_input"]["sha256"],
        "language_model": "fastText lid.176.ftz",
        "language_model_sha256": "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83",
        "language_share_denominator": "alphabetic characters in segments with top-label fastText confidence >=0.80",
        "minimum_classified_coverage": "0.80",
        "minimum_alphabetic_characters": "20",
        "english_share_thresholds": "0.90,0.80,0.50",
    }
    con.executemany("INSERT INTO meta(key,value) VALUES (?,?)", metadata.items())
    integrity = con.execute("PRAGMA main.integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"Language frame sidecar integrity check failed: {integrity}")
    con.commit()
    con.execute("DETACH DATABASE embedding_index")
    con.execute("DETACH DATABASE active_index")
    con.close()
    os.replace(temp_db, output_db)
    return {
        "output": str(output_db),
        "source_rows": row_count,
        "band_counts": observed_bands,
        "frames": expected_frames,
        "missing_annotation_records": missing_records,
        "missing_conservative_embedding_members": missing_embedding_members,
        "integrity_check": integrity,
        "annotation_fingerprint": active_meta["fingerprint"],
        "scored_csv_sha256": actual_frame_hash,
        "sidecar_sha256": sha256_file(output_db),
    }


def finalize_staged(frame_csv: Path, manifest_path: Path, normalization_manifest_path: Path, output_db: Path) -> dict:
    """Validate and finish a complete staged sidecar without rereading its large CSV."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    normalization_manifest = json.loads(normalization_manifest_path.read_text(encoding="utf-8"))
    temp_db = output_db.with_suffix(output_db.suffix + ".tmp")
    if not temp_db.exists():
        raise RuntimeError(f"No staged sidecar exists at {temp_db}")
    actual_frame_hash = sha256_file(frame_csv)
    if actual_frame_hash != manifest.get("artifacts", {}).get("scored_frame", {}).get("sha256"):
        raise RuntimeError("The scored CSV does not match its manifest.")
    if (manifest["frame_input"].get("sha256") != normalization_manifest.get("outputs", {}).get("normalized_frame", {}).get("sha256")
            or int(manifest["frame_input"].get("rows", -1)) != int(normalization_manifest.get("normalization", {}).get("retained_rows", -2))):
        raise RuntimeError("The language pass does not match the short-normalized source frame.")

    con = sqlite3.connect(temp_db)
    con.execute("ATTACH DATABASE ? AS active_index", (f"file:{ANNOTATION_DB.resolve()}?mode=ro",))
    con.execute("ATTACH DATABASE ? AS embedding_index", (f"file:{EMBEDDING_DB.resolve()}?mode=ro",))
    active_meta = dict(con.execute("SELECT key,value FROM active_index.meta WHERE key IN ('fingerprint','records')"))
    embedding_meta = dict(con.execute("SELECT key,value FROM embedding_index.meta"))
    if (embedding_meta.get("schema_version") != "1"
            or embedding_meta.get("source_frame_fingerprint") != active_meta.get("fingerprint")):
        raise RuntimeError("The embedding sidecar does not match the active annotation index.")
    source_count = int(normalization_manifest["source_embedding_frame_records"])
    retained_count = int(normalization_manifest["normalization"]["retained_rows"])
    excluded_count = int(normalization_manifest["normalization"]["excluded_rows"])
    if (source_count != int(embedding_meta["embedding_near_verbatim_count"])
            or retained_count + excluded_count != source_count):
        raise RuntimeError("Short-normalized and embedding source counts do not reconcile.")
    if int(con.execute("SELECT count(*) FROM language_members").fetchone()[0]) != retained_count:
        raise RuntimeError("The staged language sidecar is incomplete.")
    expected_bands = {key: int(value) for key, value in manifest["band_counts"].items()}
    observed_bands = {key: int(value) for key, value in con.execute(
        "SELECT band,count(*) FROM language_members GROUP BY band")}
    if observed_bands != expected_bands:
        raise RuntimeError(f"Staged language band totals mismatch: {observed_bands}")
    frame_counts = {frame_id: int(value) for frame_id, value in con.execute(
        "SELECT frame_id,count(*) FROM language_frame_flags GROUP BY frame_id")}
    expected_frames = {
        "english_ge_90": int(manifest["cumulative_counts"]["ge90"]),
        "english_ge_80": int(manifest["cumulative_counts"]["ge80"]),
        "english_ge_50": int(manifest["cumulative_counts"]["ge50"]),
    }
    if frame_counts != expected_frames:
        raise RuntimeError(f"Staged cumulative frame totals mismatch: {frame_counts}")
    for frame_id, condition in {
        "english_ge_90": "l.band='90-100%'",
        "english_ge_80": "l.band IN ('90-100%','80-<90%')",
        "english_ge_50": "l.band IN ('90-100%','80-<90%','50-<80%')",
    }.items():
        mismatch = int(con.execute(
            "SELECT count(*) FROM language_members l LEFT JOIN language_frame_flags f "
            "ON f.record_id=l.record_id AND f.frame_id=? "
            f"WHERE ({condition}) != (f.record_id IS NOT NULL)", (frame_id,)
        ).fetchone()[0])
        if mismatch:
            raise RuntimeError(f"Staged frame membership differs from band assignments for {frame_id}: {mismatch}")

    missing_records = int(con.execute(
        "SELECT count(*) FROM language_members l LEFT JOIN active_index.records r ON r.id=l.record_id WHERE r.id IS NULL"
    ).fetchone()[0])
    missing_embedding_members = int(con.execute(
        "SELECT count(*) FROM language_members l LEFT JOIN embedding_index.members e "
        "ON e.record_id=l.record_id AND e.frame_id='embedding_near_verbatim' WHERE e.record_id IS NULL"
    ).fetchone()[0])
    if missing_records or missing_embedding_members:
        raise RuntimeError(f"Staged sidecar has missing source records ({missing_records}) or embedding members ({missing_embedding_members}).")
    if con.execute("SELECT count(*) FROM meta").fetchone()[0] or con.execute("SELECT count(*) FROM frames").fetchone()[0]:
        raise RuntimeError("Staged sidecar already has final metadata; refusing to overwrite it.")

    for frame_id, (label, _bands) in FRAME_NAMES.items():
        con.execute("INSERT INTO frames VALUES (?,?,?)", (frame_id, label, frame_counts[frame_id]))
    metadata = {
        "schema_version": "1",
        "source_annotation_fingerprint": active_meta["fingerprint"],
        "source_annotation_records": active_meta["records"],
        "source_embedding_frame_id": "embedding_near_verbatim",
        "source_embedding_frame_records": str(source_count),
        "source_short_normalized_frame_records": str(retained_count),
        "short_normalized_exclusions": str(excluded_count),
        "source_scored_csv_sha256": actual_frame_hash,
        "source_score_sha256": manifest["score_input"]["sha256"],
        "language_model": "fastText lid.176.ftz",
        "language_model_sha256": "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83",
        "language_share_denominator": "alphabetic characters in segments with top-label fastText confidence >=0.80",
        "minimum_classified_coverage": "0.80",
        "minimum_alphabetic_characters": "20",
        "english_share_thresholds": "0.90,0.80,0.50",
    }
    con.executemany("INSERT INTO meta(key,value) VALUES (?,?)", metadata.items())
    integrity = con.execute("PRAGMA main.integrity_check").fetchone()[0]
    if integrity != "ok":
        con.rollback()
        raise RuntimeError(f"Language frame sidecar integrity check failed: {integrity}")
    con.commit()
    con.execute("DETACH DATABASE embedding_index")
    con.execute("DETACH DATABASE active_index")
    con.close()
    os.replace(temp_db, output_db)
    return {
        "output": str(output_db),
        "source_rows": retained_count,
        "band_counts": observed_bands,
        "frames": expected_frames,
        "missing_annotation_records": missing_records,
        "missing_conservative_embedding_members": missing_embedding_members,
        "integrity_check": integrity,
        "annotation_fingerprint": active_meta["fingerprint"],
        "scored_csv_sha256": actual_frame_hash,
        "sidecar_sha256": sha256_file(output_db),
        "resumed_from_staged_sidecar": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frame-csv", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--normalization-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=OUTPUT_DB)
    parser.add_argument("--finalize-staged", action="store_true", help="Validate and finalize a complete .tmp sidecar from an interrupted build.")
    args = parser.parse_args()
    result = (finalize_staged(args.frame_csv, args.manifest, args.normalization_manifest, args.output)
              if args.finalize_staged else build(args.frame_csv, args.manifest, args.normalization_manifest, args.output))
    report_path = args.output.with_suffix(".manifest.json")
    report_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
