#!/usr/bin/env python3
"""Read a page of provisional embedding-neighbor pairs from the local sidecar."""
import json
import sqlite3
import sys
from pathlib import Path


root = Path(__file__).resolve().parents[1]
sidecar = root / "data" / "embedding-similarities.sqlite"
index = root / "data" / "annotation-index.sqlite"
paper_frame = root / "data" / "paper-first-message-frame.sqlite"
request = json.load(sys.stdin)
if not isinstance(request, dict):
    raise SystemExit("Invalid request.")
band = request.get("band")
if band not in {"primary", "sensitivity", "near_verbatim"}:
    raise SystemExit("Choose a supported similarity review band.")
try:
    page = max(1, min(1_000_000, int(request.get("page", 1))))
    limit = max(1, min(50, int(request.get("limit", 24))))
except (TypeError, ValueError):
    raise SystemExit("Invalid page or page size.")

where = {
    "primary": ("cosine_similarity>=?", (0.999,)),
    "sensitivity": ("cosine_similarity>=? AND cosine_similarity<?", (0.995, 0.999)),
    "near_verbatim": ("cosine_similarity>=?", (0.9999,)),
}[band]

connection = sqlite3.connect(f"file:{sidecar}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only=ON")
connection.execute("ATTACH DATABASE ? AS active_index", (f"file:{index}?mode=ro",))
connection.execute("ATTACH DATABASE ? AS active_paper_frame", (f"file:{paper_frame}?mode=ro",))
meta = dict(connection.execute("SELECT key,value FROM meta"))
active_fingerprint = connection.execute("SELECT value FROM active_index.meta WHERE key='fingerprint'").fetchone()
if meta.get("schema_version") != "1" or not active_fingerprint or meta.get("source_frame_fingerprint") != active_fingerprint[0]:
    raise SystemExit("The embedding similarity sidecar does not match the active annotation frame.")
paper_meta = dict(connection.execute("SELECT key,value FROM active_paper_frame.meta"))
if int(paper_meta.get("retained_person_signal", "-1")) != int(meta.get("records", "-2")):
    raise SystemExit("The embedding similarity sidecar is stale for the current CTP screening frame and must be rebuilt.")
frame_members = int(connection.execute("""SELECT count(*) FROM record_map m
    JOIN active_paper_frame.first_messages f ON f.record_id=m.record_id
    WHERE f.is_representative=1 AND f.has_person_signal=1""").fetchone()[0])
if frame_members != int(meta["records"]):
    raise SystemExit("The embedding similarity sidecar IDs do not match the current CTP screening frame.")

counts = {
    "primary": int(connection.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=?", (0.999,)).fetchone()[0]),
    "sensitivity": int(connection.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=? AND cosine_similarity<?", (0.995, 0.999)).fetchone()[0]),
    "near_verbatim": int(connection.execute("SELECT count(*) FROM pairs WHERE cosine_similarity>=?", (0.9999,)).fetchone()[0]),
}
total = counts[band]
offset = (page - 1) * limit
rows = connection.execute(
    f"""SELECT l.record_id AS left_record_id,r.record_id AS right_record_id,p.cosine_similarity,
               substr(lt.text,1,360) AS left_preview,substr(rt.text,1,360) AS right_preview
        FROM pairs p JOIN record_map l ON l.row_index=p.left_index
        JOIN record_map r ON r.row_index=p.right_index
        JOIN active_index.records lr ON lr.id=l.record_id
        JOIN active_index.records rr ON rr.id=r.record_id
        JOIN active_index.turns lt ON lt.conversation_id=lr.conversation_id AND lt.turn_index=lr.turn_index
        JOIN active_index.turns rt ON rt.conversation_id=rr.conversation_id AND rt.turn_index=rr.turn_index
        WHERE {where[0]}
        ORDER BY p.cosine_similarity DESC,p.left_index,p.right_index
        LIMIT ? OFFSET ?""",
    (*where[1], limit, offset),
).fetchall()
result = {
    "band": band,
    "page": page,
    "pageSize": limit,
    "total": total,
    "totalPages": (total + limit - 1) // limit,
    "counts": counts,
    "model": meta["embedding_model"],
    "revision": meta["embedding_revision"],
    "records": int(meta["records"]),
    "pairs": [{
        "leftRecordId": row["left_record_id"],
        "rightRecordId": row["right_record_id"],
        "cosineSimilarity": row["cosine_similarity"],
        "leftPreview": row["left_preview"],
        "rightPreview": row["right_preview"],
    } for row in rows],
}
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
connection.close()
