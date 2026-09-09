import unittest
from correlate_capacity_layout import correlate


class LayoutTests(unittest.TestCase):
    def test_partition_offset_sparse_extents_and_shared_blocks(self):
        allocation = {'blockBytes': 1024, 'allocatedPayloadBlocks': [
            {'virtualBlockIndex': 2, 'childSourcedSectorBytes': 512},
            {'virtualBlockIndex': 3, 'childSourcedSectorBytes': 256}]}
        extents = {'files': [
            {'path': 'Bee/a', 'extents': [{'lcn': 2, 'clusters': 4}]},
            {'path': 'ScriptAssemblies/b', 'extents': [{'lcn': 4, 'clusters': 2}]},
            {'path': 'Sparse/c', 'extents': [{'lcn': -1, 'clusters': 100}]}]}
        result = correlate(allocation, extents, {'partitionOffsetBytes': 1024, 'clusterBytes': 512})
        self.assertEqual(result['byDirectory']['Bee']['overlappingAllocatedBlocks'], 2)
        self.assertEqual(result['byDirectory']['Bee']['childSourcedBytesInOverlappingBlocks'], 768)
        self.assertEqual(result['byDirectory']['ScriptAssemblies']['overlappingAllocatedBlocks'], 1)
        self.assertEqual(result['byDirectory']['Sparse']['overlappingAllocatedBlocks'], 0)


if __name__ == '__main__':
    unittest.main()
