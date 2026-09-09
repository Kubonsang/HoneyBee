import copy
import unittest
from summarize_capacity import MODES, summarize


def fixture(runs=3, cycles=5):
    rows = []
    for mode in MODES:
        for i in range(runs):
            size = 900_000_000 if mode == MODES[0] else 250_000_000
            external = 700_000_000 if mode == MODES[-1] else 0
            names = ['first', 'reopen'] + [f'cycle{c}-{p}' for c in range(1, cycles + 1)
                                          for p in ('edit_mode', 'play_mode')]
            phases = [{'name': f'{mode}-{i}-{n}', 'elapsedMs': 1000,
                       'child': {'allocatedBytes': size}, 'external': {'allocatedBytes': external},
                       'observedPeakAllocatedBytes': size, 'testRunId': 'run-' + n,
                       'total': 37 if n.endswith('edit_mode') else 15,
                       'passed': 37 if n.endswith('edit_mode') else 15} for n in names]
            rows.append({'mode': mode, 'iteration': i, 'phases': phases,
                         'geometry': {'BlockSize': 1_048_576},
                         'detached': {'allocatedBytes': size},
                         'afterReadonlyVerification': {'allocatedBytes': size}})
    return {'protocol': 'capacity-v1', 'runs': runs, 'cycles': cycles}, {'protocol': 'capacity-v1', 'ok': True}, rows


class CapacityGateTests(unittest.TestCase):
    def test_counts_external_bytes_and_rejects_cost_shifting(self):
        result = summarize(*fixture())['candidates']
        self.assertTrue(result['B-fresh']['qualified'])
        self.assertTrue(result['E-external-bee']['capacityTargetMet'])
        self.assertFalse(result['E-external-bee']['qualified'])

    def test_pilot_never_qualifies(self):
        result = summarize(*fixture(1, 1))
        self.assertFalse(result['qualifiedProtocol'])
        self.assertFalse(result['candidates']['B-fresh']['qualified'])

    def test_missing_or_duplicate_samples_rejected(self):
        a, b, rows = fixture()
        with self.assertRaises(ValueError):
            summarize(a, b, rows[:-1])
        rows[-1] = copy.deepcopy(rows[0])
        with self.assertRaises(ValueError):
            summarize(a, b, rows)

    def test_peak_not_just_final_size(self):
        a, b, rows = fixture()
        next(r for r in rows if r['mode'] == 'B-fresh')['phases'][0]['observedPeakAllocatedBytes'] = 500_000_000
        self.assertFalse(summarize(a, b, rows)['candidates']['B-fresh']['capacityTargetMet'])

    def test_readonly_growth_and_missing_tests_rejected(self):
        for mutation in ('growth', 'coverage'):
            a, b, rows = fixture()
            if mutation == 'growth':
                rows[0]['afterReadonlyVerification']['allocatedBytes'] += 1
            else:
                rows[0]['phases'][2]['total'] = 0
            with self.assertRaises(ValueError):
                summarize(a, b, rows)

    def test_timing_regression_disqualifies(self):
        a, b, rows = fixture()
        for r in rows:
            if r['mode'] == 'B-fresh':
                r['phases'][0]['elapsedMs'] = 1200
        self.assertFalse(summarize(a, b, rows)['candidates']['B-fresh']['qualified'])


if __name__ == '__main__':
    unittest.main()
