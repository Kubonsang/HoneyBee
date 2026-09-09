import io
import unittest
from correlate_footprint_writes import correlate, decoder_warnings


class WriteCorrelationTests(unittest.TestCase):
    def test_decoder_warnings_distinguish_clr_from_fileio(self):
        warning = 'Warning: EventSink signaled an Invalid Event:\nProviderId: {e13c0d23-ccbc-4e12-931b-d9cc2eee27e4}\n'
        result = decoder_warnings(warning)
        self.assertEqual(sum(result['invalidEventsByProvider'].values()), 1)
        with self.assertRaises(ValueError):
            decoder_warnings(warning.replace('e13c0d23-ccbc-4e12-931b-d9cc2eee27e4', '90cbdc39-4a3e-11d1-84f4-0000f80464e3'))
        with self.assertRaises(ValueError):
            decoder_warnings('unclassified decoder failure')

    def test_edit_cycle_excludes_already_allocated_payload_blocks(self):
        trace = io.StringIO('BeginHeader\nFileIoWrite,Size,Offset,FileName\nEndHeader\n'
                            'FileIoWrite,4096,0,C:\\sample\\Library\\a\n')
        inventory = {'files': [{'path': 'a', 'extents': [{'vcn': 0, 'lcn': 0, 'clusters': 1}]}]}
        allocation = {'blockBytes': 1048576, 'allocatedPayloadBlocks': [{'virtualBlockIndex': 1}]}
        result = correlate(trace, r'C:\sample\Library', inventory, inventory, allocation,
                           {'clusterBytes': 4096, 'partitionOffsetBytes': 1048576}, allocation)
        self.assertEqual(result['eligiblePayloadBlocks'], 0)
        self.assertEqual(result['files'][0]['overlappingAllocatedBlocks'], 0)

    def test_repeated_writes_and_changed_extents_do_not_claim_new_blocks(self):
        trace = io.StringIO('BeginHeader\nFileIoWrite,Size,Offset,FileName\nEndHeader\n'
                            'FileIoWrite,4096,0,C:\\sample\\Library\\a\n'
                            'FileIoWrite,4096,0,C:\\sample\\Library\\a\n'
                            'FileIoWrite,4096,0,C:\\sample\\Library\\b\n')
        before = {'files': [{'path': 'a', 'extents': [{'vcn': 0, 'lcn': 0, 'clusters': 1}]},
                            {'path': 'b', 'extents': [{'vcn': 0, 'lcn': 2, 'clusters': 1}]}]}
        after = {'files': [before['files'][0],
                           {'path': 'b', 'extents': [{'vcn': 0, 'lcn': 3, 'clusters': 1}]}]}
        result = correlate(trace, r'C:\sample\Library', before, after,
                           {'blockBytes': 1048576, 'allocatedPayloadBlocks': [{'virtualBlockIndex': 1}]},
                           {'clusterBytes': 4096, 'partitionOffsetBytes': 1048576})
        self.assertEqual(result['files'][0]['requestedWriteBytes'], 8192)
        self.assertEqual(result['files'][0]['overlappingAllocatedBlocks'], 1)
        self.assertEqual(result['unmapped']['absentFailedOrChangedExtentWriteBytes'], 4096)
        self.assertFalse(result['causalAttribution'])


if __name__ == '__main__':
    unittest.main()
