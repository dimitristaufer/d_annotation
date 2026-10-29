#!/usr/bin/env python3
"""Build a compact, normalised annotation frame from the prescreen Parquet files."""
from __future__ import annotations

import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path

def json_array(row: dict, field: str) -> list[dict]:
    value = row.get(field)
    if not value:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def bool_field(row: dict, field: str) -> bool:
    return bool(row.get(field, False))


def read_rows(directory: Path, shard_names: set[str]):
    import pyarrow.parquet as pq

    rows = []
    for path in sorted(directory.glob("*.parquet")):
        if path.stem not in shard_names:
            continue
        rows.extend(pq.read_table(path).to_pylist())
    return rows


def discover_input(root: Path) -> Path:
    candidates = [path for path in root.rglob("wildchat_screening_*")
                  if all((path / name).is_dir() for name in ("conversations", "all_turns", "requester_messages"))]
    if not candidates:
        raise FileNotFoundError(f"No complete prescreen output found under {root}")
    def stage_key(path: Path) -> tuple[float, int, str]:
        shard_sets = [{file.stem for file in (path / section).glob("*.parquet")}
                      for section in ("conversations", "all_turns", "requester_messages")]
        complete = set.intersection(*shard_sets) if shard_sets else set()
        newest = max((file.stat().st_mtime for section in ("conversations", "all_turns", "requester_messages")
                      for file in (path / section).glob("*.parquet")), default=path.stat().st_mtime)
        return newest, len(complete), path.name
    return max(candidates, key=stage_key)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=None, help="Prescreen output directory. Defaults to the newest complete output under ../Prescreening.")
    parser.add_argument("--prescreen-root", type=Path, default=Path("../Prescreening"))
    parser.add_argument("--output", type=Path, default=Path("data"))
    parser.add_argument("--max-shards", type=int, default=0, help="Use the first N completed source shards; 0 uses every shard.")
    args = parser.parse_args()
    input_dir = args.input
    if input_dir is None and os.environ.get("WILDCHAT_PRESCREEN_INPUT"):
        input_dir = Path(os.environ["WILDCHAT_PRESCREEN_INPUT"])
    if input_dir is None:
        try:
            input_dir = discover_input(args.prescreen_root)
        except FileNotFoundError:
            # A production clone can receive the prepared snapshot directly,
            # without carrying the source Parquet files alongside the app.
            summary_path = args.output / "summary.json"
            if not summary_path.exists():
                raise
            prepared = json.loads(summary_path.read_text(encoding="utf-8"))
            frame_dir = args.output / "frames"
            expected = {f"frame-{shard}.json.gz" for shard in prepared.get("shards", [])}
            if expected and {file.name for file in frame_dir.glob("frame-*.json.gz")} == expected:
                print(f"Using existing prepared snapshot {prepared.get('snapshot', 'unknown')} ({prepared.get('records', 0):,} records)")
                return
            raise

    shard_sets = [{path.stem for path in (input_dir / section).glob("*.parquet")}
                  for section in ("conversations", "all_turns", "requester_messages")]
    complete_shards = set.intersection(*shard_sets) if shard_sets else set()
    requester_paths = sorted(path for path in (input_dir / "requester_messages").glob("*.parquet")
                             if path.stem in complete_shards)
    if args.max_shards > 0:
        requester_paths = requester_paths[:args.max_shards]
    shard_names = {path.stem for path in requester_paths}
    fingerprint_entries = []
    for section in ("conversations", "all_turns", "requester_messages"):
        for file in sorted((input_dir / section).glob("*.parquet")):
            if file.stem in shard_names:
                stat = file.stat()
                fingerprint_entries.append((section, file.name, stat.st_size, stat.st_mtime_ns))
    fingerprint_payload = json.dumps([str(input_dir.resolve()), sorted(shard_names), fingerprint_entries], separators=(",", ":"))
    input_fingerprint = hashlib.sha256(fingerprint_payload.encode("utf-8")).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    summary_path = args.output / "summary.json"
    if summary_path.exists():
        try:
            previous_summary = json.loads(summary_path.read_text(encoding="utf-8"))
            existing_frames = {file.name for file in (args.output / "frames").glob("frame-*.json.gz")}
            expected_frames = {f"frame-{shard}.json.gz" for shard in previous_summary.get("shards", [])}
            if (previous_summary.get("inputFingerprint") == input_fingerprint
                    and previous_summary.get("sourceShards") == sorted(shard_names)
                    and "strataCounts" in previous_summary
                    and existing_frames == expected_frames):
                print(json.dumps(previous_summary, indent=2))
                return
        except (OSError, json.JSONDecodeError):
            pass
    frames_dir = args.output / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    shard_stats = []
    conversation_count = 0
    total_records = positive = negative = 0
    message_signal_positive = 0
    for shard in sorted(shard_names):
        print(f"Preparing {shard}", flush=True)
        shard_set = {shard}
        conversations = read_rows(input_dir / "conversations", shard_set)
        turns = read_rows(input_dir / "all_turns", shard_set)
        targets = read_rows(input_dir / "requester_messages", shard_set)
        conv_by_id = {row["conversation_hash"]: row for row in conversations}
        turns_by_id: dict[str, list[dict]] = {}
        for turn in turns:
            turns_by_id.setdefault(turn["conversation_hash"], []).append(turn)
        for group in turns_by_id.values():
            group.sort(key=lambda row: row["turn_index"])
        turns_by_conversation = {
            conversation_id: [{"role": turn["role"], "text": turn["text"], "turnIndex": turn["turn_index"]}
                              for turn in group]
            for conversation_id, group in turns_by_id.items()
        }
        records = []
        for target in targets:
            conversation = conv_by_id.get(target["conversation_hash"])
            if not conversation:
                continue
            context = turns_by_id.get(target["conversation_hash"], [])
            target_turn = next((turn for turn in context if turn["turn_index"] == target["turn_index"]), None)
            if not target_turn or target_turn["role"] not in ("user", "requester"):
                continue
            names = json_array(target, "person_ner_hits_json")
            nouns = json_array(target, "person_noun_hits_json")
            pronouns = json_array(target, "person_pronoun_hits_json")
            coreference_mentions = json_array(target, "coref_mentions_json")
            has_name = bool_field(target, "has_person_ner") or bool(names)
            has_noun = bool_field(target, "has_person_noun") or bool(nouns)
            has_pronoun = bool_field(target, "has_person_pronoun") or bool(pronouns)
            has_coreference = bool_field(target, "has_coref") or bool(coreference_mentions)
            message_signal_positive += int(has_name or has_noun or has_pronoun or has_coreference)
            source_shard = target["source_shard"]
            sample_key = target["sample_key"]
            source_row = target.get("source_row", 0)
            target_turn_index = int(target["turn_index"])
            requester_turn_index = target.get("requester_turn_index")
            if requester_turn_index is None:
                requester_turn_index = sum(turn["role"] in ("user", "requester") and turn["turn_index"] <= target_turn_index for turn in context) - 1
            stratum = target.get("candidate_stratum") or ("positive" if has_name or has_noun or has_pronoun or has_coreference or bool_field(target, "has_person_reference") else "negative")
            text = target_turn.get("text") or ""
            records.append({
                "id": f"{source_shard}:{sample_key}",
                "sampleKey": str(sample_key),
                "conversationId": target["conversation_hash"],
                "sourceConversationId": target.get("source_conversation_id", target["conversation_hash"]),
                "sourceShard": source_shard,
                "sourceRow": source_row,
                "turnIndex": target_turn_index,
                "requesterTurnIndex": requester_turn_index,
                "stratum": stratum,
                "screening": {
                    "target": {
                        "personReference": bool_field(target, "has_person_reference"),
                        "personName": has_name, "personNoun": has_noun,
                        "personPronoun": has_pronoun, "coreference": has_coreference,
                        "embeddedContent": bool_field(target, "embedded_content_candidate"),
                        "longTurn": bool_field(target, "long_turn"),
                        "nearDuplicate": bool_field(target, "template_or_near_duplicate"),
                    },
                    "conversation": {
                        "personName": bool_field(conversation, "person_ner_signal"),
                        "personNoun": bool_field(conversation, "person_noun_signal"),
                        "personPronoun": bool_field(conversation, "person_pronoun_signal"),
                        "coreference": bool_field(conversation, "coref_person_signal"),
                        "embeddedContent": bool_field(conversation, "has_embedded_content"),
                        "nearDuplicate": bool_field(conversation, "has_template_duplicate"),
                    },
                    "names": names, "nouns": nouns, "pronouns": pronouns,
                    "coreferenceMentions": coreference_mentions,
                },
                "metadata": {
                    "language": target.get("language", conversation.get("language", "unknown")),
                    "characters": target.get("char_count", len(text)),
                    "words": target.get("word_count", len(text.split())),
                    "conversationTurns": conversation.get("num_turns", len(context)),
                },
            })
        records.sort(key=lambda row: int(row["sampleKey"]))
        frame_path = frames_dir / f"frame-{shard}.json.gz"
        frame_tmp = frame_path.with_suffix(frame_path.suffix + ".tmp")
        with gzip.open(frame_tmp, "wt", encoding="utf-8", compresslevel=5) as stream:
            json.dump({"records": records, "turns": turns_by_conversation}, stream, ensure_ascii=False, separators=(",", ":"))
        frame_tmp.replace(frame_path)
        record_count = len(records)
        positive_count = sum(row["stratum"] == "positive" for row in records)
        negative_count = sum(row["stratum"] == "negative" for row in records)
        shard_stats.append({"shard": shard, "records": record_count, "positive": positive_count, "negative": negative_count})
        total_records += record_count
        positive += positive_count
        negative += negative_count
        conversation_count += len(turns_by_conversation)
    legacy_frame = args.output / "frame.json.gz"
    if legacy_frame.exists():
        legacy_frame.unlink()
    source_summary = None
    source_summary_path = input_dir / "summary.json"
    if source_summary_path.exists():
        try:
            source_summary = json.loads(source_summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    source_totals = (source_summary or {}).get("totals", {})
    conversation_signal_positive = int(source_totals.get("ctp_candidate_conversations", 0) or 0)
    conversation_total = int(source_totals.get("english_conversations_with_requester_turns", 0) or 0)
    # Older pre-screen stages may omit conversation totals. In that case the
    # record counts remain available, while the conversation counts are marked
    # unavailable instead of being presented as message counts.
    strata_counts = {
        "conversationPositive": conversation_signal_positive if conversation_total else None,
        "conversationNegative": max(0, conversation_total - conversation_signal_positive) if conversation_total else None,
        "messagePositive": message_signal_positive,
        "messageNegative": total_records - message_signal_positive,
    }
    summary = {
        "records": total_records,
        "conversations": conversation_count,
        "shards": sorted(shard_names),
        "positive": positive,
        "negative": negative,
        "strataCounts": strata_counts,
        "snapshot": input_dir.name,
        "inputFingerprint": input_fingerprint,
        "sourceShards": sorted(shard_names),
        "shardCount": len(shard_stats),
        "totalSourceShards": max(
            (int(shard.rsplit("-of-", 1)[1]) for shard in shard_names if "-of-" in shard and shard.rsplit("-of-", 1)[1].isdigit()),
            default=len(shard_names),
        ),
        "shardStats": shard_stats,
    }
    if source_summary is not None:
        summary["sourcePrescreen"] = {
            "completedAt": source_summary.get("completed_at"),
            "datasetRevision": source_summary.get("dataset_revision"),
            "totals": source_summary.get("totals", {}),
            "duplicates": source_summary.get("duplicates", {}),
            "corefRecovery": source_summary.get("coref_recovery", {}),
        }
    for path in frames_dir.glob("frame-*.json.gz"):
        if path.stem.removeprefix("frame-").removesuffix(".json") not in shard_names:
            path.unlink()
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
