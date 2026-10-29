#!/usr/bin/env python3
"""Build a compact message-to-cluster index beside the annotation SQLite DB.

The large annotation index is opened read-only by request workers.  This script
joins the screening duplicate maps to that index and atomically writes a small
sidecar keyed by annotation-record ordinal.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RECORDS_DB = DATA / "annotation-index.sqlite"
OUTPUT_DB = DATA / "duplicate-groups.sqlite"
FIRST_MESSAGE_DB = DATA / "first-message-index.sqlite"


def _unique_scope_count(output: sqlite3.Connection, source: str, condition: str) -> int:
    raw, duplicate_members, represented_clusters = output.execute(f"""
      SELECT count(*),count(m.ordinal),count(DISTINCT m.cluster_id)
      FROM {source}
      LEFT JOIN members m ON m.ordinal=r.ordinal
      WHERE {condition}
    """).fetchone()
    return int(raw) - int(duplicate_members) + int(represented_clusters)


def build(duplicate_map_dir: Path) -> None:
    map_files = sorted(duplicate_map_dir.glob("*.parquet"))
    if not map_files:
        raise ValueError(f"No duplicate-map Parquet files found in {duplicate_map_dir}")
    summary_path = duplicate_map_dir.parent / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else {}
    expected_shards = summary.get("shards")
    expected_names = {
        item if isinstance(item, str) else Path(item.get("source_shard", item.get("name", ""))).stem
        for item in expected_shards or []
    }
    if expected_names and {path.stem for path in map_files} != expected_names:
        raise ValueError("Duplicate-map shards do not match the screening summary")

    out_tmp = OUTPUT_DB.with_suffix(".sqlite.tmp")
    out_tmp.unlink(missing_ok=True)
    source = sqlite3.connect(f"file:{RECORDS_DB}?mode=ro", uri=True)
    source.execute("PRAGMA cache_size=-65536")
    source.execute("PRAGMA temp_store=FILE")
    source_meta = dict(source.execute("SELECT key,value FROM meta"))
    source_fingerprint = source_meta.get("fingerprint", "")
    if not source_fingerprint:
        raise ValueError("Annotation index is missing its frame fingerprint")

    output = sqlite3.connect(out_tmp)
    output.execute("PRAGMA journal_mode=OFF")
    output.execute("PRAGMA synchronous=OFF")
    output.execute("PRAGMA temp_store=FILE")
    output.executescript("""
      CREATE TABLE members(
        ordinal INTEGER PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        source_shard TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX members_cluster_order ON members(cluster_id,ordinal);
      CREATE TABLE clusters(cluster_id TEXT PRIMARY KEY,member_count INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    """)
    source.execute("CREATE TEMP TABLE duplicate_keys(source_shard TEXT,conversation_id TEXT,turn_index INTEGER,cluster_id TEXT,PRIMARY KEY(source_shard,conversation_id,turn_index)) WITHOUT ROWID")
    batch_size = 20000
    source_rows = 0
    matched_rows = 0
    try:
        for path in map_files:
            parquet = pq.ParquetFile(path)
            for batch in parquet.iter_batches(
                batch_size=batch_size,
                columns=["conversation_hash", "turn_index", "duplicate_cluster_id"],
            ):
                keys = [
                    (path.stem, row["conversation_hash"], int(row["turn_index"]), row["duplicate_cluster_id"])
                    for row in batch.to_pylist()
                    if row.get("duplicate_cluster_id")
                ]
                if not keys:
                    continue
                source_rows += len(keys)
                source.executemany("INSERT OR IGNORE INTO duplicate_keys VALUES(?,?,?,?)", keys)
                joined = source.execute("""
                    SELECT r.ordinal,k.cluster_id,r.source_shard,r.conversation_id,r.turn_index
                    FROM duplicate_keys k CROSS JOIN records r INDEXED BY records_conversation
                    WHERE r.conversation_id=k.conversation_id
                      AND r.turn_index=k.turn_index
                      AND r.source_shard=k.source_shard
                """).fetchall()
                output.executemany("INSERT OR IGNORE INTO members VALUES(?,?,?,?,?)", joined)
                matched_rows += len(joined)
                source.execute("DELETE FROM duplicate_keys")
            print(f"Indexed {path.stem}", flush=True)
        if source_rows != matched_rows:
            raise ValueError(f"Matched {matched_rows:,} of {source_rows:,} duplicate-map rows")
        output.execute("INSERT INTO clusters SELECT cluster_id,count(*) FROM members GROUP BY cluster_id")
        clusters, members = output.execute("SELECT count(*),coalesce(sum(member_count),0) FROM clusters").fetchone()
        expected_duplicates = summary.get("duplicates", {}).get("duplicate_turns")
        expected_clusters = summary.get("duplicates", {}).get("duplicate_clusters")
        if expected_duplicates is not None and members != int(expected_duplicates):
            raise ValueError(f"Built {members:,} members; summary reports {int(expected_duplicates):,}")
        if expected_clusters is not None and clusters != int(expected_clusters):
            raise ValueError(f"Built {clusters:,} clusters; summary reports {int(expected_clusters):,}")
        records = int(source_meta.get("records", 0))
        output.executemany("INSERT INTO meta VALUES(?,?)", [
            ("fingerprint", source_fingerprint),
            ("records", str(records)),
            ("duplicate_members", str(members)),
            ("duplicate_clusters", str(clusters)),
            ("unique_entries", str(records - members + clusters)),
            ("snapshot", str(summary.get("snapshot", ""))),
        ])

        # Keep sidebar counts consistent with unique browsing. The counts are
        # recomputed within each selected stratum, so a duplicate group with
        # members on both sides of a stratum boundary can count once in each.
        output.execute("ATTACH DATABASE ? AS frame_index", (f"file:{RECORDS_DB}?mode=ro",))
        message_counts = {
            "unique_message_positive": _unique_scope_count(
                output, "frame_index.records r", "(r.filter_mask & 15) != 0"),
            "unique_message_negative": _unique_scope_count(
                output, "frame_index.records r", "(r.filter_mask & 15) = 0"),
        }
        first_message_counts = {}
        if FIRST_MESSAGE_DB.exists():
            output.execute("ATTACH DATABASE ? AS first_message_index", (f"file:{FIRST_MESSAGE_DB}?mode=ro",))
            first_meta = dict(output.execute("SELECT key,value FROM first_message_index.meta"))
            if first_meta.get("fingerprint") != source_fingerprint:
                raise ValueError("First-message index does not match the annotation frame")
            first_source = (
                "frame_index.records r JOIN first_message_index.first_messages f "
                "ON f.ordinal=r.ordinal"
            )
            first_message_counts = {
                "unique_first_message_positive": _unique_scope_count(
                    output, first_source, "f.has_person_signal=1"),
                "unique_first_message_negative": _unique_scope_count(
                    output, first_source, "f.has_person_signal=0"),
            }
        output.executemany("INSERT INTO meta VALUES(?,?)", [
            (key, str(value)) for key, value in {**message_counts, **first_message_counts}.items()
        ])
        output.commit()
    finally:
        source.close()
        output.close()
    os.replace(out_tmp, OUTPUT_DB)
    print(json.dumps({
        "records": int(source_meta.get("records", 0)),
        "duplicate_members": matched_rows,
        "duplicate_clusters": clusters,
        "unique_entries": records - members + clusters,
        "output": str(OUTPUT_DB),
    }, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duplicate-map-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        build(args.duplicate_map_dir.resolve())
    except Exception as error:
        print(f"duplicate group index build failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
