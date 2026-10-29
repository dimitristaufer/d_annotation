#!/usr/bin/env python3
"""Build a first-requester-message paper frame without changing existing data.

The builder reads the completed recovered prescreen Parquets and the active
annotation-index metadata read-only. It writes a new SQLite sidecar and three
CSV files: the two deduplicated person-signal strata and a duplicate-exclusion
audit. No existing annotation index or annotation store is modified.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import shutil
import sqlite3
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq


APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
DEFAULT_INPUT = ROOT / "Prescreening/runpod_a100_20261012/wildchat_screening_v1_coref_recovered"
DEFAULT_INDEX = APP / "data/annotation-index.sqlite"
DEFAULT_OUTPUT = APP / "data/paper-first-message-frame.sqlite"
DEFAULT_CSV_DIR = ROOT.parent / "LaTex/supplement/wildchat_frame"
DATASET = "allenai/WildChat-4.8M"
DATASET_REVISION = "c827c6df8fcf008219ffaffa4d1dd77491099367"
RETRIEVED_AT = "2026-08-18"
DATA_THROUGH = "2025-07-31"


def iter_first_messages(input_dir: Path, resume_after: tuple[str, int, str] | None = None):
    """Yield first nonempty English requester messages in source order."""
    columns = ["conversation_hash", "turn_index", "requester_turn_index", "is_first_user_turn",
               "source_shard", "source_conversation_id", "source_row", "language", "sample_key",
               "text", "char_count", "word_count", "embedded_content_candidate", "long_turn",
               "person_ner_hits_json", "person_noun_hits_json", "person_pronoun_hits_json",
               "has_person_reference", "has_coref", "coref_cluster_count", "exact_sha256",
               "coref_mentions_json"]
    for path in sorted((input_dir / "requester_messages").glob("*.parquet")):
        if resume_after and path.stem < resume_after[0]:
            continue
        pf = pq.ParquetFile(path)
        shard_rows = []
        for batch in pf.iter_batches(batch_size=20_000, columns=columns):
            for row in batch.to_pylist():
                text = row.get("text") or ""
                if (row.get("is_first_user_turn") and row.get("language") in ("English", "en")
                        and text.strip()):
                    shard_rows.append(row)
        shard_rows.sort(key=lambda row: (int(row["source_row"]), int(row["turn_index"]), str(row["conversation_hash"])))
        boundary_found = False
        for row in shard_rows:
            if resume_after and path.stem == resume_after[0] and int(row["source_row"]) <= resume_after[1]:
                if int(row["source_row"]) == resume_after[1]:
                    record_id = f"{row['source_shard']}:{row['sample_key']}"
                    if record_id != resume_after[2]:
                        raise RuntimeError("The saved frame checkpoint does not match the source-row boundary.")
                    boundary_found = True
                continue
            yield row
        if resume_after and path.stem == resume_after[0] and not boundary_found:
            raise RuntimeError("The saved frame checkpoint row was not found in the source Parquet.")


def input_validation(input_dir: Path, source_index: Path) -> tuple[dict, dict]:
    run_summary = json.loads((input_dir / "summary.json").read_text(encoding="utf-8"))
    index_summary = json.loads((APP / "data/summary.json").read_text(encoding="utf-8"))
    if run_summary.get("dataset_revision") != DATASET_REVISION:
        raise RuntimeError("The recovered prescreen Parquets are not from the pinned WildChat revision.")
    expected_shards = {Path(item["source_shard"]).stem for item in run_summary.get("shards", [])}
    found_sets = [{path.stem for path in (input_dir / name).glob("*.parquet")}
                  for name in ("conversations", "all_turns", "requester_messages")]
    if len(expected_shards) != 86 or any(shards != expected_shards for shards in found_sets):
        raise RuntimeError("The recovered prescreen directory does not contain the same complete 86 shards in all tables.")
    if index_summary.get("inputFingerprint") != run_summary.get("inputFingerprint", index_summary.get("inputFingerprint")):
        # The run summary predates the derived annotation index and may not
        # carry the prepared-frame fingerprint. Shard and row checks below
        # still bind the two snapshots.
        pass
    db = sqlite3.connect(f"file:{source_index}?mode=ro", uri=True)
    index_meta = dict(db.execute("SELECT key,value FROM meta"))
    db.close()
    expected_records = sum(int(item.get("requester_turns", 0)) for item in run_summary["shards"])
    if (index_meta.get("snapshot") != "wildchat_screening_v1_coref_recovered"
            or index_meta.get("records") != str(expected_records)
            or index_meta.get("records") != str(index_summary.get("records"))
            or index_meta.get("fingerprint") != index_summary.get("inputFingerprint")):
        raise RuntimeError("The read-only annotation index does not match the completed recovered screening frame.")
    return run_summary, index_meta


def initialise(path: Path, input_fingerprint: str, run_summary: dict) -> sqlite3.Connection:
    path.unlink(missing_ok=True)
    Path(str(path) + "-wal").unlink(missing_ok=True)
    Path(str(path) + "-shm").unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA temp_store=FILE")
    db.execute("PRAGMA cache_size=-262144")
    db.executescript("""
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE first_messages(
        record_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,
        source_shard TEXT NOT NULL,source_row INTEGER NOT NULL,turn_index INTEGER NOT NULL,
        requester_turn_index INTEGER NOT NULL,has_person_signal INTEGER NOT NULL,
        exact_sha256 TEXT NOT NULL,simhash64 TEXT NOT NULL,char_length INTEGER NOT NULL,
        is_representative INTEGER NOT NULL,duplicate_kind TEXT NOT NULL,
        cluster_root_record_id TEXT NOT NULL,duplicate_of_record_id TEXT,
        near_char5_jaccard REAL,duplicate_cluster_id TEXT
      ) WITHOUT ROWID;
      CREATE INDEX first_messages_stratum_order ON first_messages(is_representative,has_person_signal,source_shard,source_row);
      CREATE INDEX first_messages_source_order ON first_messages(source_shard,source_row);
      CREATE INDEX first_messages_cluster ON first_messages(duplicate_cluster_id,source_shard,source_row);
      CREATE TABLE clusters(
        cluster_id TEXT PRIMARY KEY,root_record_id TEXT NOT NULL,member_count INTEGER NOT NULL,
        exact_duplicate_count INTEGER NOT NULL,near_duplicate_count INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX clusters_root_record ON clusters(root_record_id);
      CREATE TABLE members(
        record_id TEXT PRIMARY KEY,cluster_id TEXT NOT NULL,source_shard TEXT NOT NULL,
        source_row INTEGER NOT NULL,duplicate_kind TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX members_cluster_order ON members(cluster_id,source_shard,source_row);
      CREATE TABLE work_items(
        item_id INTEGER PRIMARY KEY,record_id TEXT NOT NULL,exact_sha TEXT NOT NULL,
        simhash TEXT NOT NULL,char_length INTEGER NOT NULL,cluster_root INTEGER NOT NULL,
        duplicate_kind TEXT NOT NULL,duplicate_of INTEGER,near_char5_jaccard REAL
      );
      CREATE INDEX work_items_sha ON work_items(exact_sha);
      CREATE INDEX work_items_root ON work_items(cluster_root);
    """)
    db.executemany("INSERT INTO meta VALUES(?,?)", [
        ("input_fingerprint", input_fingerprint), ("dataset", DATASET),
        ("dataset_revision", DATASET_REVISION), ("dataset_retrieved", RETRIEVED_AT),
        ("source_data_through", DATA_THROUGH),
        ("prescreen_completed_at", run_summary.get("completed_at", "")),
        ("deduplication_order", "source_shard ascending, source_row ascending"),
        ("exact_hash", "precomputed SHA-256 of complete UTF-8 target text with surrogatepass"),
        ("exact_duplicate_link", "exclude the first-message record only when complete target text repeats at turn index 0, so the annotation context through the target is identical"),
        ("approximate_duplicate_rule", "none; all non-exact first messages remain eligible, and embedding-similarity pairs are review-only"),
        ("representative_rule", "source-ordered; exclude only repeated exact target text at turn index 0, where the target has no preceding conversation context"),
        ("stratum_rule", "each retained target's own has_person_reference signal"),
    ])
    return db


def add_item(db: sqlite3.Connection, item_id: int, row: dict) -> tuple[bool, bool]:
    record_id = f"{row['source_shard']}:{row['sample_key']}"
    text = row["text"] or ""
    exact_sha = hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()
    source_exact_sha = row.get("exact_sha256")
    if source_exact_sha and source_exact_sha != exact_sha:
        raise RuntimeError(f"Source exact-text SHA-256 does not match the raw target text: {record_id}")
    char_length = len(text)
    simhash = ""
    # When a requester message has preceding turns, those turns are part of
    # the annotation input. Collapse exact target text only for turn index 0,
    # where both complete inputs consist of the same requester message.
    exact = None
    if int(row["turn_index"]) == 0:
        exact = db.execute("""SELECT w.item_id,w.cluster_root FROM work_items w
            JOIN first_messages f ON f.record_id=w.record_id
            WHERE w.exact_sha=? AND f.turn_index=0 AND f.is_representative=1
            ORDER BY w.item_id LIMIT 1""", (exact_sha,)).fetchone()
    root = item_id
    duplicate_of = None
    near_overlap = None
    kind = "representative"
    was_exact = False
    if exact:
        root = int(exact[0])
        duplicate_of = int(exact[0])
        kind = "exact_duplicate"
        was_exact = True
    db.execute("INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)",
               (item_id, record_id, exact_sha, simhash, char_length, root, kind, duplicate_of, near_overlap))
    signal = int(bool(row.get("has_person_reference")))
    duplicate_of_id = (db.execute("SELECT record_id FROM work_items WHERE item_id=?", (duplicate_of,)).fetchone()[0]
                       if duplicate_of is not None else None)
    is_screening_candidate = int(kind == "representative")
    db.execute("""INSERT INTO first_messages(
        record_id,conversation_id,source_conversation_id,source_shard,source_row,turn_index,
        requester_turn_index,has_person_signal,exact_sha256,simhash64,char_length,is_representative,
        duplicate_kind,cluster_root_record_id,duplicate_of_record_id,near_char5_jaccard,duplicate_cluster_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
               (record_id, row["conversation_hash"], row.get("source_conversation_id") or "",
                row["source_shard"], int(row["source_row"]), int(row["turn_index"]),
                int(row.get("requester_turn_index") or 0), signal, exact_sha, simhash,
                char_length, is_screening_candidate, kind, "", duplicate_of_id, near_overlap))
    # Store the representative record ID once the root row is available.
    if root == item_id:
        db.execute("UPDATE first_messages SET cluster_root_record_id=? WHERE record_id=?", (record_id, record_id))
    else:
        root_id = db.execute("SELECT record_id FROM work_items WHERE item_id=?", (root,)).fetchone()[0]
        db.execute("UPDATE first_messages SET cluster_root_record_id=? WHERE record_id=?", (root_id, record_id))
    return was_exact, False


def _resume_frame(temporary: Path, input_fingerprint: str):
    db = sqlite3.connect(temporary, uri=True)
    meta = dict(db.execute("SELECT key,value FROM meta"))
    if meta.get("input_fingerprint") != input_fingerprint or meta.get("dataset_revision") != DATASET_REVISION:
        db.close()
        raise RuntimeError("The saved frame checkpoint belongs to a different source or dataset revision.")
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        db.close()
        raise RuntimeError("The saved frame checkpoint failed SQLite integrity validation.")
    processed = int(db.execute("SELECT count(*) FROM first_messages").fetchone()[0])
    work = db.execute("SELECT count(*),min(item_id),max(item_id) FROM work_items").fetchone()
    if work != (processed, 1 if processed else None, processed if processed else None):
        db.close()
        raise RuntimeError(f"Checkpoint rows and work items do not form the expected prefix: {processed=}, {work=}.")
    if not processed:
        db.close()
        raise RuntimeError("The saved frame checkpoint has no completed rows.")
    last = db.execute("""SELECT f.source_shard,f.source_row,f.record_id
        FROM first_messages f WHERE f.record_id=(SELECT record_id FROM work_items WHERE item_id=?)""",
                      (processed,)).fetchone()
    if last is None:
        db.close()
        raise RuntimeError("Could not read the saved source-order checkpoint boundary.")
    if db.execute("SELECT count(*) FROM clusters").fetchone()[0]:
        db.close()
        raise RuntimeError("Cannot resume after duplicate clusters have been consolidated.")

    # Normalize the pre-release checkpoint from scratch. Build one indexed map
    # of repeated turn-zero text first, then apply direct links set-wise; avoid
    # a correlated scan of the full checkpoint for every row.
    db.executescript("""
      DROP TABLE IF EXISTS temp.resume_exact_roots;
      DROP TABLE IF EXISTS temp.resume_exact_duplicates;
      CREATE TEMP TABLE resume_exact_roots AS
        SELECT w.exact_sha,MIN(w.item_id) AS root_item_id
        FROM work_items w JOIN first_messages f ON f.record_id=w.record_id
        WHERE f.turn_index=0 GROUP BY w.exact_sha HAVING count(*)>1;
      CREATE UNIQUE INDEX temp.resume_exact_roots_sha ON resume_exact_roots(exact_sha);
      CREATE TEMP TABLE resume_exact_duplicates AS
        SELECT w.item_id,w.record_id,r.root_item_id,root.record_id AS root_record_id
        FROM work_items w JOIN first_messages f ON f.record_id=w.record_id
        JOIN resume_exact_roots r ON r.exact_sha=w.exact_sha
        JOIN work_items root ON root.item_id=r.root_item_id
        WHERE f.turn_index=0 AND w.item_id>r.root_item_id;
      CREATE UNIQUE INDEX temp.resume_exact_duplicates_item ON resume_exact_duplicates(item_id);
      CREATE UNIQUE INDEX temp.resume_exact_duplicates_record ON resume_exact_duplicates(record_id);
    """)
    safe_exact_duplicates = int(db.execute("SELECT count(*) FROM temp.resume_exact_duplicates").fetchone()[0])
    print(json.dumps({"stage": "checkpoint_safe_exact_groups", "rows": processed,
                      "safeExactExclusions": safe_exact_duplicates}), flush=True)
    db.execute("""UPDATE work_items SET cluster_root=item_id,duplicate_kind='representative',
        duplicate_of=NULL,near_char5_jaccard=NULL,simhash=''""")
    db.commit()
    print(json.dumps({"stage": "checkpoint_work_items_normalized"}), flush=True)
    db.execute("""UPDATE first_messages SET is_representative=1,duplicate_kind='representative',
        cluster_root_record_id=record_id,duplicate_of_record_id=NULL,near_char5_jaccard=NULL,
        duplicate_cluster_id=NULL,simhash64=''""")
    db.commit()
    print(json.dumps({"stage": "checkpoint_frame_rows_normalized"}), flush=True)
    db.execute("""UPDATE work_items AS w SET duplicate_kind='exact_duplicate',
        duplicate_of=(SELECT d.root_item_id FROM temp.resume_exact_duplicates d WHERE d.item_id=w.item_id),
        cluster_root=(SELECT d.root_item_id FROM temp.resume_exact_duplicates d WHERE d.item_id=w.item_id)
        WHERE w.item_id IN (SELECT item_id FROM temp.resume_exact_duplicates)""")
    db.execute("""UPDATE first_messages AS f SET is_representative=0,duplicate_kind='exact_duplicate',
        duplicate_of_record_id=(SELECT d.root_record_id FROM temp.resume_exact_duplicates d WHERE d.record_id=f.record_id),
        cluster_root_record_id=(SELECT d.root_record_id FROM temp.resume_exact_duplicates d WHERE d.record_id=f.record_id)
        WHERE f.record_id IN (SELECT record_id FROM temp.resume_exact_duplicates)""")
    db.commit()
    db.executescript("DROP TABLE temp.resume_exact_duplicates; DROP TABLE temp.resume_exact_roots;")
    for key in ("near_hash", "near_hash_implementation", "near_hamming_max", "near_length_ratio_min",
                "near_char5_jaccard_min", "near_min_normalized_chars", "near_simhash_sample_limit_chars",
                "near_candidate_index"):
        db.execute("DELETE FROM meta WHERE key=?", (key,))
    db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (
        "approximate_duplicate_rule", "none; all non-exact first messages remain eligible, and embedding-similarity pairs are review-only"))
    db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (
        "representative_rule", "source-ordered; exclude only repeated exact target text at turn index 0, where the target has no preceding conversation context"))
    db.commit()
    candidates = int(db.execute("SELECT count(*) FROM first_messages WHERE has_person_signal=1").fetchone()[0])
    exact_removed = int(db.execute("SELECT count(*) FROM first_messages WHERE duplicate_kind='exact_duplicate'").fetchone()[0])
    print(json.dumps({"stage": "resumed_frame_checkpoint", "processed": processed,
                      "personSignal": candidates, "exactDuplicates": exact_removed,
                      "approximateExclusions": 0}), flush=True)
    return db, processed, candidates, exact_removed, 0, tuple(last)


def build_frame(input_dir: Path, index_path: Path, output_path: Path, resume: bool = False) -> dict:
    run_summary, index_meta = input_validation(input_dir, index_path)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    if resume:
        db, total, candidates, exact_removed, near_removed, boundary = _resume_frame(
            temporary, index_meta["fingerprint"])
        resume_after = (boundary[0], int(boundary[1]), boundary[2])
    else:
        if temporary.exists():
            raise FileExistsError(f"A frame checkpoint already exists at {temporary}; pass --resume to continue it.")
        db = initialise(temporary, index_meta["fingerprint"], run_summary)
        total = candidates = exact_removed = near_removed = 0
        resume_after = None
    for row in iter_first_messages(input_dir, resume_after=resume_after):
        total += 1
        candidates += int(bool(row.get("has_person_reference")))
        exact, _ = add_item(db, total, row)
        exact_removed += int(exact)
        if total % 20_000 == 0:
            db.commit()
        if total % 100_000 == 0:
            print(json.dumps({"processed": total, "personSignal": candidates,
                              "exactDuplicates": exact_removed, "approximateExclusions": 0}), flush=True)

    print(json.dumps({"stage": "consolidating_duplicate_clusters", "firstMessages": total}), flush=True)
    db.execute("""INSERT INTO clusters
        SELECT printf('pf_%012d',root.item_id),root.record_id,COUNT(*),
               SUM(w.duplicate_kind='exact_duplicate'),SUM(w.duplicate_kind='near_duplicate')
        FROM work_items w JOIN work_items root ON root.item_id=w.cluster_root
        GROUP BY w.cluster_root HAVING COUNT(*)>1""")
    db.commit()
    print(json.dumps({"stage": "linking_duplicate_members"}), flush=True)
    db.execute("""INSERT INTO members
        SELECT f.record_id,c.cluster_id,f.source_shard,f.source_row,f.duplicate_kind
        FROM first_messages f JOIN clusters c ON c.root_record_id=f.cluster_root_record_id""")
    db.commit()
    print(json.dumps({"stage": "marking_cluster_ids"}), flush=True)
    db.execute("""UPDATE first_messages SET duplicate_cluster_id=(
        SELECT cluster_id FROM clusters WHERE root_record_id=first_messages.cluster_root_record_id)
        WHERE EXISTS (SELECT 1 FROM clusters WHERE root_record_id=first_messages.cluster_root_record_id)""")
    db.commit()
    retained = int(db.execute("SELECT COUNT(*) FROM first_messages WHERE is_representative=1").fetchone()[0])
    retained_signal = int(db.execute("SELECT COUNT(*) FROM first_messages WHERE is_representative=1 AND has_person_signal=1").fetchone()[0])
    retained_no_signal = retained - retained_signal
    clusters = int(db.execute("SELECT COUNT(*) FROM clusters").fetchone()[0])
    members = int(db.execute("SELECT COUNT(*) FROM members").fetchone()[0])
    exact_only = int(db.execute("SELECT COUNT(*) FROM clusters WHERE near_duplicate_count=0").fetchone()[0])
    counts = {
        "all_first_messages": total,
        "pre_dedup_person_signal": candidates,
        "pre_dedup_no_person_signal": total - candidates,
        "retained_first_messages": retained,
        "retained_person_signal": retained_signal,
        "retained_no_person_signal": retained_no_signal,
        "removed_duplicate_rows": exact_removed,
        "exact_duplicate_rows": exact_removed,
        "near_duplicate_rows": near_removed,
        "near_duplicate_candidate_rows": near_removed,
        "exact_text_repeat_rows": int(db.execute("SELECT COUNT(*) FROM work_items").fetchone()[0]) -
                                  int(db.execute("SELECT COUNT(DISTINCT exact_sha) FROM work_items").fetchone()[0]),
        "exact_text_repeat_rows_retained_for_context": int(db.execute("SELECT COUNT(*) FROM work_items").fetchone()[0]) -
                                                       int(db.execute("SELECT COUNT(DISTINCT exact_sha) FROM work_items").fetchone()[0]) - exact_removed,
        "duplicate_clusters": clusters,
        "duplicate_cluster_members": members,
        "exact_only_clusters": exact_only,
        "mixed_or_near_clusters": 0,
    }
    db.executemany("INSERT INTO meta VALUES(?,?)", [(key, str(value)) for key, value in counts.items()])

    approximate_exclusions = int(db.execute(
        "SELECT count(*) FROM first_messages WHERE duplicate_kind='near_duplicate' OR is_representative=0 AND duplicate_kind!='exact_duplicate'"
    ).fetchone()[0])
    if approximate_exclusions:
        raise RuntimeError(f"Approximate matches affected CTP eligibility: {approximate_exclusions:,} rows.")
    invalid_exact = int(db.execute("""
        SELECT count(*) FROM first_messages f
        LEFT JOIN first_messages d ON d.record_id=f.duplicate_of_record_id
        JOIN first_messages r ON r.record_id=f.cluster_root_record_id
        WHERE f.duplicate_kind='exact_duplicate'
          AND (d.record_id IS NULL OR d.exact_sha256!=f.exact_sha256
               OR (d.source_shard,d.source_row)>=(f.source_shard,f.source_row)
               OR r.is_representative!=1)
    """).fetchone()[0])
    if invalid_exact:
        raise RuntimeError(f"{invalid_exact} exact-duplicate assignments do not match their representative SHA-256.")
    invalid_cluster_sizes = int(db.execute("""
        SELECT count(*) FROM (
          SELECT c.cluster_id FROM clusters c LEFT JOIN members m ON m.cluster_id=c.cluster_id
          GROUP BY c.cluster_id HAVING c.member_count!=count(m.record_id)
        )
    """).fetchone()[0])
    if invalid_cluster_sizes:
        raise RuntimeError(f"{invalid_cluster_sizes} duplicate clusters have inconsistent member counts.")
    invalid_duplicate_links = int(db.execute("""
        SELECT count(*) FROM first_messages f
        LEFT JOIN first_messages d ON d.record_id=f.duplicate_of_record_id
        WHERE (f.duplicate_kind='representative' AND f.duplicate_of_record_id IS NOT NULL)
    """).fetchone()[0])
    if invalid_duplicate_links:
        raise RuntimeError(f"{invalid_duplicate_links} duplicate provenance links are invalid.")

    distinct_raw_texts = int(db.execute("SELECT COUNT(DISTINCT exact_sha) FROM work_items").fetchone()[0])
    db.executescript("DROP TABLE work_items;")
    db.commit()
    db.close()
    temporary.replace(output_path)
    if counts["exact_text_repeat_rows"] != total - distinct_raw_texts:
        raise RuntimeError("Repeated exact-text count does not match distinct recomputed full-text SHA-256 values.")
    if exact_removed != total - retained:
        raise RuntimeError("Safe exact-duplicate removals do not reconcile with CTP-screening frame membership.")
    return counts


CSV_COLUMNS = [
    "paper_stratum", "record_id", "conversation_id", "source_conversation_id", "source_shard",
    "source_row", "sample_key", "turn_index", "requester_turn_index", "language", "target_text",
    "context_prefix_json", "person_reference_signal", "person_name_signal", "person_noun_signal",
    "person_pronoun_signal", "coreference_signal", "embedded_content_signal", "long_turn",
    "person_names_json", "person_nouns_json", "person_pronouns_json",
    "coreference_mentions_json", "conversation_signals_json", "conversation_has_candidate",
    "conversation_candidate_stratum", "coref_status", "coref_invalid_spans", "target_characters", "target_words",
    "conversation_turns", "coreference_cluster_count", "coreference_mention_count", "requester_words",
    "coreference_mentions_per_100_words", "exact_text_sha256", "is_dedup_representative",
    "is_ctp_screening_candidate",
    "duplicate_kind", "duplicate_of_record_id", "duplicate_cluster_id", "duplicate_cluster_size", "representative_record_id",
]


def json_field(value):
    if value in (None, ""):
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return parsed if isinstance(parsed, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def export_csvs(input_dir: Path, frame_path: Path, csv_dir: Path) -> dict:
    csv_dir.mkdir(parents=True, exist_ok=True)
    frame = sqlite3.connect(f"file:{frame_path}?mode=ro", uri=True)
    frame.row_factory = sqlite3.Row
    counts = {"first_messages_with_person_reference_signals.csv": 0,
              "first_messages_without_person_reference_signals.csv": 0,
              "first_message_duplicate_exclusions.csv": 0}
    handles = {}
    writers = {}
    paths = {}
    for filename in counts:
        path = csv_dir / filename
        temp = path.with_suffix(path.suffix + ".tmp")
        handle = temp.open("w", encoding="utf-8", newline="")
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, lineterminator="\n", extrasaction="ignore")
        writer.writeheader()
        handles[filename] = handle
        writers[filename] = writer
        paths[filename] = (temp, path)

    target_columns = ["conversation_hash", "turn_index", "requester_turn_index", "is_first_user_turn",
                      "source_shard", "source_conversation_id", "source_row", "language", "sample_key",
                      "text", "char_count", "word_count", "embedded_content_candidate", "long_turn",
                      "person_ner_count", "has_person_ner", "person_ner_hits_json", "person_noun_hits_json",
                      "person_pronoun_hits_json", "has_person_reference", "has_coref", "coref_cluster_count",
                      "exact_sha256", "coref_mentions_json",
                      "conversation_has_candidate", "candidate_stratum"]
    for path in sorted((input_dir / "requester_messages").glob("*.parquet")):
        shard = path.stem
        # Small per-shard maps keep memory bounded while attaching stable IDs
        # and duplicate decisions from the exact sidecar used by the UI.
        frame_rows = frame.execute("""SELECT f.*,c.member_count,root.record_id AS representative_record_id
            FROM first_messages f
            LEFT JOIN clusters c ON c.cluster_id=f.duplicate_cluster_id
            JOIN first_messages root ON root.record_id=f.cluster_root_record_id
            WHERE f.source_shard=? ORDER BY f.source_row""", (shard,)).fetchall()
        frame_by_id = {row["record_id"]: row for row in frame_rows}
        first_targets = []
        target_turns = {}
        for batch in pq.ParquetFile(path).iter_batches(batch_size=20_000, columns=target_columns):
            for row in batch.to_pylist():
                text = row.get("text") or ""
                if not row.get("is_first_user_turn") or row.get("language") not in ("English", "en") or not text.strip():
                    continue
                record_id = f"{row['source_shard']}:{row['sample_key']}"
                metadata = frame_by_id.get(record_id)
                if metadata is None:
                    raise RuntimeError(f"First requester target is missing from paper frame: {record_id}")
                row["record_id"] = record_id
                first_targets.append((row, metadata))
                target_turns[row["conversation_hash"]] = int(row["turn_index"])
        first_targets.sort(key=lambda item: (int(item[0]["source_row"]), int(item[0]["turn_index"])))

        conversation_path = input_dir / "conversations" / path.name
        conversation_columns = ["conversation_hash", "num_turns", "num_requester_turns", "person_ner_signal",
                               "person_noun_signal", "person_pronoun_signal", "coref_person_signal",
                               "conversation_has_candidate", "candidate_stratum", "has_embedded_content",
                               "has_template_duplicate", "num_candidate_turns", "coref_status", "coref_invalid_spans",
                               "total_requester_words"]
        conversation_meta = {}
        for batch in pq.ParquetFile(conversation_path).iter_batches(batch_size=20_000, columns=conversation_columns):
            for row in batch.to_pylist():
                if row["conversation_hash"] in target_turns:
                    conversation_meta[row["conversation_hash"]] = row
        turn_path = input_dir / "all_turns" / path.name
        contexts = defaultdict(list)
        for batch in pq.ParquetFile(turn_path).iter_batches(
                batch_size=20_000, columns=["conversation_hash", "turn_index", "role", "text"]):
            for turn in batch.to_pylist():
                stop = target_turns.get(turn["conversation_hash"])
                if stop is not None and int(turn["turn_index"]) <= stop:
                    contexts[turn["conversation_hash"]].append({
                        "role": turn["role"], "turn_index": int(turn["turn_index"]), "text": turn["text"] or ""})

        missing_context = [row["conversation_hash"] for row, _ in first_targets
                           if not contexts.get(row["conversation_hash"])
                           or contexts[row["conversation_hash"]][-1]["turn_index"] != int(row["turn_index"])
                           or contexts[row["conversation_hash"]][-1]["text"] != (row.get("text") or "")]
        if missing_context:
            raise RuntimeError(f"Conversation prefix reconstruction failed for {len(missing_context)} first messages in {shard}.")

        for row, meta in first_targets:
            conversation = conversation_meta.get(row["conversation_hash"], {})
            signal = int(bool(row.get("has_person_reference")))
            is_rep = int(meta["is_representative"])
            if is_rep:
                filename = ("first_messages_with_person_reference_signals.csv" if signal
                            else "first_messages_without_person_reference_signals.csv")
            else:
                filename = "first_message_duplicate_exclusions.csv"
            context = sorted(contexts.get(row["conversation_hash"], []), key=lambda turn: turn["turn_index"])
            record = {
                "paper_stratum": "with_person_reference_signal" if signal else "without_person_reference_signal",
                "record_id": row["record_id"], "conversation_id": row["conversation_hash"],
                "source_conversation_id": row.get("source_conversation_id"), "source_shard": row["source_shard"],
                "source_row": row["source_row"], "sample_key": row["sample_key"],
                "turn_index": row["turn_index"], "requester_turn_index": row["requester_turn_index"],
                "language": row["language"], "target_text": row["text"],
                "context_prefix_json": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
                "person_reference_signal": signal, "person_name_signal": int(bool(row.get("has_person_ner"))),
                "person_noun_signal": int(bool(json_field(row.get("person_noun_hits_json")))),
                "person_pronoun_signal": int(bool(json_field(row.get("person_pronoun_hits_json")))),
                "coreference_signal": int(bool(row.get("has_coref"))),
                "embedded_content_signal": int(bool(row.get("embedded_content_candidate"))),
                "long_turn": int(bool(row.get("long_turn"))),
                "person_names_json": json.dumps(json_field(row.get("person_ner_hits_json")), ensure_ascii=False, separators=(",", ":")),
                "person_nouns_json": json.dumps(json_field(row.get("person_noun_hits_json")), ensure_ascii=False, separators=(",", ":")),
                "person_pronouns_json": json.dumps(json_field(row.get("person_pronoun_hits_json")), ensure_ascii=False, separators=(",", ":")),
                "coreference_mentions_json": json.dumps(json_field(row.get("coref_mentions_json")), ensure_ascii=False, separators=(",", ":")),
                "conversation_signals_json": json.dumps({key: conversation.get(key) for key in (
                    "person_ner_signal", "person_noun_signal", "person_pronoun_signal", "coref_person_signal",
                    "has_embedded_content")}, ensure_ascii=False, separators=(",", ":")),
                "conversation_has_candidate": row.get("conversation_has_candidate"),
                "conversation_candidate_stratum": row.get("candidate_stratum"),
                "coref_status": conversation.get("coref_status"), "coref_invalid_spans": conversation.get("coref_invalid_spans"),
                "target_characters": row.get("char_count"), "target_words": row.get("word_count"),
                "conversation_turns": conversation.get("num_turns"),
                "coreference_cluster_count": row.get("coref_cluster_count"),
                "coreference_mention_count": len(json_field(row.get("coref_mentions_json"))),
                "requester_words": conversation.get("total_requester_words"),
                "coreference_mentions_per_100_words": (
                    100 * len(json_field(row.get("coref_mentions_json"))) / conversation["total_requester_words"]
                    if conversation.get("total_requester_words") else 0),
                "exact_text_sha256": meta["exact_sha256"],
                "is_dedup_representative": int(meta["duplicate_kind"] == "representative"),
                "is_ctp_screening_candidate": is_rep, "duplicate_kind": meta["duplicate_kind"],
                "duplicate_of_record_id": meta["duplicate_of_record_id"],
                "duplicate_cluster_id": meta["duplicate_cluster_id"],
                "duplicate_cluster_size": meta["member_count"] or 1,
                "representative_record_id": meta["representative_record_id"],
            }
            writers[filename].writerow(record)
            counts[filename] += 1
        print(json.dumps({"csvShard": shard, "firstMessages": len(first_targets)}), flush=True)

    for handle in handles.values():
        handle.close()
    for temp, final in paths.values():
        temp.replace(final)
    expected = {
        "first_messages_with_person_reference_signals.csv": int(dict(frame.execute("SELECT key,value FROM meta"))["retained_person_signal"]),
        "first_messages_without_person_reference_signals.csv": int(dict(frame.execute("SELECT key,value FROM meta"))["retained_no_person_signal"]),
        "first_message_duplicate_exclusions.csv": int(dict(frame.execute("SELECT key,value FROM meta"))["removed_duplicate_rows"]),
    }
    frame.close()
    if counts != expected:
        raise RuntimeError(f"CSV rows do not match the sidecar strata: {counts} vs {expected}")
    return counts


def write_manifest(csv_dir: Path, frame_path: Path, counts: dict, csv_counts: dict) -> dict:
    frame = sqlite3.connect(f"file:{frame_path}?mode=ro", uri=True)
    frame_meta = dict(frame.execute("SELECT key,value FROM meta"))
    files = {}
    compressed_files = {}
    for name, rows in csv_counts.items():
        path = csv_dir / name
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        files[name] = {"data_rows": rows, "bytes": path.stat().st_size, "sha256": digest.hexdigest()}
        compressed_path = path.with_suffix(path.suffix + ".gz")
        if compressed_path.exists():
            compressed_digest = hashlib.sha256()
            with compressed_path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    compressed_digest.update(block)
            compressed_files[compressed_path.name] = {
                "data_rows": rows, "bytes": compressed_path.stat().st_size,
                "sha256": compressed_digest.hexdigest(), "compression": "gzip level 1, mtime 0",
            }
    manifest = {
        "dataset": DATASET, "dataset_revision": DATASET_REVISION,
        "dataset_retrieved": RETRIEVED_AT, "source_data_through": DATA_THROUGH,
        "prescreen_completed_at": frame_meta["prescreen_completed_at"],
        "annotation_index_fingerprint": frame_meta["input_fingerprint"],
        "selection_unit": "earliest non-empty English requester message per conversation",
        "deduplication_order": frame_meta["deduplication_order"],
        "exact_duplicate_rule": frame_meta["exact_hash"],
        "duplicate_link_rule": frame_meta["exact_duplicate_link"],
        "approximate_duplicate_rule": frame_meta["approximate_duplicate_rule"],
        "representative_rule": frame_meta["representative_rule"],
        "ctp_screening_selection_rule": "Exclude repeated exact target text only at turn_index 0, where no prior conversation context exists. Retain every approximate text or embedding match.",
        "embedding_review_rule": "Embedding-based similarity is separate from this frame; approximate text or embedding matches are never excluded. Similarity results must be rebuilt against this exact frame before use.",
        "stratum_rule": frame_meta["stratum_rule"],
        "counts": counts, "csv_files": files, "compressed_csv_files": compressed_files,
        "csv_columns": CSV_COLUMNS,
        "context_rule": "all original roles from conversation start through and including the target; no later turns",
        "excluded_stale_source_fields": "template_or_near_duplicate and conversation-level has_template_duplicate from the earlier whole-requester-turn SimHash pass are omitted because that pass used the unsigned-vote implementation and is not part of this corrected first-message deduplication.",
        "human_or_model_ctp_labels": "not present in the recovered prescreen tables; person-reference strata are screening strata, not human CTP decisions",
    }
    (csv_dir / "frame_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    readme = f"""# WildChat first-message paper frame

These files accompany the paper and were generated from the completed recovered prescreen output for `{DATASET}` at revision `{DATASET_REVISION}`. They include message text and original conversation context through the target message. Treat `record_id` as the stable join key to the annotation interface.

## Files and counts

- `first_messages_with_person_reference_signals.csv`: {counts['retained_person_signal']:,} retained first messages.
- `first_messages_without_person_reference_signals.csv`: {counts['retained_no_person_signal']:,} retained first messages.
- `first_message_duplicate_exclusions.csv`: {counts['removed_duplicate_rows']:,} repeated exact-text first messages removed only when the target is at turn index 0 and has no preceding conversation context.
- Matching `.csv.gz` files are supplied for smaller downloads; they decompress to the same CSV byte stream.
- `frame_manifest.json`: source revision, selection/deduplication settings, counts, CSV hashes and column definitions.

The two retained strata partition the `{counts['retained_first_messages']:,}`-row CTP screening frame. They are formed using each target message's `has_person_reference` prescreen signal. This signal identifies candidates for CTP review and is not a human or model CTP label. No MSD1/Kev or final human yes/no/unclear outcomes are included because those complete screening outputs are not part of the recovered prescreen snapshot.

Exact target-text repeats use SHA-256 over the complete requester message. We exclude a repeat from CTP screening only when the target is at turn index 0, so its complete context through the target is identical. We retain repeated text when preceding turns are present because that context can change the annotation. We do not remove approximate text matches or embedding matches. Embedding similarity results must be rebuilt against this exact frame before use; similarity scores never determine CTP eligibility. The exclusion CSV contains only exact-text removals that meet the no-preceding-context rule.

The older whole-requester-turn `template_or_near_duplicate` and conversation-level `has_template_duplicate` signals are omitted: their SimHash used the unsigned-vote implementation that caused faulty clusters, so they are not valid duplicate labels for this first-message frame.

`context_prefix_json` preserves all original roles from the beginning of each conversation through the target requester message, inclusive. It excludes the target assistant response and later turns. All CSV text fields are exported without truncation.
"""
    (csv_dir / "README.md").write_text(readme, encoding="utf-8")
    frame.close()
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--annotation-index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--csv-dir", type=Path, default=DEFAULT_CSV_DIR)
    parser.add_argument("--compress-only", action="store_true",
                        help="Compress existing CSV exports and refresh their manifest without rebuilding the frame.")
    parser.add_argument("--resume", action="store_true",
                        help="Resume a committed .tmp checkpoint with exact-only deduplication and retain all approximate matches.")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.compress_only:
        manifest_path = args.csv_dir / "frame_manifest.json"
        if not args.output.exists() or not manifest_path.exists():
            raise FileNotFoundError("--compress-only needs the generated paper frame and CSV manifest.")
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        csv_counts = {name: item["data_rows"] for name, item in previous["csv_files"].items()}
        counts = previous["counts"]
        compress_csvs(args.csv_dir, csv_counts)
        final = write_manifest(args.csv_dir, args.output, counts, csv_counts)
        print(json.dumps({"compressedCsvFiles": final["compressed_csv_files"]}, indent=2), flush=True)
        return
    counts = build_frame(args.input, args.annotation_index, args.output, resume=args.resume)
    csv_counts = export_csvs(args.input, args.output, args.csv_dir)
    compress_csvs(args.csv_dir, csv_counts)
    manifest = write_manifest(args.csv_dir, args.output, counts, csv_counts)
    print(json.dumps({"frame": counts, "csvRows": csv_counts,
                      "csvFiles": manifest["csv_files"], "csvDirectory": str(args.csv_dir.resolve())}, indent=2),
          flush=True)


def compress_csvs(csv_dir: Path, csv_counts: dict) -> None:
    for filename in csv_counts:
        source = csv_dir / filename
        destination = source.with_suffix(source.suffix + ".gz")
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with source.open("rb") as input_stream, temporary.open("wb") as output_stream:
            with gzip.GzipFile(filename="", mode="wb", compresslevel=1, fileobj=output_stream, mtime=0) as compressed:
                shutil.copyfileobj(input_stream, compressed, length=1024 * 1024)
        temporary.replace(destination)
        print(json.dumps({"compressed": destination.name, "bytes": destination.stat().st_size}), flush=True)


if __name__ == "__main__":
    main()
