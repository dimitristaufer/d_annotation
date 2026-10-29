#!/usr/bin/env python3
"""Return one indexed record with its conversation context as JSON."""
import json
import sqlite3
import sys
from pathlib import Path
from ctp_screening import require_ctp_screening

db_path = Path(__file__).resolve().parents[1] / "data" / "annotation-index.sqlite"
request = json.load(sys.stdin)
record_id = request.get("recordId") if isinstance(request, dict) else None
if not isinstance(record_id, str) or not record_id or len(record_id) > 300:
    raise SystemExit("Invalid record id")

connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
ctp_frame = None
if request.get("includeCtpLabel") is True:
    connection.execute("ATTACH DATABASE ? AS language_frame_index",
                        (f"file:{db_path.with_name('language-share-frames.sqlite')}?mode=ro",))
    connection.execute("ATTACH DATABASE ? AS ctp_screening_index",
                        (f"file:{db_path.with_name('msd1-ctp-screening.sqlite')}?mode=ro",))
    ctp_frame = require_ctp_screening(connection, verify_contents=False)
    screening = connection.execute(
        "SELECT label FROM ctp_screening_index.ctp_results WHERE record_id=?", (record_id,)
    ).fetchone()
    ctp_label = screening["label"] if screening else None
    if ctp_label != "yes":
        if ctp_label not in {"no", "unclear"}:
            print(json.dumps({"unlabeled": True, "ctpScreeningRunId": ctp_frame["runId"]}))
        else:
            print(json.dumps({"skipped": True, "ctpScreeningLabel": ctp_label,
                              "ctpScreeningRunId": ctp_frame["runId"]}))
        connection.close()
        raise SystemExit(0)
row = connection.execute(
    "SELECT payload,conversation_id,turn_index FROM records WHERE id=?", (record_id,)
).fetchone()
if row is None:
    print(json.dumps({"error": "Message not found."}))
    raise SystemExit(0)

payload = json.loads(row["payload"])
if ctp_frame:
    payload["ctpScreeningLabel"] = ctp_label
    payload["ctpScreeningRunId"] = ctp_frame["runId"]
if request.get("includeContext") is False:
    target = connection.execute(
        "SELECT text FROM turns WHERE conversation_id=? AND turn_index=?",
        (row["conversation_id"], row["turn_index"]),
    ).fetchone()
    payload["context"] = []
    payload["text"] = target["text"] if target else ""
else:
    payload["context"] = [
        {"role": turn["role"], "text": turn["text"], "turnIndex": turn["turn_index"]}
        for turn in connection.execute(
            "SELECT role,text,turn_index FROM turns WHERE conversation_id=? AND turn_index<=? ORDER BY turn_index",
            (row["conversation_id"], row["turn_index"]),
        )
    ]
    payload["text"] = payload["context"][-1]["text"] if payload["context"] else ""
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
connection.close()
