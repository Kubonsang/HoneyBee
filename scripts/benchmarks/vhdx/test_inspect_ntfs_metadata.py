import struct
import unittest
from inspect_ntfs_metadata import attributes, mapping_pairs


class NtfsMetadataTests(unittest.TestCase):
    def test_signed_lcn_deltas_and_sparse_runs(self):
        rows = mapping_pairs(bytes([0x11, 3, 20, 0x11, 2, 0xfc, 0x01, 1, 0]), 0, 5)
        self.assertEqual(rows, [{'vcn': 0, 'lcn': 20, 'clusters': 3},
                                {'vcn': 3, 'lcn': 16, 'clusters': 2},
                                {'vcn': 5, 'lcn': -1, 'clusters': 1}])

    def test_truncated_and_out_of_bounds_runs_rejected(self):
        for data, high in ((bytes([0x11, 1]), 0), (bytes([0x11, 2, 1, 0]), 0),
                           (bytes([0x11, 1, 0xff, 0]), 0)):
            with self.assertRaises(ValueError):
                mapping_pairs(data, 0, high)

    def test_record_fixup_and_torn_record_rejection(self):
        record = bytearray(1024)
        record[:4] = b'FILE'
        struct.pack_into('<HH', record, 4, 48, 3)
        struct.pack_into('<H', record, 20, 56)
        struct.pack_into('<I', record, 24, 136)
        record[48:54] = b'abcdEF'
        record[510:512] = record[1022:1024] = b'ab'
        struct.pack_into('<II', record, 56, 0x80, 72)
        record[64] = 1
        struct.pack_into('<QQH', record, 72, 0, 2, 64)
        struct.pack_into('<Q', record, 104, 12288)
        record[120:124] = bytes([0x11, 3, 20, 0])
        struct.pack_into('<I', record, 128, 0xffffffff)
        result = attributes(record, '$MFT')
        self.assertEqual(result[0]['extents'][0]['lcn'], 20)
        record[510:512] = b'XX'
        with self.assertRaises(ValueError):
            attributes(record, '$MFT')


if __name__ == '__main__':
    unittest.main()
