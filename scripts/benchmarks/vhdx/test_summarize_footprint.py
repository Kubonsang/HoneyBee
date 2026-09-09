import unittest
from summarize_footprint import evaluate, metrics


class FootprintSummaryTests(unittest.TestCase):
    def test_storage_target_does_not_override_slow_playmode(self):
        base = dict(firstMs=100, reopenMs=100, editMs=100, playMs=100,
                    readyMs=150, combinedMedianBytes=500, peakBytes=400,
                    observedCombinedPeakBytes=550)
        candidate = dict(base, combinedMedianBytes=400)
        self.assertTrue(evaluate(candidate, base)['capacityTimingQualified'])
        candidate['playMs'] = 111
        self.assertFalse(evaluate(candidate, base)['capacityTimingQualified'])
        candidate['playMs'] = 100
        candidate['readyMs'] = 170
        self.assertFalse(evaluate(candidate, base)['capacityTimingQualified'])

    def test_old_allocation_counter_cannot_qualify(self):
        with self.assertRaises(ValueError):
            metrics([{'detached': {}, 'afterReadonlyVerification': {}}], 5, precise=True)


if __name__ == '__main__':
    unittest.main()
