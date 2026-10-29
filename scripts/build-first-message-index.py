#!/usr/bin/env python3
"""Build a small read-only index of the earliest requester message per conversation."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
SOURCE = DATA / "annotation-index.sqlite"
OUTPUT = DATA / "first-message-index.sqlite"


def main():
    source = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    fingerprint = source.execute("SELECT value FROM meta WHERE key='fingerprint'").fetchone()[0]
    if OUTPUT.exists():
        try:
            existing = sqlite3.connect(f"file:{OUTPUT}?mode=ro", uri=True)
            current = existing.execute("SELECT value FROM meta WHERE key='fingerprint'").fetchone()
            existing.close()
            if current and current[0] == fingerprint:
                print("First-message index is current")
                source.close()
                return
        except sqlite3.Error:
            pass

    temporary = OUTPUT.with_suffix(".sqlite.tmp")
    temporary.unlink(missing_ok=True)
    target = sqlite3.connect(temporary)
    target.execute("PRAGMA journal_mode=OFF")
    target.execute("PRAGMA synchronous=OFF")
    target.execute("CREATE TABLE first_messages(ordinal INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, has_person_signal INTEGER NOT NULL)")
    rows = source.execute("""WITH first_turn AS (
          SELECT conversation_id, MIN(turn_index) AS turn_index
          FROM records GROUP BY conversation_id
        )
        SELECT r.ordinal,r.conversation_id,CASE WHEN (r.filter_mask & 15) != 0 THEN 1 ELSE 0 END
        FROM first_turn f JOIN records r
          ON r.conversation_id=f.conversation_id AND r.turn_index=f.turn_index
        ORDER BY r.ordinal""")
    batch = []
    positive = total = 0
    for ordinal, conversation_id, has_person_signal in rows:
        batch.append((ordinal, conversation_id, has_person_signal))
        total += 1
        positive += has_person_signal
        if len(batch) >= 25_000:
            target.executemany("INSERT INTO first_messages VALUES(?,?,?)", batch)
            batch.clear()
    if batch:
        target.executemany("INSERT INTO first_messages VALUES(?,?,?)", batch)
    target.executescript("""
      CREATE INDEX first_messages_signal_order ON first_messages(has_person_signal,ordinal);
      CREATE INDEX first_messages_conversation ON first_messages(conversation_id);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    """)
    target.executemany("INSERT INTO meta VALUES(?,?)", [
        ("fingerprint", fingerprint),
        ("all", str(total)),
        ("positive", str(positive)),
        ("negative", str(total - positive)),
    ])
    target.commit()
    target.close()
    source.close()
    temporary.replace(OUTPUT)
    print(json.dumps({"firstMessages": total, "positive": positive, "negative": total - positive}))


if __name__ == "__main__":
    main()
