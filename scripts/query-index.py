#!/usr/bin/env python3
"""One-shot local SQLite query bridge used by the Next.js API route."""
from __future__ import annotations

import json
import csv
import hashlib
import io
import signal
import sqlite3
import sys
import uuid
from collections import OrderedDict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ctp_screening import get_ctp_labels as _get_ctp_labels, require_ctp_screening

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "annotation-index.sqlite"
FIRST_MESSAGE_DB_PATH = DB_PATH.with_name("first-message-index.sqlite")
DUPLICATE_GROUPS_DB_PATH = DB_PATH.with_name("duplicate-groups.sqlite")
PAPER_FRAME_DB_PATH = DB_PATH.with_name("paper-first-message-frame.sqlite")
EMBEDDING_FRAME_DB_PATH = DB_PATH.with_name("embedding-deduplicated-frames.sqlite")
LANGUAGE_FRAME_DB_PATH = DB_PATH.with_name("language-share-frames.sqlite")
CTP_SCREENING_DB_PATH = DB_PATH.with_name("msd1-ctp-screening.sqlite")
SIGNAL_BITS = {"names": 1, "nouns": 2, "pronouns": 4, "coreference": 8, "embedded": 16}
CTP_LABELS = {"yes", "no", "unclear"}


def contains_whole_term(value: str | None, term: str) -> int:
    text = (value or "").casefold()
    needle = term.casefold()
    if not needle:
        return 0
    start = text.find(needle)
    while start >= 0:
        end = start + len(needle)
        before = text[start - 1] if start else ""
        after = text[end] if end < len(text) else ""
        if not (before.isalnum() or before == "_") and not (after.isalnum() or after == "_"):
            return 1
        start = text.find(needle, start + 1)
    return 0


_CANCELLED = False


def _cancel_signal(_signum, _frame):
    global _CANCELLED
    _CANCELLED = True


def _is_identifier_query(query: str) -> bool:
    value = query.lower()
    if value.startswith("train-") or "-of-" in value:
        return True
    compact = value.replace("-", "").replace(":", "")
    if ("-" in value or ":" in value) and len(compact) >= 8 and all(character in "0123456789abcdef" for character in compact):
        return True
    if value.isdigit():
        return len(value) >= 6
    return len(value) >= 6 and all(character in "0123456789abcdef" for character in value)


def _text_condition(query: str, exact: bool, alias: str) -> str:
    if exact:
        return f"whole_term({alias}.text,:q)>0"
    if query.isascii():
        return f"instr(lower({alias}.text),lower(:q))>0"
    return f"instr(casefold({alias}.text),casefold(:q))>0"


def _base_filters(request, params, coref_stats_available):
    signals = [s for s in request.get("signals", []) if s in SIGNAL_BITS]
    mask = sum(SIGNAL_BITS[s] for s in signals)
    presidio = bool(request.get("presidio"))
    mode = "all" if request.get("match") == "all" else "any"
    filters = ""
    if signals or presidio:
        allowed_masks = []
        for filter_mask in range(64):
            signal_mask = filter_mask & 31
            has_presidio = bool(filter_mask & 32)
            selected = []
            if signals:
                selected.append((signal_mask & mask) == mask if mode == "all" else (signal_mask & mask) != 0)
            if presidio:
                selected.append(has_presidio)
            if all(selected) if mode == "all" else any(selected):
                allowed_masks.append(filter_mask)
        placeholders = []
        for i, value in enumerate(allowed_masks):
            key = f"filter_mask_{i}"
            placeholders.append(f":{key}")
            params[key] = value
        filters += " AND r.filter_mask IN (" + ",".join(placeholders) + ")"
    stratum = request.get("stratum", "all")
    if stratum in ("positive", "negative", "conversation_positive", "conversation_negative"):
        params["stratum_value"] = "positive" if stratum in ("positive", "conversation_positive") else "negative"
        filters += " AND r.stratum = :stratum_value"
    elif stratum in ("message_positive", "message_negative"):
        positive_message = stratum == "message_positive"
        # Bits 0–3 are person names, person nouns, pronouns and coreference.
        # Enumerating the small mask set lets SQLite use the covering filter
        # index rather than scanning the full records table.
        masks = [value for value in range(64) if bool(value & 15) == positive_message]
        placeholders = []
        for i, value in enumerate(masks):
            key = f"message_mask_{i}"
            placeholders.append(f":{key}")
            params[key] = value
        filters += " AND r.filter_mask IN (" + ",".join(placeholders) + ")"
    elif stratum in ("first_messages", "first_message_positive", "first_message_negative"):
        if stratum == "first_message_positive":
            filters += " AND first_message_flags.has_person_signal=1"
        elif stratum == "first_message_negative":
            filters += " AND first_message_flags.has_person_signal=0"
    elif stratum in ("paper_first_messages", "paper_candidate", "paper_non_candidate"):
        filters += " AND paper_frame_flags.is_representative=1"
        if stratum == "paper_candidate":
            filters += " AND paper_frame_flags.has_person_signal=1"
        elif stratum == "paper_non_candidate":
            filters += " AND paper_frame_flags.has_person_signal=0"
    elif stratum in ("embedding_sensitivity", "embedding_primary", "embedding_near_verbatim"):
        params["embedding_frame_id"] = stratum
        filters += " AND embedding_frame_flags.frame_id=:embedding_frame_id"
    elif stratum in ("english_ge_90", "english_ge_80", "english_ge_50"):
        params["language_frame_id"] = stratum
        filters += " AND language_frame_flags.frame_id=:language_frame_id"
    ctp_label = request.get("ctp_label")
    if ctp_label:
        if ctp_label not in CTP_LABELS:
            raise ValueError("Invalid CTP screening label.")
        params["ctp_label"] = ctp_label
        filters += (" AND EXISTS (SELECT 1 FROM ctp_screening_index.ctp_results ctp "
                    "WHERE ctp.record_id=r.id AND ctp.label=:ctp_label)")
    if params.get("paper_first_messages_only") and stratum not in (
            "paper_first_messages", "paper_candidate", "paper_non_candidate"):
        filters += " AND paper_frame_flags.is_representative=1"
    min_coref_mentions = max(0, int(request.get("coref_min_mentions", 0) or 0))
    min_coref_rate = max(0.0, float(request.get("coref_min_rate", 0.0) or 0.0))
    if min_coref_mentions or min_coref_rate:
        if not coref_stats_available:
            raise ValueError("Coreference metrics are not in this index yet. Rebuild the local search index.")
        params["coref_min_mentions"] = max(2, min_coref_mentions)
        coref_conditions = ["person_coref_mentions >= :coref_min_mentions"]
        if min_coref_rate:
            params["coref_min_rate"] = min_coref_rate
            coref_conditions.append("mentions_per_100_words >= :coref_min_rate")
        filters += " AND r.conversation_id IN (SELECT conversation_id FROM conversation_coreference WHERE " + " AND ".join(coref_conditions) + ")"
    excluded = request.get("exclude", [])
    included = request.get("include", [])
    if excluded:
        filters += " AND r.id NOT IN (SELECT value FROM json_each(:exclude))"
    if request.get("include_only"):
        filters += " AND r.id IN (SELECT value FROM json_each(:include))"
    return filters


def _uses_first_message_source(params):
    return bool(params.get("first_messages_only") or params.get("stratum") in (
        "first_messages", "first_message_positive", "first_message_negative",
        "paper_first_messages", "paper_candidate", "paper_non_candidate",
        "embedding_sensitivity", "embedding_primary", "embedding_near_verbatim",
        "english_ge_90", "english_ge_80", "english_ge_50")
        or params.get("paper_first_messages_only"))


def _uses_paper_frame(params):
    return bool(params.get("paper_first_messages_only") or params.get("stratum") in (
        "paper_first_messages", "paper_candidate", "paper_non_candidate"))


def _uses_embedding_frame(params):
    return params.get("stratum") in ("embedding_sensitivity", "embedding_primary", "embedding_near_verbatim")


def _uses_language_frame(params):
    return params.get("stratum") in ("english_ge_90", "english_ge_80", "english_ge_50")


def _record_source(params, alias="r"):
    if not _uses_first_message_source(params):
        return f"records {alias}"
    if _uses_embedding_frame(params):
        flags_alias = "embedding_frame_flags" if alias == "r" else "embedding_frame_flags2"
        return (f"(embedding_frame_index.members {flags_alias} JOIN records {alias} "
                f"ON {alias}.id={flags_alias}.record_id)")
    if _uses_language_frame(params):
        flags_alias = "language_frame_flags" if alias == "r" else "language_frame_flags2"
        return (f"(language_frame_index.language_frame_flags {flags_alias} JOIN records {alias} "
                f"ON {alias}.id={flags_alias}.record_id)")
    if _uses_paper_frame(params):
        flags_alias = "paper_frame_flags" if alias == "r" else "paper_frame_flags2"
        return (f"(paper_frame_index.first_messages {flags_alias} JOIN records {alias} "
                f"ON {alias}.id={flags_alias}.record_id)")
    flags_alias = "first_message_flags" if alias == "r" else "first_message_flags2"
    return (f"(first_message_index.first_messages {flags_alias} JOIN records {alias} "
            f"ON {alias}.ordinal={flags_alias}.ordinal)")


def _fts_query(query):
    grams = dict.fromkeys(query[i:i + 3] for i in range(len(query) - 2))
    return " AND ".join('"' + gram.replace('"', '""') + '"' for gram in grams)


def _rows_to_items(con, rows, coref_stats_available, include_context=True, include_duplicate_groups=False,
                   include_paper_duplicates=False):
    items = []
    turns_query = con.cursor()
    coreference_query = con.cursor()
    coreference_cache = {}
    duplicate_cursor = con.cursor() if include_duplicate_groups else None
    paper_duplicate_cursor = con.cursor() if include_paper_duplicates else None
    for row in rows:
        payload = json.loads(row["payload"])
        if include_context:
            context = [{"role": turn["role"], "text": turn["text"], "turnIndex": turn["turn_index"]}
                       for turn in turns_query.execute("SELECT role,text,turn_index FROM turns WHERE conversation_id=? AND turn_index<=? ORDER BY turn_index",
                                                       (row["conversation_id"], row["turn_index"]))]
            payload["context"] = context
            payload["text"] = context[-1]["text"] if context else ""
        else:
            payload.pop("context", None)
            if not isinstance(payload.get("text"), str):
                target = turns_query.execute(
                    "SELECT text FROM turns WHERE conversation_id=? AND turn_index=?",
                    (row["conversation_id"], row["turn_index"]),
                ).fetchone()
                payload["text"] = target["text"] if target else ""
        conversation_id = row["conversation_id"]
        if coref_stats_available and conversation_id not in coreference_cache:
            coreference_cache[conversation_id] = coreference_query.execute(
                "SELECT person_coref_clusters,person_coref_mentions,requester_words,mentions_per_100_words FROM conversation_coreference WHERE conversation_id=?",
                (conversation_id,)).fetchone()
        stats = coreference_cache.get(conversation_id)
        if stats:
            payload.setdefault("metadata", {}).update({
                "personCoreferenceClusters": stats[0],
                "personCoreferenceMentions": stats[1],
                "requesterWords": stats[2],
                "personCoreferencePer100Words": stats[3],
            })
        if duplicate_cursor:
            group = duplicate_cursor.execute(
                "SELECT m.cluster_id,c.member_count FROM duplicate_group_index.members m "
                "JOIN duplicate_group_index.clusters c ON c.cluster_id=m.cluster_id WHERE m.ordinal=?",
                (row["ordinal"],),
            ).fetchone()
            if group:
                payload["duplicateGroup"] = {"id": group[0], "size": group[1]}
        if paper_duplicate_cursor and not payload.get("duplicateGroup"):
            group = paper_duplicate_cursor.execute(
                "SELECT f.duplicate_cluster_id,c.member_count FROM paper_frame_index.first_messages f "
                "JOIN paper_frame_index.clusters c ON c.cluster_id=f.duplicate_cluster_id "
                "WHERE f.record_id=? AND f.is_representative=1 AND f.duplicate_cluster_id IS NOT NULL",
                (payload.get("id", ""),),
            ).fetchone()
            if group:
                payload["duplicateGroup"] = {"id": group[0], "size": group[1]}
        items.append(payload)
    return items


def _result_meta(con, count, page, limit, job_id, complete):
    meta = dict(con.execute("SELECT key,value FROM meta"))
    return {"total": count, "totalKnown": complete, "complete": complete, "page": page, "limit": limit,
            "jobId": job_id, "corpus": int(meta.get("records", 0)), "positive": int(meta.get("positive", 0)),
            "negative": int(meta.get("negative", 0)), "shardCount": int(meta.get("shardCount", 0)),
            "totalSourceShards": int(meta.get("totalSourceShards", 0)), "snapshot": meta.get("snapshot", "")}


def _ordered_record_source(params):
    """Scan records in display order so filtered previews stop at the first page."""
    if _uses_first_message_source(params):
        return _record_source(params)
    # Annotation-status queries provide a short explicit ID list. Let SQLite
    # use the unique records.id index and sort only those matches by ordinal.
    if params.get("include_only"):
        return "records r"
    if params.get("stratum") in ("positive", "negative", "conversation_positive", "conversation_negative"):
        return "records r INDEXED BY records_stratum_order"
    if params.get("stratum") in ("message_positive", "message_negative"):
        return "records r INDEXED BY records_filter_order"
    return "records r NOT INDEXED"


def _record_order(params):
    """Order first-message queries by the covering index's ordinal column.

    The attached first-message index is already ordered by
    (has_person_signal, ordinal). Ordering through records.ordinal made
    SQLite materialise and sort every matching first message before returning
    the first page.
    """
    if _uses_paper_frame(params):
        return "paper_frame_flags.source_shard,paper_frame_flags.source_row"
    if _uses_embedding_frame(params):
        return "embedding_frame_flags.row_index"
    if _uses_language_frame(params):
        return "language_frame_flags.row_index"
    return "first_message_flags.ordinal" if _uses_first_message_source(params) else "r.ordinal"


def _count_record_source(params):
    """Use a covering index for the common stratum plus coreference filter."""
    if _uses_first_message_source(params):
        return _record_source(params)
    if params.get("include_only"):
        return "records r"
    if (params.get("coref_min_mentions") or params.get("coref_min_rate")) and params.get("stratum") in ("positive", "negative", "conversation_positive", "conversation_negative"):
        return "records r INDEXED BY records_stratum_conversation_order"
    if params.get("stratum") in ("message_positive", "message_negative"):
        return "records r INDEXED BY records_filter_order"
    if params.get("coref_min_mentions") or params.get("coref_min_rate"):
        return "records r INDEXED BY records_conversation"
    return "records r"


def _preview_rows(con, q, exact, filters, params, limit):
    if not q:
        source = _ordered_record_source(params)
        return con.execute(f"SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {source} WHERE 1=1{filters} ORDER BY {_record_order(params)} LIMIT :limit",
                           {**params, "limit": limit}).fetchall()
    if _is_identifier_query(q):
        id_clause = "(instr(lower(r.id),lower(:q))>0 OR instr(lower(r.sample_key),lower(:q))>0 OR instr(lower(r.source_conversation_id),lower(:q))>0)"
        candidate_limit = max(256, limit * 12)
        if len(q) >= 3:
            exact_filter = f" AND {_text_condition(q, True, 'turn_search')}" if exact else ""
            source = f"SELECT rowid,conversation_id,turn_index,text FROM turn_search WHERE turn_search MATCH :fts_query{exact_filter} LIMIT :candidate_limit"
            source_params = {"fts_query": _fts_query(q), "candidate_limit": candidate_limit}
            text_condition = _text_condition(q, exact, "s")
        else:
            source = f"SELECT id,conversation_id,turn_index,text FROM turns WHERE {_text_condition(q, exact, 'turns')} ORDER BY id LIMIT :candidate_limit"
            source_params = {"candidate_limit": candidate_limit}
            text_condition = "1=1"
        filters2 = (filters.replace("r.", "r2.")
                    .replace("first_message_flags.", "first_message_flags2.")
                    .replace("paper_frame_flags.", "paper_frame_flags2.")
                    .replace("embedding_frame_flags.", "embedding_frame_flags2.")
                    .replace("language_frame_flags.", "language_frame_flags2."))
        sql = f"""SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {_record_source(params, 'r')}
          JOIN (SELECT ordinal FROM (
            SELECT r.ordinal AS ordinal FROM {_record_source(params, 'r')} WHERE 1=1{filters} AND {id_clause}
            UNION
            SELECT r2.ordinal AS ordinal FROM ({source}) s JOIN {_record_source(params, 'r2')}
              ON r2.conversation_id=s.conversation_id AND s.turn_index<=r2.turn_index
            WHERE {text_condition}{filters2}
          ) ORDER BY ordinal LIMIT :limit) m ON m.ordinal=r.ordinal
          ORDER BY r.ordinal"""
        return con.execute(sql, {**params, **source_params, "limit": limit}).fetchall()

    text_condition = _text_condition(q, exact, "s")
    filters2 = (filters.replace("r.", "r2.")
                .replace("first_message_flags.", "first_message_flags2.")
                .replace("paper_frame_flags.", "paper_frame_flags2.")
                .replace("embedding_frame_flags.", "embedding_frame_flags2.")
                .replace("language_frame_flags.", "language_frame_flags2."))
    candidate_limit = max(256, limit * 12)
    while True:
        if _CANCELLED:
            raise sqlite3.OperationalError("interrupted")
        if len(q) >= 3:
            # FTS5 can stop as soon as the bounded candidate set is full. Sorting
            # the full posting list by rowid first made common terms slow here.
            # Exact terms are checked before LIMIT so Alexandria cannot crowd
            # Alex out of the quick preview candidate set.
            exact_filter = f" AND {_text_condition(q, True, 'turn_search')}" if exact else ""
            source = f"SELECT rowid,conversation_id,turn_index,text FROM turn_search WHERE turn_search MATCH :fts_query{exact_filter} LIMIT :candidate_limit"
            extra = "turn_search"
            query_params = {**params, "fts_query": _fts_query(q), "candidate_limit": candidate_limit, "limit": limit}
        else:
            source = f"SELECT id,conversation_id,turn_index,text FROM turns WHERE {_text_condition(q, exact, 'turns')} ORDER BY id LIMIT :candidate_limit"
            extra = "turns"
            query_params = {**params, "candidate_limit": candidate_limit, "limit": limit}
        sql = f"""SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {_record_source(params, 'r')}
          JOIN (SELECT r2.ordinal FROM ({source}) s JOIN {_record_source(params, 'r2')}
            ON r2.conversation_id=s.conversation_id AND s.turn_index<=r2.turn_index
            WHERE {text_condition if extra == 'turn_search' else '1=1'}{filters2}
            GROUP BY r2.ordinal ORDER BY r2.ordinal LIMIT :limit) m ON m.ordinal=r.ordinal
          ORDER BY r.ordinal"""
        rows = con.execute(sql, query_params).fetchall()
        if rows or candidate_limit >= 65536:
            return rows
        candidate_limit *= 4


def _fetch_result_page(con, table, page, limit):
    return con.execute(f"SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {table} s JOIN records r ON r.ordinal=s.ordinal ORDER BY r.ordinal LIMIT :limit OFFSET :offset",
                       {"limit": limit, "offset": (page - 1) * limit}).fetchall()


def _precomputed_first_message_count(con, request, params):
    """Use first-message sidecars for exact counts without scanning the corpus."""
    if not _uses_first_message_source(params):
        return None
    if (request.get("q") or request.get("signals") or request.get("presidio")
            or request.get("coref_min_mentions") or request.get("coref_min_rate")):
        return None
    stratum = params.get("stratum", "all")
    if params.get("ctp_label"):
        try:
            total = int(dict(con.execute(
                "SELECT key,value FROM ctp_screening_index.meta"
            )).get(f"label_{params['ctp_label']}", "-1"))
        except sqlite3.Error:
            return None
        if total < 0:
            return None
        if params.get("include_only"):
            return int(con.execute(
                "SELECT count(*) FROM json_each(:include) i "
                "JOIN language_frame_index.language_frame_flags lf "
                "ON lf.record_id=i.value AND lf.frame_id='english_ge_90' "
                "JOIN ctp_screening_index.ctp_results c ON c.record_id=i.value "
                "WHERE c.label=:ctp_label AND NOT EXISTS "
                "(SELECT 1 FROM json_each(:exclude) e WHERE e.value=i.value)", params
            ).fetchone()[0])
        if params.get("exclude"):
            removed = int(con.execute(
                "SELECT count(*) FROM json_each(:exclude) e "
                "JOIN ctp_screening_index.ctp_results c ON c.record_id=e.value "
                "JOIN language_frame_index.language_frame_flags lf "
                "ON lf.record_id=c.record_id AND lf.frame_id='english_ge_90' "
                "WHERE c.label=:ctp_label", params
            ).fetchone()[0])
            return max(0, total - removed)
        return total
    if _uses_embedding_frame(params):
        try:
            total = int(con.execute(
                "SELECT retained_records FROM embedding_frame_index.frames WHERE frame_id=:frame_id",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
        except (sqlite3.Error, TypeError):
            return None
        if params.get("include_only"):
            return int(con.execute(
                "SELECT count(*) FROM json_each(:include) i JOIN records r ON r.id=i.value "
                "JOIN embedding_frame_index.members f ON f.record_id=r.id "
                "WHERE f.frame_id=:frame_id AND NOT EXISTS "
                "(SELECT 1 FROM json_each(:exclude) e WHERE e.value=r.id)",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
        if params.get("exclude"):
            removed = int(con.execute(
                "SELECT count(*) FROM json_each(:exclude) e JOIN records r ON r.id=e.value "
                "JOIN embedding_frame_index.members f ON f.record_id=r.id WHERE f.frame_id=:frame_id",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
            return max(0, total - removed)
        return total
    if _uses_language_frame(params):
        try:
            total = int(con.execute(
                "SELECT retained_records FROM language_frame_index.frames WHERE frame_id=:frame_id",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
        except (sqlite3.Error, TypeError):
            return None
        if params.get("include_only"):
            return int(con.execute(
                "SELECT count(*) FROM json_each(:include) i JOIN language_frame_index.language_frame_flags f "
                "ON f.record_id=i.value AND f.frame_id=:frame_id "
                "WHERE NOT EXISTS (SELECT 1 FROM json_each(:exclude) e WHERE e.value=i.value)",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
        if params.get("exclude"):
            removed = int(con.execute(
                "SELECT count(*) FROM json_each(:exclude) e JOIN language_frame_index.language_frame_flags f "
                "ON f.record_id=e.value WHERE f.frame_id=:frame_id",
                {**params, "frame_id": stratum},
            ).fetchone()[0])
            return max(0, total - removed)
        return total
    if _uses_paper_frame(params):
        key = "retained_first_messages"
        signal_filter = " AND f.is_representative=1"
        if stratum == "paper_candidate":
            key = "retained_person_signal"
            signal_filter += " AND f.has_person_signal=1"
        elif stratum == "paper_non_candidate":
            key = "retained_no_person_signal"
            signal_filter += " AND f.has_person_signal=0"
        try:
            meta = dict(con.execute("SELECT key,value FROM paper_frame_index.meta"))
            total = int(meta[key])
        except (sqlite3.Error, KeyError, ValueError):
            return None
        if params.get("include_only"):
            return int(con.execute(
                "SELECT count(*) FROM json_each(:include) i JOIN records r ON r.id=i.value "
                "JOIN paper_frame_index.first_messages f ON f.record_id=r.id "
                f"WHERE 1=1{signal_filter} "
                "AND NOT EXISTS (SELECT 1 FROM json_each(:exclude) e WHERE e.value=r.id)", params).fetchone()[0])
        if params.get("exclude"):
            removed = con.execute(
                "SELECT count(*) FROM json_each(:exclude) e JOIN records r ON r.id=e.value "
                "JOIN paper_frame_index.first_messages f ON f.record_id=r.id "
                f"WHERE 1=1{signal_filter}", params).fetchone()[0]
            return max(0, total - int(removed))
        return total

    signal_filter = ""
    key = "all"
    if stratum == "first_message_positive":
        key = "positive"
        signal_filter = " AND f.has_person_signal=1"
    elif stratum == "first_message_negative":
        key = "negative"
        signal_filter = " AND f.has_person_signal=0"
    elif stratum != "first_messages" and not params.get("first_messages_only"):
        return None
    try:
        meta = dict(con.execute("SELECT key,value FROM first_message_index.meta"))
        total = int(meta[key])
    except (sqlite3.Error, KeyError, ValueError):
        return None

    if params.get("include_only"):
        included_count = con.execute(
            "SELECT count(*) FROM json_each(:include) i "
            "JOIN records r ON r.id=i.value "
            "JOIN first_message_index.first_messages f ON f.ordinal=r.ordinal "
            f"WHERE 1=1{signal_filter} "
            "AND NOT EXISTS (SELECT 1 FROM json_each(:exclude) e WHERE e.value=r.id)",
            params,
        ).fetchone()[0]
        return int(included_count)

    if params.get("exclude"):
        excluded_count = con.execute(
            "SELECT count(*) FROM json_each(:exclude) e "
            "JOIN records r ON r.id=e.value "
            "JOIN first_message_index.first_messages f ON f.ordinal=r.ordinal "
            f"WHERE 1=1{signal_filter}",
            params,
        ).fetchone()[0]
        return max(0, total - int(excluded_count))
    return total


def execute_sample(request, con, emit=None):
    """Export a deterministic seeded sample from the complete active result set."""
    supported_units = ("messages", "conversations", "first_messages", "paper_first_messages",
                       "embedding_sensitivity", "embedding_primary", "embedding_near_verbatim",
                       "english_ge_90", "english_ge_80", "english_ge_50")
    unit = request.get("unit") if request.get("unit") in supported_units else "messages"
    count = min(5000, max(1, int(request.get("sample_n", 1))))
    seed = str(request.get("seed", "wildchat-prescreen-v1"))[:200]
    query_id = uuid.uuid4().hex
    candidates = f"sample_candidates_{query_id}"
    raw_query = str(request.get("q", "")).strip()
    exact_search = len(raw_query) >= 2 and raw_query.startswith('"') and raw_query.endswith('"')
    q = raw_query[1:-1].strip() if exact_search else raw_query
    coref_stats_available = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_coreference'").fetchone() is not None
    params = {"q": q, "stratum": request.get("stratum", "all"),
              "exclude": json.dumps(request.get("exclude", [])),
              "include": json.dumps(request.get("include", [])),
              "ctp_label": request.get("ctp_label", ""),
              "include_only": bool(request.get("include_only")),
              "first_messages_only": bool(request.get("first_messages_only")) or unit == "first_messages",
              "paper_first_messages_only": unit == "paper_first_messages"}
    if unit in ("embedding_sensitivity", "embedding_primary", "embedding_near_verbatim"):
        params["stratum"] = unit
    if unit in ("english_ge_90", "english_ge_80", "english_ge_50"):
        params["stratum"] = unit
    if _uses_paper_frame(params):
        _require_paper_frame(con)
    if _uses_embedding_frame(params):
        _require_embedding_frame(con)
    if _uses_language_frame(params):
        _require_language_frame(con, params["stratum"])
    include_ctp_labels = unit == "english_ge_90"
    if request.get("ctp_label"):
        if params.get("stratum") != "english_ge_90":
            raise ValueError("CTP screening labels are available only within the ≥90% English paper frame.")
        _require_ctp_screening(con)
    elif unit == "english_ge_90" and not request.get("ids_only"):
        _require_ctp_screening(con)
    filter_request = dict(request)
    if unit in ("embedding_sensitivity", "embedding_primary", "embedding_near_verbatim"):
        filter_request["stratum"] = unit
    if unit in ("english_ge_90", "english_ge_80", "english_ge_50"):
        filter_request["stratum"] = unit
    filters = _base_filters(filter_request, params, coref_stats_available)
    con.execute(f"CREATE TEMP TABLE {candidates}(ordinal INTEGER PRIMARY KEY,conversation_id TEXT NOT NULL,turn_index INTEGER NOT NULL) WITHOUT ROWID")
    if q:
        hits = f"sample_hits_{query_id}"
        con.execute(f"CREATE TEMP TABLE {hits}(conversation_id TEXT PRIMARY KEY,first_turn INTEGER) WITHOUT ROWID")
        if len(q) >= 3:
            con.execute(f"INSERT INTO {hits} SELECT conversation_id,min(turn_index) FROM turn_search WHERE turn_search MATCH :fts_query AND {_text_condition(q, exact_search, 'turn_search')} GROUP BY conversation_id",
                        {**params, "fts_query": _fts_query(q)})
        else:
            con.execute(f"INSERT INTO {hits} SELECT conversation_id,min(turn_index) FROM turns WHERE {_text_condition(q, exact_search, 'turns')} GROUP BY conversation_id", params)
        text_match = f"EXISTS (SELECT 1 FROM {hits} h WHERE h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index)"
        if _is_identifier_query(q):
            filters += f" AND (instr(lower(r.id),lower(:q))>0 OR instr(lower(r.sample_key),lower(:q))>0 OR instr(lower(r.source_conversation_id),lower(:q))>0 OR {text_match})"
            con.execute(f"INSERT INTO {candidates} SELECT r.ordinal,r.conversation_id,r.turn_index FROM {_record_source(params)} WHERE 1=1{filters}", params)
        else:
            con.execute(f"INSERT INTO {candidates} SELECT r.ordinal,r.conversation_id,r.turn_index FROM {hits} h JOIN {_record_source(params)} ON h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index WHERE 1=1{filters}", params)
        con.execute(f"DROP TABLE {hits}")
    else:
        source = _ordered_record_source(params)
        con.execute(f"INSERT INTO {candidates} SELECT r.ordinal,r.conversation_id,r.turn_index FROM {source} WHERE 1=1{filters}", params)

    if unit == "conversations":
        con.execute(f"CREATE TEMP TABLE {candidates}_units AS SELECT DISTINCT conversation_id AS stable_id FROM {candidates}")
        unit_table, stable_column = f"{candidates}_units", "stable_id"
        total = con.execute(f"SELECT count(*) FROM {unit_table}").fetchone()[0]
    else:
        unit_table, stable_column = candidates, "ordinal"
        total = con.execute(f"SELECT count(*) FROM {unit_table}").fetchone()[0]

    def stable_rank(_seed_value, value):
        value = str(value)
        digest = hashlib.blake2b((seed + "\\0" + value).encode("utf-8"), digest_size=16).digest()
        return digest
    con.create_function("stable_sample_rank", 2, stable_rank, deterministic=True)
    selected = con.execute(f"SELECT {stable_column} FROM {unit_table} ORDER BY stable_sample_rank(:seed,{stable_column}),{stable_column} LIMIT :count",
                           {"seed": seed, "count": count}).fetchall()
    record_ids = []
    record_id_groups = []
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    if unit == "conversations":
        if not request.get("ids_only"):
            writer.writerow(["conversation_id", "conversation_person_signals", "message_count", "conversation"])
        for item in selected:
            conversation_id = item[0]
            if request.get("ids_only"):
                conversation_record_ids = [row[0] for row in con.execute(
                    "SELECT id FROM records WHERE conversation_id=? ORDER BY turn_index", (conversation_id,))]
                record_ids.extend(conversation_record_ids)
                record_id_groups.append({"unitId": conversation_id, "recordIds": conversation_record_ids})
                continue
            record = con.execute(f"SELECT r.id,r.payload FROM {candidates} s JOIN records r ON r.ordinal=s.ordinal WHERE s.conversation_id=? ORDER BY r.turn_index LIMIT 1", (conversation_id,)).fetchone()
            if not record:
                continue
            record_ids.append(record["id"])
            payload = json.loads(record["payload"])
            turns = [{"turnIndex": turn["turn_index"], "role": turn["role"], "text": turn["text"]}
                     for turn in con.execute("SELECT role,text,turn_index FROM turns WHERE conversation_id=? ORDER BY turn_index", (conversation_id,)).fetchall()]
            message_count = con.execute("SELECT count(*) FROM records WHERE conversation_id=?", (conversation_id,)).fetchone()[0]
            writer.writerow([payload.get("source_conversation_id", conversation_id), payload.get("stratum", ""), message_count, json.dumps(turns, ensure_ascii=False, separators=(",", ":"))])
    else:
        if not request.get("ids_only"):
            columns = ["message_id", "conversation_id", "turn_index", "conversation_person_signals", "message_text", "context"]
            if include_ctp_labels:
                columns.append("ctp_screening_label")
            writer.writerow(columns)
        for item in selected:
            if request.get("ids_only"):
                row = con.execute(f"SELECT r.id,r.conversation_id FROM {candidates} s JOIN records r ON r.ordinal=s.ordinal WHERE r.ordinal=?", (item[0],)).fetchone()
            elif include_ctp_labels:
                row = con.execute(f"SELECT r.id,r.payload,r.conversation_id,r.turn_index,ctp.label AS ctp_label FROM {candidates} s JOIN records r ON r.ordinal=s.ordinal JOIN ctp_screening_index.ctp_results ctp ON ctp.record_id=r.id WHERE r.ordinal=?", (item[0],)).fetchone()
            else:
                row = con.execute(f"SELECT r.id,r.payload,r.conversation_id,r.turn_index FROM {candidates} s JOIN records r ON r.ordinal=s.ordinal WHERE r.ordinal=?", (item[0],)).fetchone()
            record_ids.append(row["id"])
            if request.get("ids_only"):
                continue
            payload = json.loads(row["payload"])
            turns = con.execute("SELECT role,text,turn_index FROM turns WHERE conversation_id=? AND turn_index<=? ORDER BY turn_index", (row["conversation_id"], row["turn_index"])).fetchall()
            transcript = [{"turnIndex": turn["turn_index"], "role": turn["role"], "text": turn["text"]} for turn in turns]
            values = [payload.get("id", ""), payload.get("source_conversation_id", row["conversation_id"]), row["turn_index"], payload.get("stratum", ""), turns[-1]["text"] if turns else "", json.dumps(transcript, ensure_ascii=False, separators=(",", ":"))]
            if include_ctp_labels:
                values.append(row["ctp_label"])
            writer.writerow(values)
    result = {"event": "sample", "payload": {"csv": output.getvalue(), "recordIds": record_ids, "recordIdGroups": record_id_groups, "total": total, "sampled": len(record_ids), "unitsSampled": len(selected), "unit": unit, "seed": seed}}
    con.execute(f"DROP TABLE IF EXISTS {unit_table}")
    con.execute(f"DROP TABLE IF EXISTS {candidates}")
    if emit:
        emit(result)
        return None
    return result


def _require_duplicate_index(con):
    try:
        index_meta = dict(con.execute("SELECT key,value FROM duplicate_group_index.meta"))
        record_meta = dict(con.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','records')"))
    except sqlite3.Error as error:
        raise ValueError("Unique browsing is unavailable because the duplicate-group index is missing.") from error
    if index_meta.get("fingerprint") != record_meta.get("fingerprint"):
        raise ValueError("The duplicate-group index does not match the active annotation frame.")
    if index_meta.get("records") != record_meta.get("records"):
        raise ValueError("The duplicate-group index has a different record count from the active frame.")
    return index_meta


def _require_paper_frame(con):
    try:
        frame_meta = dict(con.execute("SELECT key,value FROM paper_frame_index.meta"))
        record_meta = dict(con.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','records')"))
    except sqlite3.Error as error:
        raise ValueError("The paper first-message frame is not installed.") from error
    if frame_meta.get("input_fingerprint") != record_meta.get("fingerprint"):
        raise ValueError("The paper first-message frame does not match the active annotation index.")
    if (int(frame_meta.get("all_first_messages", 0))
            != int(frame_meta.get("retained_first_messages", 0))
            + int(frame_meta.get("removed_duplicate_rows", 0))):
        raise ValueError("The paper first-message frame counts do not reconcile.")
    try:
        first_message_count = dict(con.execute("SELECT key,value FROM first_message_index.meta")).get("all")
        if first_message_count and first_message_count != frame_meta.get("all_first_messages"):
            raise ValueError("The paper first-message frame has a different source count.")
    except sqlite3.Error:
        pass
    return frame_meta


def _require_embedding_frame(con):
    """Fail closed if the embedding-derived message frames are stale or incomplete."""
    try:
        frame_meta = dict(con.execute("SELECT key,value FROM embedding_frame_index.meta"))
        record_meta = dict(con.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','records')"))
        paper_meta = dict(con.execute("SELECT key,value FROM paper_frame_index.meta"))
        similarity_meta = dict(con.execute("SELECT key,value FROM embedding_similarity_index.meta"))
    except sqlite3.Error as error:
        raise ValueError("The embedding-deduplicated first-message frames are not fully installed.") from error

    if frame_meta.get("schema_version") != "1":
        raise ValueError("The embedding-deduplicated frame schema is unsupported.")
    fingerprint = record_meta.get("fingerprint")
    if (not fingerprint or frame_meta.get("source_frame_fingerprint") != fingerprint
            or paper_meta.get("input_fingerprint") != fingerprint
            or similarity_meta.get("source_frame_fingerprint") != fingerprint):
        raise ValueError("The embedding-deduplicated frames do not match the active annotation frame.")
    if (frame_meta.get("source_similarity_input_sha256") != similarity_meta.get("source_input_sha256")
            or frame_meta.get("source_records") != similarity_meta.get("records")
            or frame_meta.get("source_pairs_ge_0_995") != similarity_meta.get("unique_undirected_pairs_ge_0_995")):
        raise ValueError("The embedding-deduplicated frames do not match the installed similarity index.")

    source_records = int(frame_meta.get("source_records", "-1"))
    indexed_records = int(record_meta.get("records", "-1"))
    paper_candidates = int(paper_meta.get("retained_person_signal", "-1"))
    if source_records > indexed_records or source_records != paper_candidates:
        raise ValueError("The embedding-deduplicated frames have a different input population.")
    count_meta_keys = {
        "embedding_sensitivity": "embedding_sensitivity_count",
        "embedding_primary": "embedding_primary_count",
        "embedding_near_verbatim": "embedding_near_verbatim_count",
    }
    for frame_id, count_key in count_meta_keys.items():
        row = con.execute("SELECT input_records,retained_records,removed_records FROM embedding_frame_index.frames WHERE frame_id=?",
                          (frame_id,)).fetchone()
        if (not row or int(row[0]) != source_records
                or int(row[1]) + int(row[2]) != source_records
                or int(row[1]) != int(frame_meta.get(count_key, "-1"))):
            raise ValueError(f"The embedding-deduplicated frame {frame_id} has unreconciled counts.")
    return frame_meta


def _require_language_frame(con, frame_id=None):
    """Fail closed if the requested English-share frame matches this index."""
    try:
        frame_meta = dict(con.execute("SELECT key,value FROM language_frame_index.meta"))
        record_meta = dict(con.execute("SELECT key,value FROM meta WHERE key IN ('fingerprint','records')"))
    except sqlite3.Error as error:
        raise ValueError("The English-share screening frames are not installed.") from error
    if frame_meta.get("schema_version") != "1":
        raise ValueError("The English-share frame schema is unsupported.")
    if (not record_meta.get("fingerprint")
            or frame_meta.get("source_annotation_fingerprint") != record_meta.get("fingerprint")):
        raise ValueError("The English-share frames do not match the active annotation index.")
    if frame_meta.get("source_embedding_frame_id") != "embedding_near_verbatim":
        raise ValueError("The English-share frames use an unexpected source embedding frame.")
    source_count = int(frame_meta.get("source_embedding_frame_records", "-1"))
    normalized_count = int(frame_meta.get("source_short_normalized_frame_records", "-1"))
    excluded_count = int(frame_meta.get("short_normalized_exclusions", "-1"))
    if frame_id == "english_ge_90":
        try:
            selected_count = int(con.execute(
                "SELECT retained_records FROM language_frame_index.frames WHERE frame_id=?", (frame_id,)
            ).fetchone()[0])
        except (sqlite3.Error, TypeError):
            raise ValueError("The ≥90% English paper frame is unavailable.")
        if source_count != 904_667 or normalized_count + excluded_count != source_count or selected_count != 308_962:
            raise ValueError("The ≥90% English paper frame has unexpected source or member counts.")
        return frame_meta
    try:
        embedding_meta = dict(con.execute("SELECT key,value FROM embedding_frame_index.meta"))
    except sqlite3.Error as error:
        raise ValueError("The embedding source frame is not installed.") from error
    if embedding_meta.get("source_frame_fingerprint") != record_meta.get("fingerprint"):
        raise ValueError("The English-share frames do not match the active embedding source.")
    if source_count != int(embedding_meta.get("embedding_near_verbatim_count", "-2")):
        raise ValueError("The English-share frames have a different embedding source population.")
    if normalized_count + excluded_count != source_count:
        raise ValueError("The English-share normalized frame counts do not reconcile.")
    expected_counts = {"english_ge_90": 308_962, "english_ge_80": 320_025, "english_ge_50": 338_083}
    frame_rows = {frame_id: int(count) for frame_id, count in con.execute(
        "SELECT frame_id,retained_records FROM language_frame_index.frames")}
    if frame_rows != expected_counts:
        raise ValueError(f"English-share frame counts are unexpected or incomplete: {frame_rows}")
    if not (frame_rows["english_ge_90"] <= frame_rows["english_ge_80"] <= frame_rows["english_ge_50"] <= normalized_count):
        raise ValueError("English-share cumulative frames are not nested or exceed their source frame.")
    for frame_id, expected_count in expected_counts.items():
        actual_count = con.execute(
            "SELECT count(*) FROM language_frame_index.language_frame_flags WHERE frame_id=?", (frame_id,)
        ).fetchone()[0]
        if int(actual_count) != expected_count:
            raise ValueError(f"English-share frame {frame_id} has an unreconciled member count.")
    return frame_meta


def _require_ctp_screening(con):
    return require_ctp_screening(con)


def get_ctp_counts(con):
    """Return the verified Browse counts for the three saved CTP decisions."""
    return _require_ctp_screening(con)


def filter_frame_ids(request, con):
    """Return requested annotation IDs that belong to the chosen saved frame."""
    frame_id = request.get("frame_id")
    if frame_id != "english_ge_90":
        raise ValueError("Only the ≥90% English paper frame is available for annotation queues.")
    record_ids = request.get("record_ids")
    if not isinstance(record_ids, list) or len(record_ids) > 1_000_000:
        raise ValueError("Provide at most 1,000,000 record IDs.")
    if any(not isinstance(record_id, str) or len(record_id) > 128 for record_id in record_ids):
        raise ValueError("Record IDs must be strings of at most 128 characters.")
    _require_language_frame(con, frame_id)
    if not record_ids:
        return {"recordIds": []}
    rows = con.execute(
        "SELECT input.value FROM json_each(:record_ids) input "
        "JOIN language_frame_index.language_frame_flags frame "
        "ON frame.record_id=input.value AND frame.frame_id=:frame_id "
        "ORDER BY CAST(input.key AS INTEGER)",
        {"record_ids": json.dumps(record_ids), "frame_id": frame_id},
    ).fetchall()
    return {"recordIds": [row[0] for row in rows]}


def _create_unique_representatives(con, job_id, params, filters, raw_table=None):
    """Select the first matching member of each duplicate cluster.

    This runs after the active search, stratum, screening, and record-ID filters,
    so a cluster remains visible whenever any of its members matches.
    """
    matches_table = f"unique_matches_{job_id}"
    reps_table = f"unique_reps_{job_id}"
    con.execute(f"DROP TABLE IF EXISTS {matches_table}")
    con.execute(f"DROP TABLE IF EXISTS {reps_table}")
    con.execute(f"CREATE TEMP TABLE {matches_table}(ordinal INTEGER PRIMARY KEY,cluster_id TEXT NOT NULL) WITHOUT ROWID")
    if raw_table:
        con.execute(f"""INSERT INTO {matches_table}
            SELECT r.ordinal,d.cluster_id FROM {raw_table} s
            JOIN records r ON r.ordinal=s.ordinal
            JOIN duplicate_group_index.members d ON d.ordinal=r.ordinal""")
    else:
        source = _record_source(params)
        con.execute(f"""INSERT INTO {matches_table}
            SELECT r.ordinal,d.cluster_id FROM {source}
            JOIN duplicate_group_index.members d ON d.ordinal=r.ordinal
            WHERE 1=1{filters}""", params)
    duplicate_members = con.execute(f"SELECT count(*) FROM {matches_table}").fetchone()[0]
    con.execute(f"CREATE TEMP TABLE {reps_table}(ordinal INTEGER PRIMARY KEY,cluster_id TEXT NOT NULL) WITHOUT ROWID")
    con.execute(f"INSERT INTO {reps_table} SELECT min(ordinal),cluster_id FROM {matches_table} GROUP BY cluster_id")
    representative_count = con.execute(f"SELECT count(*) FROM {reps_table}").fetchone()[0]
    con.execute(f"DROP TABLE {matches_table}")
    return reps_table, int(duplicate_members), int(representative_count)


def _fetch_unique_page(con, state, page, limit, include_context=True):
    params = {**state["params"], "limit": limit, "offset": (page - 1) * limit}
    representatives = state["representatives"]
    visible_member = (
        "(NOT EXISTS (SELECT 1 FROM duplicate_group_index.members dm WHERE dm.ordinal=r.ordinal) "
        f"OR EXISTS (SELECT 1 FROM {representatives} dr WHERE dr.ordinal=r.ordinal))"
    )
    if state.get("raw_table"):
        source = f"{state['raw_table']} s JOIN records r ON r.ordinal=s.ordinal"
        filters = ""
    else:
        source = _record_source(state["params"])
        filters = state["filters"]
    return con.execute(
        f"SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {source} "
        f"WHERE 1=1{filters} AND {visible_member} ORDER BY r.ordinal LIMIT :limit OFFSET :offset",
        params,
    ).fetchall()


def _drop_job_tables(con, state):
    if isinstance(state, dict):
        for key in ("raw_table", "representatives", "cluster_table"):
            table = state.get(key)
            if table:
                con.execute(f"DROP TABLE IF EXISTS {table}")
        return
    if state:
        con.execute(f"DROP TABLE IF EXISTS {state[0]}")


def _cache_job(con, cache, job_id, state):
    if cache is None:
        return
    cache[job_id] = state
    cache.move_to_end(job_id)
    while len(cache) > 6:
        _old_job, old_state = cache.popitem(last=False)
        _drop_job_tables(con, old_state)


def _cluster_search(request, con, emit, cache, job_id, page, limit):
    cluster_id = str(request.get("duplicate_cluster_id") or "")
    if cluster_id.startswith("pf_"):
        return _paper_cluster_search(request, con, emit, cache, job_id, page, limit, cluster_id)
    index_meta = _require_duplicate_index(con)
    if not cluster_id.startswith("tc_") or not cluster_id[3:].isdigit() or len(cluster_id) > 32:
        raise ValueError("Invalid duplicate-cluster identifier.")
    params = {"cluster_id": cluster_id}
    total = con.execute(
        "SELECT member_count FROM duplicate_group_index.clusters WHERE cluster_id=:cluster_id", params
    ).fetchone()
    total = int(total[0]) if total else 0
    cluster_table = f"cluster_rows_{job_id}"
    con.execute(f"DROP TABLE IF EXISTS {cluster_table}")
    con.execute(f"CREATE TEMP TABLE {cluster_table}(ordinal INTEGER PRIMARY KEY) WITHOUT ROWID")
    con.execute(f"INSERT INTO {cluster_table} SELECT ordinal FROM duplicate_group_index.members WHERE cluster_id=:cluster_id", params)
    rows = con.execute(
        f"SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {cluster_table} c "
        "JOIN records r ON r.ordinal=c.ordinal ORDER BY r.ordinal LIMIT :limit OFFSET :offset",
        {**params, "limit": limit, "offset": (page - 1) * limit},
    ).fetchall()
    state = {"kind": "cluster", "cluster_id": cluster_id, "total": total, "cluster_table": cluster_table}
    _cache_job(con, cache, job_id, state)
    coref_stats = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_coreference'"
    ).fetchone() is not None
    payload = _result_meta(con, total, page, limit, job_id, True)
    payload["duplicateClusterId"] = cluster_id
    payload["duplicateClusterSize"] = total
    payload["items"] = _rows_to_items(con, rows, coref_stats, bool(request.get("include_context", True)), True)
    payload["uniqueCorpus"] = int(index_meta["unique_entries"])
    event = {"event": "complete", "jobId": job_id, "payload": payload}
    if emit:
        emit(event)
        return None
    return payload


def _paper_cluster_search(request, con, emit, cache, job_id, page, limit, cluster_id):
    _require_paper_frame(con)
    if not cluster_id[3:].isdigit() or len(cluster_id) > 32:
        raise ValueError("Invalid first-message duplicate-cluster identifier.")
    params = {"cluster_id": cluster_id}
    total_row = con.execute(
        "SELECT member_count FROM paper_frame_index.clusters WHERE cluster_id=:cluster_id", params).fetchone()
    total = int(total_row[0]) if total_row else 0
    rows = con.execute("""SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index
        FROM paper_frame_index.members m JOIN records r ON r.id=m.record_id
        WHERE m.cluster_id=:cluster_id
        ORDER BY m.source_shard,m.source_row LIMIT :limit OFFSET :offset""",
        {**params, "limit": limit, "offset": (page - 1) * limit}).fetchall()
    state = {"kind": "paper_cluster", "cluster_id": cluster_id, "total": total}
    _cache_job(con, cache, job_id, state)
    coref_stats = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_coreference'").fetchone() is not None
    payload = _result_meta(con, total, page, limit, job_id, True)
    payload["duplicateClusterId"] = cluster_id
    payload["duplicateClusterSize"] = total
    payload["items"] = _rows_to_items(con, rows, coref_stats, bool(request.get("include_context", True)),
                                      include_paper_duplicates=True)
    event = {"event": "complete", "jobId": job_id, "payload": payload}
    if emit:
        emit(event)
        return None
    return payload


def _unique_search(request, con, emit, cache, job_id, page, limit, q, exact_search, params, filters):
    _require_duplicate_index(con)
    result_table = f"search_{job_id}"
    raw_table = None
    if q:
        raw_table = result_table
        con.execute(f"DROP TABLE IF EXISTS {raw_table}")
        con.execute(f"CREATE TEMP TABLE {raw_table}(ordinal INTEGER PRIMARY KEY) WITHOUT ROWID")
        hits_table = f"hits_{job_id}"
        con.execute(f"CREATE TEMP TABLE {hits_table}(conversation_id TEXT PRIMARY KEY,first_turn INTEGER) WITHOUT ROWID")
        if len(q) >= 3:
            con.execute(
                f"INSERT INTO {hits_table} SELECT conversation_id,min(turn_index) FROM turn_search "
                "WHERE turn_search MATCH :fts_query AND " + _text_condition(q, exact_search, "turn_search") + " GROUP BY conversation_id",
                {**params, "fts_query": _fts_query(q)},
            )
        else:
            con.execute(
                f"INSERT INTO {hits_table} SELECT conversation_id,min(turn_index) FROM turns WHERE {_text_condition(q, exact_search, 'turns')} GROUP BY conversation_id",
                params,
            )
        text_match = f"EXISTS (SELECT 1 FROM {hits_table} h WHERE h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index)"
        if _is_identifier_query(q):
            filters += f" AND (instr(lower(r.id),lower(:q))>0 OR instr(lower(r.sample_key),lower(:q))>0 OR instr(lower(r.source_conversation_id),lower(:q))>0 OR {text_match})"
            con.execute(f"INSERT INTO {raw_table} SELECT r.ordinal FROM {_record_source(params)} WHERE 1=1{filters}", params)
        else:
            con.execute(
                f"INSERT INTO {raw_table} SELECT r.ordinal FROM {hits_table} h JOIN {_record_source(params)} "
                "ON h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index WHERE 1=1" + filters,
                params,
            )
        con.execute(f"DROP TABLE {hits_table}")
        base_count = int(con.execute(f"SELECT count(*) FROM {raw_table}").fetchone()[0])
        reps, duplicate_members, representative_count = _create_unique_representatives(con, job_id, params, "", raw_table)
    else:
        count_source = _count_record_source(params)
        base_count = _precomputed_first_message_count(con, request, params)
        if base_count is None:
            base_count = int(con.execute(f"SELECT count(*) FROM {count_source} WHERE 1=1{filters}", params).fetchone()[0])
        reps, duplicate_members, representative_count = _create_unique_representatives(con, job_id, params, filters)
    total = max(0, int(base_count) - duplicate_members + representative_count)
    state = {
        "kind": "unique", "raw_table": raw_table, "representatives": reps,
        "params": params, "filters": filters, "total": total,
    }
    rows = _fetch_unique_page(con, state, page, limit, bool(request.get("include_context", True)))
    coref_stats = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_coreference'"
    ).fetchone() is not None
    items = _rows_to_items(con, rows, coref_stats, bool(request.get("include_context", True)), True)
    if emit and page == 1:
        preview = _result_meta(con, 0, page, limit, job_id, False)
        preview["items"] = items
        emit({"event": "preview", "jobId": job_id, "payload": preview})
    _cache_job(con, cache, job_id, state)
    payload = _result_meta(con, total, page, limit, job_id, True)
    payload["items"] = items
    event = {"event": "complete", "jobId": job_id, "payload": payload}
    if emit:
        emit(event)
        return None
    return payload


def execute_search(request, con, emit=None, cache=None):
    action = request.get("action", "search")
    if action == "sample":
        return execute_sample(request, con, emit)
    job_id = str(request.get("jobId") or uuid.uuid4().hex).replace("-", "")
    if not job_id.isalnum() or len(job_id) > 64:
        raise ValueError("Invalid search job identifier")
    page = max(1, int(request.get("page", 1)))
    limit = min(50, max(1, int(request.get("limit", 24))))
    coref_stats_available = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_coreference'").fetchone() is not None

    if action == "page":
        cached = (cache or {}).get(job_id)
        if not cached:
            return {"event": "cache_miss", "jobId": job_id}
        if isinstance(cached, dict) and cached.get("kind") == "unique":
            rows = _fetch_unique_page(con, cached, page, limit, bool(request.get("include_context", True)))
            payload = _result_meta(con, cached["total"], page, limit, job_id, True)
            payload["items"] = _rows_to_items(con, rows, coref_stats_available, bool(request.get("include_context", True)), True)
        elif isinstance(cached, dict) and cached.get("kind") in ("cluster", "paper_cluster"):
            if cached.get("kind") == "paper_cluster":
                rows = con.execute("""SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index
                    FROM paper_frame_index.members m JOIN records r ON r.id=m.record_id
                    WHERE m.cluster_id=:cluster_id ORDER BY m.source_shard,m.source_row
                    LIMIT :limit OFFSET :offset""", {"cluster_id": cached["cluster_id"],
                                                       "limit": limit, "offset": (page - 1) * limit}).fetchall()
            else:
                rows = _fetch_result_page(con, cached["cluster_table"], page, limit)
            payload = _result_meta(con, cached["total"], page, limit, job_id, True)
            payload["duplicateClusterId"] = cached["cluster_id"]
            payload["duplicateClusterSize"] = cached["total"]
            payload["items"] = _rows_to_items(con, rows, coref_stats_available,
                                               bool(request.get("include_context", True)),
                                               cached.get("kind") == "cluster", True)
        else:
            table, total = cached
            rows = _fetch_result_page(con, table, page, limit)
            payload = _result_meta(con, total, page, limit, job_id, True)
            payload["items"] = _rows_to_items(con, rows, coref_stats_available,
                                               bool(request.get("include_context", True)),
                                               include_paper_duplicates=True)
        if emit:
            emit({"event": "page", "jobId": job_id, "payload": payload})
            return None
        return payload

    if request.get("duplicate_cluster_id"):
        return _cluster_search(request, con, emit, cache, job_id, page, limit)

    raw_query = str(request.get("q", "")).strip()
    exact_search = len(raw_query) >= 2 and raw_query.startswith('"') and raw_query.endswith('"')
    q = raw_query[1:-1].strip() if exact_search else raw_query
    params = {"q": q, "stratum": request.get("stratum", "all"),
              "exclude": json.dumps(request.get("exclude", [])),
              "include": json.dumps(request.get("include", [])),
              "ctp_label": request.get("ctp_label", ""),
              "include_only": bool(request.get("include_only")),
              "first_messages_only": bool(request.get("first_messages_only")),
              "paper_first_messages_only": bool(request.get("paper_first_messages_only"))}
    if _uses_paper_frame(params):
        _require_paper_frame(con)
    if _uses_embedding_frame(params):
        _require_embedding_frame(con)
    if _uses_language_frame(params):
        _require_language_frame(con, params["stratum"])
    if request.get("ctp_label"):
        if params.get("stratum") != "english_ge_90":
            raise ValueError("CTP screening labels are available only within the ≥90% English paper frame.")
        _require_ctp_screening(con)
    filters = _base_filters(request, params, coref_stats_available)
    if request.get("unique_groups"):
        return _unique_search(request, con, emit, cache, job_id, page, limit, q, exact_search, params, filters)
    result_table = f"search_{job_id}"
    if q:
        con.execute(f"DROP TABLE IF EXISTS {result_table}")
        con.execute(f"CREATE TEMP TABLE {result_table}(ordinal INTEGER PRIMARY KEY) WITHOUT ROWID")

    preview_rows = None
    preview_items = None
    preview_ordinals = None
    if emit and page == 1:
        preview_rows = _preview_rows(con, q, exact_search, filters, params, limit)
        preview_ordinals = tuple(row["ordinal"] for row in preview_rows)
        preview_items = _rows_to_items(con, preview_rows, coref_stats_available,
                                       bool(request.get("include_context", True)),
                                       include_paper_duplicates=False)
        payload = _result_meta(con, 0, page, limit, job_id, False)
        payload["items"] = preview_items
        emit({"event": "preview", "jobId": job_id, "payload": payload})

    if q:
        hits_table = f"hits_{job_id}"
        con.execute(f"CREATE TEMP TABLE {hits_table}(conversation_id TEXT PRIMARY KEY, first_turn INTEGER) WITHOUT ROWID")
        exact_text = _text_condition(q, exact_search, "turn_search")
        text_match = f"EXISTS (SELECT 1 FROM {hits_table} h WHERE h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index)"
        if len(q) >= 3:
            con.execute(f"INSERT INTO {hits_table} SELECT conversation_id,min(turn_index) FROM turn_search WHERE turn_search MATCH :fts_query AND {_text_condition(q, exact_search, 'turn_search')} GROUP BY conversation_id",
                        {**params, "fts_query": _fts_query(q)})
        else:
            con.execute(f"INSERT INTO {hits_table} SELECT conversation_id,min(turn_index) FROM turns WHERE {_text_condition(q, exact_search, 'turns')} GROUP BY conversation_id", params)
        if _is_identifier_query(q):
            filters += f" AND (instr(lower(r.id),lower(:q))>0 OR instr(lower(r.sample_key),lower(:q))>0 OR instr(lower(r.source_conversation_id),lower(:q))>0 OR {text_match})"
            con.execute(f"INSERT INTO {result_table} SELECT r.ordinal FROM {_record_source(params)} WHERE 1=1{filters}", params)
        else:
            con.execute(f"INSERT INTO {result_table} SELECT r.ordinal FROM {hits_table} h JOIN {_record_source(params)} ON h.conversation_id=r.conversation_id AND h.first_turn<=r.turn_index WHERE 1=1{filters}", params)
        con.execute(f"DROP TABLE {hits_table}")
        count = con.execute(f"SELECT count(*) FROM {result_table}").fetchone()[0]
        if cache is not None:
            _cache_job(con, cache, job_id, (result_table, count))
        rows = _fetch_result_page(con, result_table, page, limit)
    else:
        count_source = _count_record_source(params)
        count = _precomputed_first_message_count(con, request, params)
        if count is None:
            count = con.execute(f"SELECT count(*) FROM {count_source} WHERE 1=1{filters}", params).fetchone()[0]
        if page == 1 and preview_rows is not None:
            rows = preview_rows
        else:
            rows_source = _ordered_record_source(params)
            rows = con.execute(f"SELECT r.ordinal,r.payload,r.conversation_id,r.turn_index FROM {rows_source} WHERE 1=1{filters} ORDER BY {_record_order(params)} LIMIT :limit OFFSET :offset",
                               {**params, "limit": limit, "offset": (page - 1) * limit}).fetchall()

    payload = _result_meta(con, count, page, limit, job_id, True)
    final_ordinals = tuple(row["ordinal"] for row in rows)
    payload["items"] = (preview_items if preview_items is not None and preview_ordinals == final_ordinals
                         else _rows_to_items(con, rows, coref_stats_available,
                                             bool(request.get("include_context", True)),
                                             include_paper_duplicates=False))
    if emit:
        emit({"event": "complete", "jobId": job_id, "payload": payload})
        return None
    return payload


def main():
    global _CANCELLED
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    if FIRST_MESSAGE_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS first_message_index",
                    (f"file:{FIRST_MESSAGE_DB_PATH}?mode=ro",))
    if DUPLICATE_GROUPS_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS duplicate_group_index",
                    (f"file:{DUPLICATE_GROUPS_DB_PATH}?mode=ro",))
    if PAPER_FRAME_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS paper_frame_index",
                    (f"file:{PAPER_FRAME_DB_PATH}?mode=ro",))
    if EMBEDDING_FRAME_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS embedding_frame_index",
                    (f"file:{EMBEDDING_FRAME_DB_PATH}?mode=ro",))
    if LANGUAGE_FRAME_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS language_frame_index",
                    (f"file:{LANGUAGE_FRAME_DB_PATH}?mode=ro",))
    if CTP_SCREENING_DB_PATH.exists():
        con.execute("ATTACH DATABASE ? AS ctp_screening_index",
                    (f"file:{CTP_SCREENING_DB_PATH}?mode=ro",))
    embedding_similarity_db_path = EMBEDDING_FRAME_DB_PATH.with_name("embedding-similarities.sqlite")
    if embedding_similarity_db_path.exists():
        con.execute("ATTACH DATABASE ? AS embedding_similarity_index",
                    (f"file:{embedding_similarity_db_path}?mode=ro",))
    con.row_factory = sqlite3.Row
    con.create_function("casefold", 1, lambda value: (value or "").casefold(), deterministic=True)
    con.create_function("whole_term", 2, contains_whole_term, deterministic=True)
    con.execute("PRAGMA cache_size=-65536")
    con.execute("PRAGMA mmap_size=268435456")
    cache = OrderedDict()

    def emit(event):
        sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def run(request):
        global _CANCELLED
        _CANCELLED = False
        con.set_progress_handler(lambda: 1 if _CANCELLED else 0, 10000)
        try:
            if request.get("action") == "page":
                result = execute_search(request, con, emit, cache)
                if result and result.get("event") == "cache_miss":
                    emit({"requestId": request.get("requestId"), **result})
                return
            execute_search(request, con, emit, cache)
        except sqlite3.OperationalError as error:
            if _CANCELLED or "interrupt" in str(error).lower():
                if request.get("jobId"):
                    job_id = str(request["jobId"]).replace("-", "")
                    cached = cache.pop(job_id, None)
                    _drop_job_tables(con, cached)
                    if job_id.isalnum() and len(job_id) <= 64:
                        con.execute(f"DROP TABLE IF EXISTS search_{job_id}")
                        con.execute(f"DROP TABLE IF EXISTS hits_{job_id}")
                        con.execute(f"DROP TABLE IF EXISTS unique_matches_{job_id}")
                        con.execute(f"DROP TABLE IF EXISTS unique_reps_{job_id}")
                        con.execute(f"DROP TABLE IF EXISTS cluster_rows_{job_id}")
                emit({"event": "cancelled", "jobId": request.get("jobId")})
            else:
                emit({"event": "error", "error": str(error)})
        except Exception as error:
            emit({"event": "error", "error": str(error)})
        finally:
            con.set_progress_handler(None, 0)
            _CANCELLED = False

    if "--worker" in sys.argv:
        signal.signal(signal.SIGUSR1, _cancel_signal)
        for line in sys.stdin:
            try:
                request = json.loads(line)
                run(request)
            except Exception as error:
                emit({"event": "error", "error": str(error)})
        con.close()
    else:
        request = json.load(sys.stdin)
        if request.get("action") == "filter_frame_ids":
            result = filter_frame_ids(request, con)
        elif request.get("action") == "ctp_counts":
            result = get_ctp_counts(con)
        elif request.get("action") == "ctp_labels":
            result = _get_ctp_labels(request, con)
        else:
            result = execute_search(request, con)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        con.close()


if __name__ == "__main__":
    main()
