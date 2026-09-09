import unittest
from summarize import summarize


def rows():
    return [dict(measurementProtocol='readonly-verification-v2', mode=mode, iteration=i, traced=False, unityMs=100, reopenMs=50,
                 afterDetach={'allocatedBytes': size}, afterVerification={'allocatedBytes': size},
                 afterUnity={'allocatedBytes': size}, afterReopen={'allocatedBytes': size},
                 compactBefore={'allocatedBytes': size}, compactAfter={'allocatedBytes': size},
                 compactMs=10, compactVerified=True)
            for mode, size in [('2mib', 1000), ('1mib', 900)] for i in range(3)]


class GateTests(unittest.TestCase):
    def test_completed_improvement(self):
        self.assertTrue(summarize(rows(), {'ok': True})['benchmarkGatePassed'])

    def test_partial_run_rejected(self):
        with self.assertRaises(ValueError):
            summarize(rows(), {'ok': False})
        with self.assertRaises(ValueError):
            summarize(rows()[:-1], {'ok': True})

    def test_tracing_and_duplicate_samples_rejected(self):
        data = rows()
        data[0]['traced'] = True
        with self.assertRaises(ValueError):
            summarize(data, {'ok': True})
        data = rows()
        data[0]['iteration'] = 1
        with self.assertRaises(ValueError):
            summarize(data, {'ok': True})

    def test_mutating_or_legacy_verification_rejected(self):
        data = rows()
        del data[0]['measurementProtocol']
        with self.assertRaises(ValueError):
            summarize(data, {'ok': True})
        data = rows()
        data[0]['afterVerification'] = {'allocatedBytes': 9999}
        with self.assertRaises(ValueError):
            summarize(data, {'ok': True})

    def test_slow_candidate_fails(self):
        data = rows()
        for row in data:
            if row['mode'] == '1mib':
                row['unityMs'] = 120
        self.assertFalse(summarize(data, {'ok': True})['benchmarkGatePassed'])

    def test_missing_content_verification_rejected(self):
        data = rows()
        data[0]['compactVerified'] = False
        with self.assertRaises(ValueError):
            summarize(data, {'ok': True})


if __name__ == '__main__':
    unittest.main()
