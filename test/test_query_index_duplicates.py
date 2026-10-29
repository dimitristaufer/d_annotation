import importlib.util
import csv
import io
import json
import sqlite3
import unittest
from collections import OrderedDict
from pathlib import Path
from unittest.mock import patch
import sys


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "query-index.py"
SPEC = importlib.util.spec_from_file_location("query_index", SCRIPT)
query_index = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(query_index)
sys.path.insert(0, str(SCRIPT.parent))
import ctp_screening


class DuplicateBrowseTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.create_function("casefold", 1, lambda value: (value or "").casefold(), deterministic=True)
        self.con.create_function("whole_term", 2, query_index.contains_whole_term, deterministic=True)
        self.con.execute("""CREATE TABLE records(
            ordinal INTEGER PRIMARY KEY,id TEXT,sample_key TEXT,conversation_id TEXT,
            source_conversation_id TEXT,source_shard TEXT,turn_index INTEGER,stratum TEXT,
            signal_mask INTEGER,presidio INTEGER,filter_mask INTEGER,payload TEXT)""")
        self.con.execute("CREATE TABLE turns(id INTEGER PRIMARY KEY,conversation_id TEXT,turn_index INTEGER,role TEXT,text TEXT)")
        self.con.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)")
        self.con.executemany("INSERT INTO meta VALUES(?,?)", [
            ("fingerprint", "test-frame"), ("records", "5"), ("positive", "4"),
            ("negative", "1"), ("shardCount", "1"), ("totalSourceShards", "1"),
        ])
        self.con.execute("ATTACH DATABASE ':memory:' AS duplicate_group_index")
        self.con.executescript("""
          CREATE TABLE duplicate_group_index.members(
            ordinal INTEGER PRIMARY KEY,cluster_id TEXT NOT NULL,source_shard TEXT NOT NULL,
            conversation_id TEXT NOT NULL,turn_index INTEGER NOT NULL) WITHOUT ROWID;
          CREATE INDEX duplicate_group_index.members_cluster_order ON members(cluster_id,ordinal);
          CREATE TABLE duplicate_group_index.clusters(cluster_id TEXT PRIMARY KEY,member_count INTEGER NOT NULL) WITHOUT ROWID;
          CREATE TABLE duplicate_group_index.meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        """)
        records = [
            (1, "train-00000-of-00086:1", "1", "conv-a", "conv-a", "train-00000-of-00086", 0, "negative"),
            (2, "train-00000-of-00086:2", "2", "conv-a", "conv-a", "train-00000-of-00086", 1, "positive"),
            (3, "train-00000-of-00086:3", "3", "conv-b", "conv-b", "train-00000-of-00086", 0, "positive"),
            (4, "train-00000-of-00086:4", "4", "conv-b", "conv-b", "train-00000-of-00086", 1, "positive"),
            (5, "train-00000-of-00086:5", "5", "conv-c", "conv-c", "train-00000-of-00086", 0, "positive"),
        ]
        self.con.executemany(
            "INSERT INTO records VALUES(?,?,?,?,?,?,?,?,0,0,0,?)",
            [row + (json.dumps({"id": row[1], "text": f"message {row[0]}", "metadata": {}}),) for row in records],
        )
        self.con.executemany(
            "INSERT INTO turns(conversation_id,turn_index,role,text) VALUES(?,?,?,?)",
            [(row[3], row[6], "user", f"message {row[0]}") for row in records],
        )
        self.con.executemany("INSERT INTO duplicate_group_index.members VALUES(?,?,?,?,?)", [
            (1, "tc_000000000001", records[0][5], records[0][3], 0),
            (2, "tc_000000000001", records[1][5], records[1][3], 1),
            (3, "tc_000000000002", records[2][5], records[2][3], 0),
            (4, "tc_000000000002", records[3][5], records[3][3], 1),
        ])
        self.con.executemany("INSERT INTO duplicate_group_index.clusters VALUES(?,?)", [
            ("tc_000000000001", 2), ("tc_000000000002", 2),
        ])
        self.con.executemany("INSERT INTO duplicate_group_index.meta VALUES(?,?)", [
            ("fingerprint", "test-frame"), ("records", "5"), ("unique_entries", "3"),
        ])

    def attach_paper_frame(self):
        self.con.execute("ATTACH DATABASE ':memory:' AS paper_frame_index")
        self.con.executescript("""
          CREATE TABLE paper_frame_index.meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE paper_frame_index.first_messages(
            record_id TEXT PRIMARY KEY,source_shard TEXT,source_row INTEGER,
            has_person_signal INTEGER,is_representative INTEGER,duplicate_cluster_id TEXT,
            cluster_root_record_id TEXT) WITHOUT ROWID;
          CREATE TABLE paper_frame_index.clusters(
            cluster_id TEXT PRIMARY KEY,root_record_id TEXT,member_count INTEGER,
            exact_duplicate_count INTEGER,near_duplicate_count INTEGER) WITHOUT ROWID;
          CREATE TABLE paper_frame_index.members(
            record_id TEXT PRIMARY KEY,cluster_id TEXT,source_shard TEXT,source_row INTEGER,
            duplicate_kind TEXT) WITHOUT ROWID;
          CREATE INDEX paper_frame_index.first_messages_source_order
            ON first_messages(source_shard,source_row);
        """)
        self.con.executemany("INSERT INTO paper_frame_index.meta VALUES(?,?)", [
            ("input_fingerprint", "test-frame"), ("all_first_messages", "3"),
            ("retained_first_messages", "2"), ("retained_person_signal", "1"),
            ("retained_no_person_signal", "1"), ("removed_duplicate_rows", "1"),
        ])
        ids = ["train-00000-of-00086:1", "train-00000-of-00086:3", "train-00000-of-00086:5"]
        self.con.executemany("INSERT INTO paper_frame_index.first_messages VALUES(?,?,?,?,?,?,?)", [
            (ids[0], "train-00000-of-00086", 10, 0, 1, None, ids[0]),
            (ids[1], "train-00000-of-00086", 30, 1, 1, "pf_000000000002", ids[1]),
            (ids[2], "train-00000-of-00086", 50, 1, 0, "pf_000000000002", ids[1]),
        ])
        self.con.execute("INSERT INTO paper_frame_index.clusters VALUES(?,?,?,?,?)",
                         ("pf_000000000002", ids[1], 2, 1, 0))
        self.con.executemany("INSERT INTO paper_frame_index.members VALUES(?,?,?,?,?)", [
            (ids[1], "pf_000000000002", "train-00000-of-00086", 30, "representative"),
            (ids[2], "pf_000000000002", "train-00000-of-00086", 50, "exact_duplicate"),
        ])

    def tearDown(self):
        self.con.close()

    def test_result_metadata_omits_hidden_frame_counts(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE meta(key TEXT,value TEXT)")
        con.executemany("INSERT INTO meta VALUES(?,?)", [
            ("records", "5"), ("positive", "4"), ("negative", "1"),
        ])
        result = query_index._result_meta(con, 3, 1, 24, "meta", True)
        con.close()

        self.assertNotIn("strataCounts", result)
        self.assertNotIn("uniqueCorpus", result)

    def test_regular_browse_does_not_load_duplicate_cluster_details(self):
        result = query_index.execute_search({
            "action": "search", "jobId": "plain", "page": 1, "limit": 24,
            "stratum": "all", "include_context": False,
        }, self.con, cache=OrderedDict())
        self.assertEqual(result["total"], 5)
        self.assertTrue(result["items"])
        self.assertTrue(all("duplicateGroup" not in row for row in result["items"]))

    def test_primary_english_frame_validation_uses_its_saved_count_only(self):
        self.con.execute("ATTACH DATABASE ':memory:' AS language_frame_index")
        self.con.executescript("""
          CREATE TABLE language_frame_index.meta(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE language_frame_index.frames(frame_id TEXT PRIMARY KEY,retained_records INTEGER);
        """)
        self.con.executemany("INSERT INTO language_frame_index.meta VALUES(?,?)", [
            ("schema_version", "1"),
            ("source_annotation_fingerprint", "test-frame"),
            ("source_embedding_frame_id", "embedding_near_verbatim"),
            ("source_embedding_frame_records", "904667"),
            ("source_short_normalized_frame_records", "900000"),
            ("short_normalized_exclusions", "4667"),
        ])
        self.con.execute("INSERT INTO language_frame_index.frames VALUES(?,?)", ("english_ge_90", 308962))

        result = query_index._require_language_frame(self.con, "english_ge_90")

        self.assertEqual(result["source_embedding_frame_records"], "904667")
        self.assertEqual(self.con.execute(
            "SELECT retained_records FROM language_frame_index.frames WHERE frame_id='english_ge_90'"
        ).fetchone()[0], 308962)

    def test_ctp_label_filter_uses_the_verified_label_index(self):
        params = {"stratum": "english_ge_90"}
        filters = query_index._base_filters({"stratum": "english_ge_90", "ctp_label": "yes"}, params, False)
        self.assertEqual(params["ctp_label"], "yes")
        self.assertIn("ctp_screening_index.ctp_results ctp", filters)
        self.assertIn("ctp.record_id=r.id AND ctp.label=:ctp_label", filters)

    def test_ctp_label_filter_rejects_unknown_decisions(self):
        with self.assertRaisesRegex(ValueError, "Invalid CTP screening label"):
            query_index._base_filters({"stratum": "english_ge_90", "ctp_label": "maybe"},
                                      {"stratum": "english_ge_90"}, False)

    def test_annotation_ids_are_filtered_to_the_requested_paper_frame(self):
        self.con.execute("ATTACH DATABASE ':memory:' AS language_frame_index")
        self.con.executescript("""
          CREATE TABLE language_frame_index.meta(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE language_frame_index.frames(frame_id TEXT PRIMARY KEY,retained_records INTEGER);
          CREATE TABLE language_frame_index.language_frame_flags(record_id TEXT,frame_id TEXT,PRIMARY KEY(record_id,frame_id));
        """)
        self.con.executemany("INSERT INTO language_frame_index.meta VALUES(?,?)", [
            ("schema_version", "1"),
            ("source_annotation_fingerprint", "test-frame"),
            ("source_embedding_frame_id", "embedding_near_verbatim"),
            ("source_embedding_frame_records", "904667"),
            ("source_short_normalized_frame_records", "900000"),
            ("short_normalized_exclusions", "4667"),
        ])
        self.con.execute("INSERT INTO language_frame_index.frames VALUES(?,?)", ("english_ge_90", 308962))
        inside, outside = "train-00000-of-00086:1", "train-00000-of-00086:2"
        self.con.execute("INSERT INTO language_frame_index.language_frame_flags VALUES(?,?)", (inside, "english_ge_90"))

        result = query_index.filter_frame_ids({
            "frame_id": "english_ge_90",
            "record_ids": [outside, inside],
        }, self.con)

        self.assertEqual(result["recordIds"], [inside])
        with self.assertRaisesRegex(ValueError, "Only the ≥90% English paper frame"):
            query_index.filter_frame_ids({"frame_id": "english_ge_80", "record_ids": [inside]}, self.con)

    def test_representative_is_selected_from_members_matching_current_filter(self):
        result = query_index.execute_search({
            "action": "search", "jobId": "positive", "page": 1, "limit": 24,
            "unique_groups": True, "stratum": "positive", "include_context": False,
        }, self.con, cache=OrderedDict())
        self.assertEqual(result["total"], 3)
        self.assertEqual([row["id"] for row in result["items"]], [
            "train-00000-of-00086:2", "train-00000-of-00086:3", "train-00000-of-00086:5",
        ])
        self.assertEqual(result["items"][0]["duplicateGroup"], {"id": "tc_000000000001", "size": 2})

    def test_cluster_drill_in_returns_every_original_member(self):
        result = query_index.execute_search({
            "action": "search", "jobId": "cluster", "page": 1, "limit": 24,
            "duplicate_cluster_id": "tc_000000000001", "stratum": "positive",
            "include_context": False,
        }, self.con, cache=OrderedDict())
        self.assertEqual(result["total"], 2)
        self.assertEqual([row["id"] for row in result["items"]], [
            "train-00000-of-00086:1", "train-00000-of-00086:2",
        ])

    def test_unique_results_keep_their_representative_across_pages(self):
        cache = OrderedDict()
        first = query_index.execute_search({
            "action": "search", "jobId": "paged", "page": 1, "limit": 1,
            "unique_groups": True, "stratum": "positive", "include_context": False,
        }, self.con, cache=cache)
        second = query_index.execute_search({
            "action": "page", "jobId": "paged", "page": 2, "limit": 1,
            "include_context": False,
        }, self.con, cache=cache)
        self.assertEqual(first["total"], 3)
        self.assertEqual(second["total"], 3)
        self.assertEqual(second["items"][0]["id"], "train-00000-of-00086:3")

    def test_search_cache_can_evict_mixed_browse_modes(self):
        cache = OrderedDict()
        self.con.execute("CREATE TEMP TABLE cached_cluster_rows(ordinal INTEGER PRIMARY KEY)")
        query_index._cache_job(self.con, cache, "unique", {
            "kind": "unique", "representatives": "unique_reps_unique",
        })
        cache["legacy"] = ("cached_cluster_rows", 1)
        for index in range(6):
            query_index._cache_job(self.con, cache, f"job{index}", ("unused", index))
        self.assertNotIn("legacy", cache)
        self.assertIsNone(self.con.execute(
            "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='cached_cluster_rows'"
        ).fetchone())

    def test_paper_frame_strata_use_representative_first_messages(self):
        self.attach_paper_frame()
        candidate = query_index.execute_search({
            "action": "search", "jobId": "paper-candidate", "page": 1, "limit": 24,
            "stratum": "paper_candidate", "include_context": False,
        }, self.con, cache=OrderedDict())
        non_candidate = query_index.execute_search({
            "action": "search", "jobId": "paper-negative", "page": 1, "limit": 24,
            "stratum": "paper_non_candidate", "include_context": False,
        }, self.con, cache=OrderedDict())
        self.assertEqual(candidate["total"], 1)
        self.assertEqual(candidate["items"][0]["id"], "train-00000-of-00086:3")
        self.assertNotIn("duplicateGroup", candidate["items"][0])
        self.assertEqual(non_candidate["total"], 1)
        self.assertEqual(non_candidate["items"][0]["id"], "train-00000-of-00086:1")

    def test_paper_frame_sampling_and_duplicate_drill_in(self):
        self.attach_paper_frame()
        sample = query_index.execute_sample({
            "unit": "paper_first_messages", "stratum": "paper_candidate", "sample_n": 1,
            "seed": "test", "include_context": False,
        }, self.con)
        self.assertEqual(sample["payload"]["recordIds"], ["train-00000-of-00086:3"])
        cluster = query_index.execute_search({
            "action": "search", "jobId": "paper-cluster", "page": 1, "limit": 24,
            "duplicate_cluster_id": "pf_000000000002", "include_context": False,
        }, self.con, cache=OrderedDict())
        self.assertEqual(cluster["duplicateClusterSize"], 2)
        self.assertEqual([row["id"] for row in cluster["items"]], [
            "train-00000-of-00086:3", "train-00000-of-00086:5",
        ])

    def test_english_frame_sample_filters_and_exports_ctp_outcomes(self):
        self.con.execute("ATTACH DATABASE ':memory:' AS language_frame_index")
        self.con.executescript("""
          CREATE TABLE language_frame_index.language_frame_flags(
            record_id TEXT,frame_id TEXT,PRIMARY KEY(record_id,frame_id));
        """)
        self.con.executemany("INSERT INTO language_frame_index.language_frame_flags VALUES(?,?)", [
            (record[1], "english_ge_90") for record in [
                (1, "train-00000-of-00086:1"), (2, "train-00000-of-00086:2"),
                (3, "train-00000-of-00086:3"), (4, "train-00000-of-00086:4"),
                (5, "train-00000-of-00086:5"),
            ]
        ])
        self.con.execute("ATTACH DATABASE ':memory:' AS ctp_screening_index")
        self.con.executescript("""
          CREATE TABLE ctp_screening_index.ctp_results(record_id TEXT PRIMARY KEY,label TEXT);
        """)
        self.con.executemany("INSERT INTO ctp_screening_index.ctp_results VALUES(?,?)", [
            ("train-00000-of-00086:1", "yes"),
            ("train-00000-of-00086:2", "no"),
            ("train-00000-of-00086:3", "unclear"),
            ("train-00000-of-00086:4", "yes"),
            ("train-00000-of-00086:5", "no"),
        ])
        request = {
            "unit": "english_ge_90", "stratum": "english_ge_90", "sample_n": 5,
            "seed": "ctp-sample-test", "include_context": False,
        }
        with patch.object(query_index, "_require_language_frame"), \
                patch.object(query_index, "_require_ctp_screening"):
            yes_sample = query_index.execute_sample({**request, "ctp_label": "yes"}, self.con)
            all_sample = query_index.execute_sample({**request, "ctp_label": ""}, self.con)

        yes_rows = list(csv.DictReader(io.StringIO(yes_sample["payload"]["csv"])))
        all_rows = list(csv.DictReader(io.StringIO(all_sample["payload"]["csv"])))
        self.assertEqual(set(yes_sample["payload"]["recordIds"]), {
            "train-00000-of-00086:1", "train-00000-of-00086:4",
        })
        self.assertEqual({row["ctp_screening_label"] for row in yes_rows}, {"yes"})
        self.assertEqual({row["ctp_screening_label"] for row in all_rows}, {"yes", "no", "unclear"})

    def test_ctp_label_lookup_returns_verified_labels_and_marks_missing_ids(self):
        self.con.execute("ATTACH DATABASE ':memory:' AS ctp_screening_index")
        self.con.execute("CREATE TABLE ctp_screening_index.ctp_results(record_id TEXT PRIMARY KEY,label TEXT)")
        self.con.executemany("INSERT INTO ctp_screening_index.ctp_results VALUES(?,?)", [
            ("yes-id", "yes"), ("no-id", "no"), ("unclear-id", "unclear"), ("invalid-id", "unexpected"),
        ])
        verified = {"frameId": "english_ge_90", "runId": "pinned-test", "frameRecords": 308962, "counts": {}}
        with patch.object(ctp_screening, "require_ctp_screening", return_value=verified):
            result = query_index._get_ctp_labels({"record_ids": ["yes-id", "no-id", "unclear-id", "outside-id", "invalid-id", "yes-id"]}, self.con)
        self.assertEqual(result, {
            "frameId": "english_ge_90",
            "runId": "pinned-test",
            "labels": {"yes-id": "yes", "no-id": "no", "unclear-id": "unclear"},
            "unlabeledRecordIds": ["outside-id", "invalid-id"],
        })

    def test_ctp_label_lookup_rejects_malformed_or_oversized_requests(self):
        with patch.object(ctp_screening, "require_ctp_screening") as validate_frame:
            with self.assertRaises(ValueError):
                query_index._get_ctp_labels({"record_ids": "not-a-list"}, self.con)
            with self.assertRaises(ValueError):
                query_index._get_ctp_labels({"record_ids": [""]}, self.con)
            validate_frame.assert_not_called()


if __name__ == "__main__":
    unittest.main()
