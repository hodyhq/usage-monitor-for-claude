"""Tests for token_stats: transcript aggregation, dedup, ordering, and formatting."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from usage_monitor_for_claude.token_stats import collect_token_stats, format_tokens, model_sort_key, pretty_model_name


def _entry(model: str, timestamp: datetime, message_id: str | None = 'msg_1', request_id: str | None = 'req_1',
           input_tokens: int = 10, output_tokens: int = 20, cache_read: int = 30, cache_creation: int = 40) -> str:
    """Build one transcript JSONL line with usage data."""
    return json.dumps({
        'timestamp': timestamp.isoformat(),
        'requestId': request_id,
        'message': {
            'id': message_id,
            'model': model,
            'usage': {
                'input_tokens': input_tokens,
                'output_tokens': output_tokens,
                'cache_read_input_tokens': cache_read,
                'cache_creation_input_tokens': cache_creation,
            },
        },
    })


class TokenStatsTest(unittest.TestCase):

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config_dir = Path(self._tmp.name)
        self.project_dir = self.config_dir / 'projects' / 'proj-a'
        self.project_dir.mkdir(parents=True)

        env_patch = mock.patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.config_dir)})
        env_patch.start()
        self.addCleanup(env_patch.stop)

        self.now = datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)

    def _write(self, filename: str, lines: list[str]) -> None:
        (self.project_dir / filename).write_text('\n'.join(lines), encoding='utf-8')

    def test_aggregates_usage_per_model(self) -> None:
        self._write('a.jsonl', [
            _entry('claude-fable-5', self.now, message_id='m1'),
            _entry('claude-fable-5', self.now, message_id='m2'),
        ])

        stats = collect_token_stats(now=self.now)

        self.assertEqual(len(stats), 1)
        self.assertEqual(stats[0]['name'], 'Fable 5')
        self.assertEqual(stats[0]['total_text'], '200')
        self.assertEqual(stats[0]['output_text'], '40')

    def test_deduplicates_on_message_and_request_id(self) -> None:
        self._write('a.jsonl', [
            _entry('claude-fable-5', self.now, message_id='m1', request_id='r1'),
            _entry('claude-fable-5', self.now, message_id='m1', request_id='r1'),
            _entry('claude-fable-5', self.now, message_id='m1', request_id='r2'),
        ])

        stats = collect_token_stats(now=self.now)

        self.assertEqual(stats[0]['total_text'], '200')

    def test_entries_without_message_id_are_not_deduplicated(self) -> None:
        self._write('a.jsonl', [
            _entry('claude-fable-5', self.now, message_id=None),
            _entry('claude-fable-5', self.now, message_id=None),
        ])

        stats = collect_token_stats(now=self.now)

        self.assertEqual(stats[0]['total_text'], '200')

    def test_entries_before_midnight_are_excluded(self) -> None:
        yesterday = self.now - timedelta(days=1)
        self._write('a.jsonl', [
            _entry('claude-fable-5', yesterday, message_id='m1'),
            _entry('claude-fable-5', self.now, message_id='m2'),
        ])

        stats = collect_token_stats(now=self.now)

        self.assertEqual(stats[0]['total_text'], '100')

    def test_files_not_modified_today_are_skipped(self) -> None:
        self._write('old.jsonl', [_entry('claude-fable-5', self.now, message_id='m1')])
        midnight = self.now.replace(hour=0, minute=0, second=0, microsecond=0)
        old_mtime = (midnight - timedelta(hours=1)).timestamp()
        os.utime(self.project_dir / 'old.jsonl', (old_mtime, old_mtime))

        self.assertEqual(collect_token_stats(now=self.now), [])

    def test_malformed_lines_and_synthetic_models_are_ignored(self) -> None:
        self._write('a.jsonl', [
            'not json at all "usage"',
            json.dumps({'timestamp': self.now.isoformat(), 'message': {'model': '<synthetic>', 'usage': {'output_tokens': 5}}}),
            json.dumps({'timestamp': 'invalid', 'message': {'model': 'claude-fable-5', 'usage': {'output_tokens': 5}}}),
            _entry('claude-fable-5', self.now, message_id='m1'),
        ])

        stats = collect_token_stats(now=self.now)

        self.assertEqual(len(stats), 1)
        self.assertEqual(stats[0]['total_text'], '100')

    def test_empty_projects_dir_returns_empty_list(self) -> None:
        self.assertEqual(collect_token_stats(now=self.now), [])

    def test_models_sorted_by_family_then_version(self) -> None:
        self._write('a.jsonl', [
            _entry('claude-haiku-4-5-20251001', self.now, message_id='m1'),
            _entry('claude-sonnet-4-6', self.now, message_id='m2'),
            _entry('claude-opus-4-7', self.now, message_id='m3'),
            _entry('claude-opus-4-8', self.now, message_id='m4'),
            _entry('claude-fable-5', self.now, message_id='m5'),
        ])

        names = [entry['name'] for entry in collect_token_stats(now=self.now)]

        self.assertEqual(names, ['Fable 5', 'Opus 4.8', 'Opus 4.7', 'Sonnet 4.6', 'Haiku 4.5'])


class PrettyModelNameTest(unittest.TestCase):

    def test_known_families(self) -> None:
        self.assertEqual(pretty_model_name('claude-fable-5'), 'Fable 5')
        self.assertEqual(pretty_model_name('claude-opus-4-8'), 'Opus 4.8')
        self.assertEqual(pretty_model_name('claude-haiku-4-5-20251001'), 'Haiku 4.5')

    def test_unknown_model_returned_unchanged(self) -> None:
        self.assertEqual(pretty_model_name('gpt-5'), 'gpt-5')


class ModelSortKeyTest(unittest.TestCase):

    def test_family_rank_order(self) -> None:
        models = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5']
        self.assertEqual(
            sorted(models, key=model_sort_key),
            ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
        )

    def test_newer_version_first_within_family(self) -> None:
        self.assertLess(model_sort_key('claude-opus-4-8'), model_sort_key('claude-opus-4-7'))

    def test_unknown_family_sorts_last(self) -> None:
        self.assertGreater(model_sort_key('gpt-5'), model_sort_key('claude-haiku-4-5'))


class FormatTokensTest(unittest.TestCase):

    def test_magnitude_ranges(self) -> None:
        self.assertEqual(format_tokens(999), '999')
        self.assertEqual(format_tokens(1_500), '1.5k')
        self.assertEqual(format_tokens(27_048_318), '27.0M')
        self.assertEqual(format_tokens(2_400_000_000), '2.4B')


if __name__ == '__main__':
    unittest.main()
