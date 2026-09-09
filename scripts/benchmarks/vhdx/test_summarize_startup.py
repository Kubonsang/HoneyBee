import json
import copy
from pathlib import Path
import tempfile
import unittest

from summarize_startup import summarize


class StartupEvidenceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.put('campaign.json', {'protocol': 'startup-v2'})
        self.status = {'protocol': 'startup-v2', 'ok': True, 'selected': '', 'qualified': False}
        self.put('status.json', self.status)
        name = 'E-control-0'
        phases = []
        for suffix in ('first', 'reopen', 'cycle1-edit_mode', 'cycle1-play_mode'):
            phase = {'name': name + '-' + suffix, 'elapsedMs': 1000,
                     'external': {'allocatedBytes': 150_000_000},
                     'observedPeakAllocatedBytes': 350_000_000}
            if 'cycle' in suffix:
                count = 37 if suffix.endswith('edit_mode') else 15
                phase.update(total=count, passed=count, testRunId='run-' + suffix)
                self.put(phase['name'] + '.json', {'backend': 'process', 'run_id': phase['testRunId']})
            phases.append(phase)
        self.row = {'mode': 'E-control', 'iteration': 0, 'phases': phases,
                    'geometry': {'BlockSize': 1048576}, 'preparationMs': 50, 'readyMs': 1050,
                    'detached': {'allocatedBytes': 340_000_000},
                    'afterReadonlyVerification': {'allocatedBytes': 340_000_000}}
        self.put('measurements.json', [self.row])
        (self.root / (name + '-first.log')).write_text('Tundra requires additional run (30.17 seconds)')

    def put(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def test_pilot_is_not_qualification(self):
        result = summarize(self.root)
        self.assertEqual(result['passedTests'], 52)
        self.assertFalse(result['qualified'])
        self.assertEqual(result['groups']['pilot/E-control'][0]['combinedBytes'], 490_000_000)
        self.status.update(qualified=True, selected='E-control')
        self.put('status.json', self.status)
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_duplicate_incomplete_or_hidden_preparation_rejected(self):
        self.put('measurements.json', [self.row, self.row])
        with self.assertRaises(ValueError):
            summarize(self.root)
        self.row['readyMs'] = 1000
        self.put('measurements.json', [self.row])
        with self.assertRaises(ValueError):
            summarize(self.root)
        self.row['readyMs'] = 1050
        self.row['phases'].pop()
        self.put('measurements.json', [self.row])
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_wrong_backend_rejected(self):
        phase = self.row['phases'][2]
        self.put(phase['name'] + '.json', {'backend': 'bridge', 'run_id': phase['testRunId']})
        with self.assertRaises(ValueError):
            summarize(self.root)

    def test_final_gate_recomputed_and_retained_rounds_required(self):
        rows = []
        for mode in ('A-legacy', 'E-dag'):
            for iteration in (10, 11, 12):
                row = copy.deepcopy(self.row)
                row.update(mode=mode, iteration=iteration)
                name = f'{mode}-{iteration}'
                phases = []
                suffixes = ['first', 'reopen'] + [f'cycle{r}-{p}' for r in range(1, 6)
                                                 for p in ('edit_mode', 'play_mode')]
                for suffix in suffixes:
                    source = self.row['phases'][2 if suffix.endswith('edit_mode') else 3]
                    phase = copy.deepcopy(source)
                    phase['name'] = name + '-' + suffix
                    phase['testRunId'] = 'run-' + phase['name']
                    self.put(phase['name'] + '.json', {'backend': 'process', 'run_id': phase['testRunId']})
                    phases.append(phase)
                row['phases'] = phases
                rows.append(row)
                (self.root / (name + '-first.log')).write_text('Successful open')
        self.put('measurements.json', rows)
        self.status.update(qualified=True, selected='E-dag')
        self.put('status.json', self.status)
        compatibility = {'ok': True, 'rebootTested': False, 'backend': 'two independent batch Unity processes', 'phases': []}
        rounds = [(i, r) for r in range(1, 4) for i in (10, 11)] + [(11, 4)]
        for iteration, round_number in rounds:
            for platform in ('edit_mode', 'play_mode'):
                name = f'E-dag-{iteration}-compat{round_number}-{platform}'
                count = 37 if platform == 'edit_mode' else 15
                phase = {'name': name, 'testRunId': 'run-' + name, 'passed': count, 'total': count}
                compatibility['phases'].append(phase)
                self.put(name + '.json', {'backend': 'process', 'run_id': phase['testRunId']})
        self.put('compatibility.json', compatibility)
        self.assertTrue(summarize(self.root)['qualified'])
        rows[-1]['phases'][0]['observedPeakAllocatedBytes'] = 410_000_000
        self.put('measurements.json', rows)
        with self.assertRaisesRegex(ValueError, 'storage gates'):
            summarize(self.root)
        rows[-1]['phases'][0]['observedPeakAllocatedBytes'] = 350_000_000
        self.put('measurements.json', rows)
        compatibility['phases'][-1] = compatibility['phases'][1]
        self.put('compatibility.json', compatibility)
        with self.assertRaisesRegex(ValueError, 'retained rounds'):
            summarize(self.root)


if __name__ == '__main__':
    unittest.main()
