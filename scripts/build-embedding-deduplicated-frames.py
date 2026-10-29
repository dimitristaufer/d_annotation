#!/usr/bin/env python3
"""Build three source-ordered CTP candidate frames from embedding neighbor edges."""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


FRAMES = (
    ("embedding_sensitivity", 0.995),
    ("embedding_primary", 0.999),
    ("embedding_near_verbatim", 0.9999),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    run_dir = root.parent / "Prescreening" / "embedding_near_duplicates_20261026"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--similarities-db", type=Path, default=root / "data" / "embedding-similarities.sqlite")
    parser.add_argument("--similarity-manifest", type=Path, default=run_dir / "annotation_tool_sidecar_manifest.json")
    parser.add_argument("--row-map", type=Path, default=run_dir / "row_map.csv.gz")
    parser.add_argument("--paper-frame-db", type=Path, default=root / "data" / "paper-first-message-frame.sqlite")
    parser.add_argument("--annotation-index-db", type=Path, default=root / "data" / "annotation-index.sqlite")
    parser.add_argument("--output", type=Path, default=root / "data" / "embedding-deduplicated-frames.sqlite")
    return parser.parse_args()


def validate_sources(args: argparse.Namespace, source: sqlite3.Connection) -> tuple[dict[str, str], int]:
    manifest = json.loads(args.similarity_manifest.read_text(encoding="utf-8"))
    if sha256_file(args.similarities_db) != manifest.get("sha256"):
        raise ValueError("The similarity sidecar checksum does not match its saved manifest.")

    source.execute("ATTACH DATABASE ? AS paper_frame", (f"file:{args.paper_frame_db.resolve()}?mode=ro",))
    source.execute("ATTACH DATABASE ? AS active_index", (f"file:{args.annotation_index_db.resolve()}?mode=ro",))
    similarity_meta = dict(source.execute("SELECT key,value FROM meta"))
    paper_meta = dict(source.execute("SELECT key,value FROM paper_frame.meta"))
    index_meta = dict(source.execute("SELECT key,value FROM active_index.meta WHERE key='fingerprint'"))
    fingerprint = manifest.get("frame_fingerprint")
    if (similarity_meta.get("schema_version") != "1"
            or similarity_meta.get("source_frame_fingerprint") != fingerprint
            or paper_meta.get("input_fingerprint") != fingerprint
            or index_meta.get("fingerprint") != fingerprint):
        raise ValueError("The similarity, paper-frame, and annotation indexes do not share one frame fingerprint.")

    count = int(source.execute("SELECT count(*) FROM record_map").fetchone()[0])
    paper_count = int(source.execute("""SELECT count(*) FROM paper_frame.first_messages
        WHERE has_person_signal=1 AND is_representative=1""").fetchone()[0])
    matched = int(source.execute("""SELECT count(*) FROM record_map r
        JOIN paper_frame.first_messages f ON f.record_id=r.record_id
        WHERE f.has_person_signal=1 AND f.is_representative=1""").fetchone()[0])
    invalid = int(source.execute("""SELECT count(*) FROM record_map r
        LEFT JOIN paper_frame.first_messages f ON f.record_id=r.record_id
        WHERE f.record_id IS NULL OR f.has_person_signal!=1 OR f.is_representative!=1""").fetchone()[0])
    if count != int(manifest.get("source_records", -1)) or count != paper_count or count != matched or invalid:
        raise ValueError(f"Embedding IDs do not match the signal-positive paper frame: {count=}, {paper_count=}, {matched=}, {invalid=}.")

    cursor = iter(source.execute("SELECT row_index,record_id FROM record_map ORDER BY row_index"))
    previous_source_position: tuple[str, int] | None = None
    with gzip.open(args.row_map, "rt", newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        for expected_row, row in enumerate(reader):
            index, record_id = next(cursor, (None, None))
            position = (row["source_shard"], int(row["source_row"]))
            if index != expected_row or int(row["row_index"]) != expected_row or record_id != row["record_id"]:
                raise ValueError(f"The row map and similarity sidecar disagree at source row {expected_row}.")
            if previous_source_position is not None and position <= previous_source_position:
                raise ValueError("The embedding row map is not in strictly increasing source order.")
            previous_source_position = position
    if next(cursor, None) is not None:
        raise ValueError("The row map ended before the similarity sidecar record map.")
    return similarity_meta, count


def main() -> int:
    args = parse_args()
    for path in (args.similarities_db, args.similarity_manifest, args.row_map,
                 args.paper_frame_db, args.annotation_index_db):
        if not path.is_file():
            raise FileNotFoundError(path)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    source = sqlite3.connect(f"file:{args.similarities_db.resolve()}?mode=ro", uri=True)
    source.execute("PRAGMA query_only=ON")
    similarity_meta, record_count = validate_sources(args, source)
    blocked = {frame_id: bytearray(record_count) for frame_id, _ in FRAMES}
    edge_cursor = iter(source.execute("SELECT left_index,right_index,cosine_similarity FROM pairs ORDER BY left_index,right_index"))
    edge = next(edge_cursor, None)
    edges_processed = 0
    for left in range(record_count):
        is_representative = {frame_id: not flags[left] for frame_id, flags in blocked.items()}
        while edge is not None and edge[0] == left:
            edge_left, right, score = edge
            if not (0 <= edge_left < right < record_count and 0.0 <= score <= 1.0):
                raise ValueError(f"Invalid similarity edge: {edge}")
            for frame_id, threshold in FRAMES:
                if is_representative[frame_id] and score >= threshold:
                    blocked[frame_id][right] = 1
            edges_processed += 1
            if edges_processed % 2_000_000 == 0:
                print(f"clustered {edges_processed:,} candidate pairs", flush=True)
            edge = next(edge_cursor, None)
    if edge is not None:
        raise ValueError(f"Unexpected edge after final row: {edge}")
    source_counts = int(similarity_meta["unique_undirected_pairs_ge_0_995"])
    if edges_processed != source_counts:
        raise ValueError(f"Expected {source_counts:,} source pairs; processed {edges_processed:,}.")

    output = args.output.resolve()
    staged = output.with_name(output.name + ".incoming")
    if staged.exists():
        staged.unlink()
    out = sqlite3.connect(staged)
    out.execute("PRAGMA journal_mode=OFF")
    out.execute("PRAGMA synchronous=OFF")
    out.executescript("""
        CREATE TABLE frames(
            frame_id TEXT PRIMARY KEY, cosine_cutoff REAL NOT NULL,
            input_records INTEGER NOT NULL, retained_records INTEGER NOT NULL,
            removed_records INTEGER NOT NULL, representative_rule TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE members(
            frame_id TEXT NOT NULL, row_index INTEGER NOT NULL, record_id TEXT NOT NULL,
            PRIMARY KEY(frame_id,row_index), UNIQUE(frame_id,record_id)
        ) WITHOUT ROWID;
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    """)
    id_cursor = iter(source.execute("SELECT row_index,record_id FROM record_map ORDER BY row_index"))
    insert_rows: list[tuple[str, int, str]] = []
    counts = {frame_id: 0 for frame_id, _ in FRAMES}
    for row_index in range(record_count):
        actual_index, record_id = next(id_cursor, (None, None))
        if actual_index != row_index:
            raise ValueError(f"Non-contiguous embedding row map at {row_index}.")
        for frame_id, _threshold in FRAMES:
            if not blocked[frame_id][row_index]:
                counts[frame_id] += 1
                insert_rows.append((frame_id, row_index, record_id))
        if len(insert_rows) >= 50_000:
            out.executemany("INSERT INTO members VALUES (?,?,?)", insert_rows)
            insert_rows.clear()
    if insert_rows:
        out.executemany("INSERT INTO members VALUES (?,?,?)", insert_rows)

    rule = ("Independent source-ordered greedy representative selection per cutoff; retain a message only if it has no "
            "direct qualifying edge to an earlier retained representative. Removed messages do not suppress later messages.")
    for frame_id, threshold in FRAMES:
        retained = counts[frame_id]
        if not 0 < retained <= record_count:
            raise ValueError(f"Invalid retained count for {frame_id}: {retained}")
        out.execute("INSERT INTO frames VALUES (?,?,?,?,?,?)",
                    (frame_id, threshold, record_count, retained, record_count - retained, rule))

    source_sha = json.loads(args.similarity_manifest.read_text(encoding="utf-8"))["sha256"]
    output_meta = {
        "schema_version": "1",
        "source_frame_fingerprint": similarity_meta["source_frame_fingerprint"],
        "source_similarity_sha256": source_sha,
        "source_similarity_input_sha256": similarity_meta["source_input_sha256"],
        "source_records": str(record_count),
        "source_pairs_ge_0_995": str(edges_processed),
        "embedding_model": similarity_meta["embedding_model"],
        "embedding_revision": similarity_meta["embedding_revision"],
        "edge_semantics": similarity_meta["edge_semantics"],
        "coverage_warning": similarity_meta["coverage_warning"],
        "clustering_rule": rule,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    output_meta.update({f"{frame_id}_count": str(counts[frame_id]) for frame_id, _ in FRAMES})
    out.executemany("INSERT INTO meta VALUES (?,?)", output_meta.items())
    out.commit()
    integrity = out.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise ValueError(f"Output integrity check failed: {integrity}")
    for frame_id, _ in FRAMES:
        member_count = out.execute("SELECT count(*) FROM members WHERE frame_id=?", (frame_id,)).fetchone()[0]
        if member_count != counts[frame_id]:
            raise ValueError(f"Membership count mismatch for {frame_id}: {member_count} != {counts[frame_id]}.")
    out.close()
    source.close()
    os.replace(staged, output)

    digest = sha256_file(output)
    report = {
        "created_at_utc": output_meta["created_at_utc"],
        "output": str(output),
        "bytes": output.stat().st_size,
        "sha256": digest,
        "source_records": record_count,
        "source_pairs_ge_0_995": edges_processed,
        "representative_rule": rule,
        "coverage_warning": output_meta["coverage_warning"],
        "frames": {
            frame_id: {"cosine_cutoff_inclusive": threshold,
                       "retained_messages": counts[frame_id],
                       "removed_messages": record_count - counts[frame_id]}
            for frame_id, threshold in FRAMES
        },
        "integrity_check": integrity,
    }
    report_path = output.with_suffix(".manifest.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
