import json
from pathlib import Path
import tempfile
import unittest

from summarize_lifecycle import summarize


class LifecycleEvidenceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.put('campaign.json', {'protocol': 'startup-lifecycle-v1'})
        self.put('status.json', {'protocol': 'startup-lifecycle-v1', 'ok': True,
                                 'lifecycleValidated': True, 'qualified': False})
        self.rows = []
        for iteration in (10, 11):
            name = f'E-dag-{iteration}'
            row = {'mode': 'E-dag', 'iteration': iteration,
                   'child': str(self.root / (name + '.vhdx')),
                   'externalPath': str(self.root / (name + '-bee')),
                   'geometry': {'BlockSize': 1048576},
                   'detached': {'allocatedBytes': 340_000_000},
                   'afterReadonlyVerification': {'allocatedBytes': 340_000_000},
                   'phases': [self.phase(name + '-' + p) for p in ('first', 'reopen', 'cycle1-edit_mode', 'cycle1-play_mode')]}
            self.rows.append(row)
            self.put(name + '-cleanup.json', {'ok': True, 'archiveSHA256': 'example',
                'removed': [row['child'], row['externalPath'], str(self.root / name)]})
        self.put('measurements.json', self.rows)
        names = [f'E-dag-{i}-compat{r}-{p}' for r in range(1, 4) for i in (10, 11)
                 for p in ('edit_mode', 'play_mode')]
        names += [f'E-dag-11-compat4-{p}' for p in ('edit_mode', 'play_mode')]
        self.compat = {'ok': True, 'rebootTested': False, 'backend': 'two independent batch Unity processes',
                       'phases': [self.phase(name) for name in names]}
        self.put('compatibility.json', self.compat)

    def put(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def phase(self, name):
        count = 37 if name.endswith('edit_mode') else 15
        self.put(name + '.json', {'backend': 'process', 'run_id': name, 'exit_code': 0, 'passed': count, 'failed': 0, 'skipped': 0})
        return {'name': name, 'testRunId': name, 'passed': count, 'total': count, 'external': {'allocatedBytes': 150_000_000}}

    def test_complete_lifecycle_has_468_tests(self):
        result = summarize(self.root)
        self.assertEqual(result['passedTests'], 468)
        self.assertFalse(result['rebootTested'])
        self.assertFalse(result['capacityGateChanged'])

    def test_shared_cache_is_rejected(self):
        self.rows[1]['externalPath'] = self.rows[0]['externalPath']
        self.put('measurements.json', self.rows)
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_missing_survivor_round_is_rejected(self):
        self.compat['phases'].pop()
        self.put('compatibility.json', self.compat)
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_unremoved_cache_is_rejected(self):
        Path(self.rows[0]['externalPath']).mkdir()
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_raw_test_count_mismatch_is_rejected(self):
        name = 'E-dag-11-compat4-play_mode'
        evidence = json.loads((self.root / (name + '.json')).read_text())
        evidence['passed'] = 14
        self.put(name + '.json', evidence)
        with self.assertRaises(ValueError):
            summarize(self.root)


if __name__ == '__main__':
    unittest.main()
