"""
Token Stats
============

Aggregates today's Claude Code token usage per model from the local JSONL
transcripts in the Claude config directory.  Read-only and fully offline -
no network access, no credential handling.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

__all__ = ['collect_token_stats', 'format_tokens', 'model_sort_key', 'pretty_model_name']

_MODEL_FAMILY_ORDER = ('fable', 'opus', 'sonnet', 'haiku')
_MODEL_PATTERN = re.compile(r'(fable|opus|sonnet|haiku)[-_ ]?(\d+(?:[.-]\d+)?)?', re.IGNORECASE)


def _projects_dir() -> Path:
    """Return the Claude Code projects directory honoring CLAUDE_CONFIG_DIR."""
    config_dir = os.environ.get('CLAUDE_CONFIG_DIR')
    base = Path(config_dir) if config_dir else Path.home() / '.claude'
    return base / 'projects'


def pretty_model_name(model_id: str) -> str:
    """Return a short display name for a model identifier.

    Parameters
    ----------
    model_id : str
        Raw model identifier, e.g. ``'claude-fable-5'`` or
        ``'claude-haiku-4-5-20251001'``.

    Returns
    -------
    str
        Display name like ``'Fable 5'`` or ``'Haiku 4.5'``.  Unrecognized
        identifiers are returned unchanged.
    """
    match = _MODEL_PATTERN.search(model_id)
    if match is None:
        return model_id

    family = match.group(1).capitalize()
    version = (match.group(2) or '').replace('-', '.')
    return f'{family} {version}' if version else family


def model_sort_key(model_id: str) -> tuple[int, float]:
    """Sort key for canonical model ordering: family rank, newest version first.

    Families rank Fable > Opus > Sonnet > Haiku; unknown families sort last.

    Parameters
    ----------
    model_id : str
        Raw model identifier or family variant name.
    """
    lowered = model_id.lower()

    rank = len(_MODEL_FAMILY_ORDER)
    for index, family in enumerate(_MODEL_FAMILY_ORDER):
        if family in lowered:
            rank = index
            break

    match = _MODEL_PATTERN.search(model_id)
    version = 0.0
    if match is not None and match.group(2):
        try:
            version = float(match.group(2).replace('-', '.'))
        except ValueError:
            version = 0.0

    return (rank, -version)


def format_tokens(count: int) -> str:
    """Format a token count as a short human-readable string (e.g. ``'3.4M'``).

    Parameters
    ----------
    count : int
        Token count to format.
    """
    if count >= 1_000_000_000:
        return f'{count / 1_000_000_000:.1f}B'
    if count >= 1_000_000:
        return f'{count / 1_000_000:.1f}M'
    if count >= 1_000:
        return f'{count / 1_000:.1f}k'
    return str(count)


def collect_token_stats(now: datetime | None = None) -> list[dict[str, Any]]:
    """Aggregate today's per-model token usage from local transcripts.

    Scans ``<config>/projects/*/*.jsonl`` for assistant messages with usage
    data since local midnight.  Entries are deduplicated on the
    ``(message.id, requestId)`` pair because transcripts can repeat a
    message across retries and continuations.

    Parameters
    ----------
    now : datetime or None
        Reference time for the local-midnight cutoff; defaults to the
        current local time (parameter exists for testability).

    Returns
    -------
    list[dict]
        One entry per model, sorted by family rank and version:
        ``{'name': str, 'total': int, 'output': int}``.  Empty when no
        transcripts exist or nothing was used today.
    """
    reference = now if now is not None else datetime.now().astimezone()
    midnight = reference.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = midnight.timestamp()

    totals: dict[str, dict[str, int]] = {}
    seen: set[tuple[str, str | None]] = set()

    for transcript_path in _projects_dir().glob('*/*.jsonl'):
        try:
            if transcript_path.stat().st_mtime < cutoff:
                continue
            with open(transcript_path, 'r', encoding='utf-8', errors='ignore') as transcript_file:
                for line in transcript_file:
                    if '"usage"' not in line:
                        continue

                    try:
                        record = json.loads(line)
                    except (ValueError, TypeError):
                        continue

                    message = record.get('message') or {}
                    usage = message.get('usage') or {}
                    model = message.get('model') or ''
                    if not usage or not model or model == '<synthetic>':
                        continue

                    timestamp_str = record.get('timestamp') or ''
                    try:
                        timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00')).timestamp()
                    except ValueError:
                        continue
                    if timestamp < cutoff:
                        continue

                    message_id = message.get('id')
                    dedup_key = (message_id, record.get('requestId'))
                    if message_id and dedup_key in seen:
                        continue
                    seen.add(dedup_key)

                    model_totals = totals.setdefault(model, {'input': 0, 'output': 0, 'cache': 0})
                    model_totals['input'] += usage.get('input_tokens') or 0
                    model_totals['output'] += usage.get('output_tokens') or 0
                    model_totals['cache'] += (usage.get('cache_read_input_tokens') or 0) + (usage.get('cache_creation_input_tokens') or 0)
        except OSError:
            continue

    stats = []
    for model in sorted(totals, key=model_sort_key):
        model_totals = totals[model]
        total = model_totals['input'] + model_totals['output'] + model_totals['cache']
        stats.append({
            'name': pretty_model_name(model),
            'total_text': format_tokens(total),
            'output_text': format_tokens(model_totals['output']),
        })

    return stats
