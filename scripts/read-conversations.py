#!/usr/bin/env python3
"""Resolve source conversation IDs to indexed requester-message IDs."""
import json
import sqlite3
import sys
from pathlib import Path

db_path = Path(__file__).resolve().parents[1] / "data" / "annotation-index.sqlite"
request = json.load(sys.stdin)
conversation_ids = request.get("conversationIds", []) if isinstance(request, dict) else []
if not isinstance(conversation_ids, list) or len(conversation_ids) > 5000 or any(not isinstance(value, str) or not value or len(value) > 128 for value in conversation_ids):
    raise SystemExit("Invalid conversation ID list")
conversation_ids = list(dict.fromkeys(conversation_ids))
include_text = isinstance(request, dict) and request.get("includeText") is True
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
if isinstance(request, dict) and request.get("summaryOnly") is True:
    rows = connection.execute(
        "SELECT source_conversation_id,COUNT(*) AS requester_messages,COUNT(DISTINCT conversation_id) AS indexed_conversations "
        "FROM records WHERE source_conversation_id IN (SELECT value FROM json_each(?)) "
        "GROUP BY source_conversation_id ORDER BY source_conversation_id",
        (json.dumps(conversation_ids),),
    ).fetchall()
    found = {row["source_conversation_id"] for row in rows}
    print(json.dumps({
        "matches": [{"conversationId": row["source_conversation_id"], "requesterMessages": row["requester_messages"], "indexedConversations": row["indexed_conversations"]} for row in rows],
        "missingConversationIds": [value for value in conversation_ids if value not in found],
    }, separators=(",", ":")))
    connection.close()
    raise SystemExit(0)
rows = connection.execute(
    "WITH ranked AS ("
    "SELECT records.id,records.source_conversation_id,records.conversation_id,records.turn_index,records.ordinal" + (",turns.text AS message_text" if include_text else "") + ","
    "ROW_NUMBER() OVER (PARTITION BY records.source_conversation_id ORDER BY records.turn_index,records.ordinal) AS message_rank "
    "FROM records " + ("LEFT JOIN turns ON turns.conversation_id=records.conversation_id AND turns.turn_index=records.turn_index " if include_text else "") + "WHERE records.source_conversation_id IN (SELECT value FROM json_each(?))"
    ") SELECT id,source_conversation_id,conversation_id,turn_index" + (",message_text" if include_text else "") + " FROM ranked "
    "WHERE message_rank=1 ORDER BY ordinal",
    (json.dumps(conversation_ids),),
).fetchall()
found = {row["source_conversation_id"] for row in rows}
print(json.dumps({
    "records": [{"recordId": row["id"], "conversationId": row["source_conversation_id"], "turnIndex": row["turn_index"], **({"messageText": row["message_text"] or ""} if include_text else {})} for row in rows],
    "missingConversationIds": [value for value in conversation_ids if value not in found],
}, separators=(",", ":")))
connection.close()
