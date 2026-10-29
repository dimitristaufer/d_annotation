#!/usr/bin/env python3
"""Build a local SQLite search/filter index from prepared WildChat frames."""
from __future__ import annotations

import gzip
import json
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DB_PATH = DATA / "annotation-index.sqlite"
FRAME_DIR = DATA / "frames"
SIGNALS = ("personName", "personNoun", "personPronoun", "coreference", "embeddedContent")
INDEX_VERSION = "4"


class StreamJSON:
    """Small incremental JSON decoder so one large shard never sits in RAM."""
    def __init__(self, stream):
        self.stream = stream
        self.decoder = json.JSONDecoder()
        self.buffer = ""
        self.position = 0
        self.eof = False

    def _fill(self):
        if self.eof:
            return False
        self.buffer = self.buffer[self.position:]
        self.position = 0
        chunk = self.stream.read(65536)
        if not chunk:
            self.eof = True
            return False
        self.buffer += chunk
        return True

    def whitespace(self):
        while True:
            while self.position < len(self.buffer) and self.buffer[self.position].isspace():
                self.position += 1
            if self.position < len(self.buffer) or not self._fill():
                return

    def take(self, expected):
        self.whitespace()
        if self.position >= len(self.buffer) or self.buffer[self.position] != expected:
            raise ValueError(f"expected {expected!r} in frame JSON")
        self.position += 1

    def value(self):
        while True:
            self.whitespace()
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
                self.position = end
                return value
            except json.JSONDecodeError:
                if not self._fill():
                    raise

    def array(self):
        self.take("[")
        self.whitespace()
        if self.position < len(self.buffer) and self.buffer[self.position] == "]":
            self.position += 1
            return
        while True:
            yield self.value()
            self.whitespace()
            delimiter = self.buffer[self.position] if self.position < len(self.buffer) else ""
            while not delimiter and self._fill():
                self.whitespace()
                delimiter = self.buffer[self.position] if self.position < len(self.buffer) else ""
            if delimiter == "]":
                self.position += 1
                return
            if delimiter != ",":
                raise ValueError("malformed frame JSON array")
            self.position += 1

    def object(self):
        self.take("{")
        self.whitespace()
        if self.position < len(self.buffer) and self.buffer[self.position] == "}":
            self.position += 1
            return
        while True:
            key = self.value()
            if not isinstance(key, str):
                raise ValueError("frame JSON object key is not a string")
            self.take(":")
            yield key, self.value()
            self.whitespace()
            delimiter = self.buffer[self.position] if self.position < len(self.buffer) else ""
            while not delimiter and self._fill():
                self.whitespace()
                delimiter = self.buffer[self.position] if self.position < len(self.buffer) else ""
            if delimiter == "}":
                self.position += 1
                return
            if delimiter != ",":
                raise ValueError("malformed frame JSON object")
            self.position += 1


def build() -> None:
    summary = json.loads((DATA / "summary.json").read_text(encoding="utf-8"))
    fingerprint = summary.get("inputFingerprint", summary.get("snapshot", ""))
    if DB_PATH.exists():
        try:
            con = sqlite3.connect(DB_PATH)
            current = dict(con.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','index_version')"))
            expected = {f"frame-{shard}.json.gz" for shard in summary["shards"]}
            if current.get("fingerprint") == fingerprint and current.get("index_version") == INDEX_VERSION and {p.name for p in FRAME_DIR.glob("frame-*.json.gz")} == expected:
                con.execute("CREATE INDEX IF NOT EXISTS records_source_conversation ON records(source_conversation_id,ordinal)")
                con.commit()
                con.close()
                print(f"SQLite index is current: {summary['records']:,} records")
                return
            con.close()
        except sqlite3.Error:
            pass
    tmp_path = DB_PATH.with_suffix(".sqlite.tmp")
    tmp_path.unlink(missing_ok=True)
    con = sqlite3.connect(tmp_path)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA cache_size=-262144")
    con.executescript("""
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE turns(
        id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE TABLE records(
        ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, sample_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
        source_shard TEXT NOT NULL, turn_index INTEGER NOT NULL,
        stratum TEXT NOT NULL, signal_mask INTEGER NOT NULL, presidio INTEGER NOT NULL,
        filter_mask INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE conversation_coreference(
        conversation_id TEXT PRIMARY KEY,
        person_coref_clusters INTEGER NOT NULL,
        person_coref_mentions INTEGER NOT NULL,
        requester_words INTEGER NOT NULL,
        mentions_per_100_words REAL NOT NULL
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE turn_search USING fts5(
        text, conversation_id UNINDEXED, turn_index UNINDEXED,
        tokenize='trigram', detail='none'
      );
    """)
    ordinal = 0
    for shard in summary["shards"]:
        frame_path = FRAME_DIR / f"frame-{shard}.json.gz"
        print(f"Indexing {shard}", flush=True)
        presidio_conversations = set()
        conversation_coreference = {}
        with gzip.open(frame_path, "rt", encoding="utf-8") as stream:
            parser = StreamJSON(stream)
            parser.take("{")
            parser.whitespace()
            while parser.position < len(parser.buffer) and parser.buffer[parser.position] != "}":
                field = parser.value()
                parser.take(":")
                if field == "records":
                    record_batch = []
                    for row in parser.array():
                        ordinal += 1
                        target = row.get("screening", {}).get("target", {})
                        mask = sum((1 << i) for i, name in enumerate(SIGNALS) if target.get(name))
                        conversation_id = row["conversationId"]
                        metadata = row.get("metadata", {})
                        stats = conversation_coreference.setdefault(conversation_id, {"words": 0, "clusters": {}})
                        try:
                            stats["words"] += max(0, int(metadata.get("words", 0)))
                        except (TypeError, ValueError, OverflowError):
                            pass
                        for mention in row.get("screening", {}).get("coreferenceMentions", []) or []:
                            if not isinstance(mention, dict) or mention.get("cluster_index") is None:
                                continue
                            try:
                                cluster_index = int(mention["cluster_index"])
                                span = (int(mention.get("turn_index", row.get("requesterTurnIndex", 0))),
                                        int(mention["start"]), int(mention["end"]))
                            except (KeyError, TypeError, ValueError, OverflowError):
                                continue
                            if span[2] > span[1]:
                                stats["clusters"].setdefault(cluster_index, set()).add(span)
                        record_batch.append((ordinal, row["id"], str(row.get("sampleKey", "")), conversation_id,
                                             str(row.get("sourceConversationId", conversation_id)), row["sourceShard"],
                                             int(row["turnIndex"]), row.get("stratum", "positive"), mask, 0, mask,
                                             json.dumps(row, ensure_ascii=False, separators=(",", ":"))))
                        if len(record_batch) >= 2000:
                            con.executemany("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", record_batch)
                            record_batch.clear()
                    if record_batch:
                        con.executemany("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", record_batch)
                    coreference_batch = []
                    for conversation_id, stats in conversation_coreference.items():
                        valid_cluster_sizes = [len(spans) for spans in stats["clusters"].values() if len(spans) >= 2]
                        mention_count = sum(valid_cluster_sizes)
                        requester_words = stats["words"]
                        rate = mention_count * 100.0 / requester_words if requester_words else 0.0
                        coreference_batch.append((conversation_id, len(valid_cluster_sizes), mention_count,
                                                  requester_words, rate))
                        if len(coreference_batch) >= 2000:
                            con.executemany("INSERT INTO conversation_coreference VALUES(?,?,?,?,?)", coreference_batch)
                            coreference_batch.clear()
                    if coreference_batch:
                        con.executemany("INSERT INTO conversation_coreference VALUES(?,?,?,?,?)", coreference_batch)
                elif field == "turns":
                    turn_batch = []
                    fts_batch = []
                    for conversation_id, turns in parser.object():
                        for turn in turns:
                            text = turn.get("text") or ""
                            turn_index = int(turn.get("turnIndex", 0))
                            turn_batch.append((conversation_id, turn_index, turn.get("role", ""), text))
                            if text:
                                fts_batch.append((text, conversation_id, turn_index))
                                if "PRESIDIO_" in text:
                                    presidio_conversations.add(conversation_id)
                            if len(turn_batch) >= 5000:
                                con.executemany("INSERT INTO turns(conversation_id,turn_index,role,text) VALUES(?,?,?,?)", turn_batch)
                                turn_batch.clear()
                            if len(fts_batch) >= 5000:
                                con.executemany("INSERT INTO turn_search(text,conversation_id,turn_index) VALUES(?,?,?)", fts_batch)
                                fts_batch.clear()
                    if turn_batch:
                        con.executemany("INSERT INTO turns(conversation_id,turn_index,role,text) VALUES(?,?,?,?)", turn_batch)
                    if fts_batch:
                        con.executemany("INSERT INTO turn_search(text,conversation_id,turn_index) VALUES(?,?,?)", fts_batch)
                else:
                    parser.value()
                parser.whitespace()
                if parser.position < len(parser.buffer) and parser.buffer[parser.position] == ",":
                    parser.position += 1
                    parser.whitespace()
                elif parser.position < len(parser.buffer) and parser.buffer[parser.position] == "}":
                    parser.position += 1
                    break
            if presidio_conversations:
                con.executemany("UPDATE records SET presidio=1,filter_mask=signal_mask | 32 WHERE conversation_id=?", [(value,) for value in presidio_conversations])
        con.commit()
    con.executescript("""
      CREATE INDEX records_stratum_order ON records(stratum, ordinal);
      CREATE INDEX records_stratum_conversation_order ON records(stratum, conversation_id, ordinal, filter_mask);
      CREATE INDEX records_conversation ON records(conversation_id, turn_index);
      CREATE INDEX records_filter_order ON records(filter_mask, ordinal);
      CREATE INDEX records_stratum_filter_order ON records(stratum, filter_mask, ordinal);
      CREATE INDEX records_source_conversation ON records(source_conversation_id, ordinal);
      CREATE INDEX turns_conversation_order ON turns(conversation_id, turn_index);
      CREATE INDEX conversation_coreference_density ON conversation_coreference(mentions_per_100_words, person_coref_mentions, conversation_id);
      CREATE INDEX conversation_coreference_mentions ON conversation_coreference(person_coref_mentions, conversation_id);
    """)
    con.executemany("INSERT INTO meta(key,value) VALUES(?,?)", [
        ("fingerprint", fingerprint), ("snapshot", str(summary.get("snapshot", ""))),
        ("index_version", INDEX_VERSION),
        ("records", str(summary.get("records", 0))), ("positive", str(summary.get("positive", 0))),
        ("negative", str(summary.get("negative", 0))), ("shardCount", str(summary.get("shardCount", len(summary.get("shards", []))))),
        ("totalSourceShards", str(summary.get("totalSourceShards", len(summary.get("shards", []))))),
    ])
    con.commit()
    con.execute("PRAGMA optimize")
    con.close()
    tmp_path.replace(DB_PATH)
    print(f"Built {DB_PATH} with {ordinal:,} records ({DB_PATH.stat().st_size / 1024**3:.2f} GiB)")


if __name__ == "__main__":
    try:
        build()
    except Exception as error:
        print(f"index build failed: {error}", file=sys.stderr)
        raise
