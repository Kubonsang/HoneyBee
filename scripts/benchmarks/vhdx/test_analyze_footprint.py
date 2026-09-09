import unittest
from analyze_footprint import analyze


class AttributionTests(unittest.TestCase):
    def test_sector_ownership_metadata_and_unknown_are_not_added_to_files(self):
        allocation = {'blockBytes': 1048576, 'sectorBytes': 4096,
                      'allocatedPayloadBlocks': [
                          {'virtualBlockIndex': 1, 'childSourcedSectorBytes': 8192,
                           'childSectorRuns': [[0, 2]]},
                          {'virtualBlockIndex': 2, 'childSourcedSectorBytes': 8192,
                           'childSectorRuns': [[0, 2]]}]}
        inventory = {'files': [
            {'path': 'BurstCache/x', 'bytes': 4096,
             'extents': [{'lcn': 0, 'clusters': 1}]},
            {'path': '$MFT', 'bytes': 0,
             'extents': [{'lcn': 1, 'clusters': 1}]},
            {'path': 'Search/y', 'bytes': 4096,
             'extents': [{'lcn': 256, 'clusters': 1}]}]}
        result = analyze(allocation, inventory, {'clusterBytes': 4096, 'partitionOffsetBytes': 1048576},
                         {'BurstCache/x': {}, 'Search/y': {}})
        self.assertEqual(result['blockClasses'], {'mixed': 1, 'unresolved': 1})
        self.assertEqual(result['unresolvedOwnedSectorBytes'], 4096)
        self.assertEqual(result['directoryCandidates'], [])
        self.assertFalse(result['causalAttribution'])

    def test_coarse_legacy_inventory_cannot_claim_attribution(self):
        with self.assertRaises(ValueError):
            analyze({'blockBytes': 1048576, 'sectorBytes': 4096,
                     'allocatedPayloadBlocks': [{'virtualBlockIndex': 1}]},
                    {'files': []}, {'clusterBytes': 4096, 'partitionOffsetBytes': 1048576}, {})


if __name__ == '__main__':
    unittest.main()
