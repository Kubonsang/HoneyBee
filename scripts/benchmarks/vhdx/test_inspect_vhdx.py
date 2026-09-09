import io
import struct
import unittest
import uuid

from inspect_vhdx import analyze, crc32c, MIB, BAT_GUID, METADATA_GUID, PARAMETERS_GUID, SIZE_GUID, SECTOR_GUID


def checksum(data, offset, length):
    struct.pack_into('<I', data, offset + 4, 0)
    struct.pack_into('<I', data, offset + 4, crc32c(data[offset:offset + length]))


def fixture():
    data = bytearray(9 * MIB)
    data[:8] = b'vhdxfile'
    for pos in (65536, 131072):
        data[pos:pos + 4] = b'head'
        struct.pack_into('<Q', data, pos + 8, 1)
        struct.pack_into('<HHIQ', data, pos + 64, 0, 1, MIB, MIB)
        checksum(data, pos, 4096)
    for pos in (192 * 1024, 256 * 1024):
        data[pos:pos + 4] = b'regi'
        struct.pack_into('<I', data, pos + 8, 2)
        for index, (guid, off) in enumerate(((BAT_GUID, 2 * MIB), (METADATA_GUID, 3 * MIB))):
            struct.pack_into('<16sQII', data, pos + 16 + index * 32, uuid.UUID(guid).bytes_le, off, MIB, 1)
        checksum(data, pos, 65536)
    pos = 3 * MIB
    data[pos:pos + 8] = b'metadata'
    struct.pack_into('<H', data, pos + 10, 3)
    for index, (guid, payload) in enumerate(((PARAMETERS_GUID, struct.pack('<II', 2 * MIB, 2)), (SIZE_GUID, struct.pack('<Q', 64 << 30)), (SECTOR_GUID, struct.pack('<I', 4096)))):
        off = 65536 + index * 32
        struct.pack_into('<16sIIII', data, pos + 32 + index * 32, uuid.UUID(guid).bytes_le, off, len(payload), 0, 0)
        data[pos + off:pos + off + len(payload)] = payload
    struct.pack_into('<Q', data, 2 * MIB, 5 * MIB | 7)
    struct.pack_into('<Q', data, 2 * MIB + 8, 7 * MIB | 6)
    struct.pack_into('<Q', data, 2 * MIB + 16384 * 8, 4 * MIB | 6)
    data[4 * MIB] = 1
    return data


class AllocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = fixture()

    def test_crc_known_vector(self):
        self.assertEqual(crc32c(b'123456789'), 0xe3069283)

    def test_partial_and_full_payload(self):
        result = analyze(io.BytesIO(self.original), len(self.original))
        self.assertEqual(result['presentPayloadBytes'], 4 * MIB)
        self.assertEqual(result['childSourcedSectorBytes'], 2 * MIB + 4096)
        self.assertEqual(result['payloadSlackBytes'], 2 * MIB - 4096)
        self.assertEqual(result['modeledOneMiBPayloadBytes'], 3 * MIB)

    def test_missing_bitmap_rejected(self):
        data = bytearray(self.original)
        struct.pack_into('<Q', data, 2 * MIB + 16384 * 8, 0)
        with self.assertRaisesRegex(ValueError, 'bitmap'):
            analyze(io.BytesIO(data), len(data))

    def test_overlap_rejected(self):
        data = bytearray(self.original)
        struct.pack_into('<Q', data, 2 * MIB + 8, 5 * MIB | 6)
        with self.assertRaisesRegex(ValueError, 'overlap'):
            analyze(io.BytesIO(data), len(data))

    def test_bad_checksums_rejected(self):
        data = bytearray(self.original)
        data[65536 + 8] ^= 1
        data[131072 + 8] ^= 1
        with self.assertRaisesRegex(ValueError, 'header'):
            analyze(io.BytesIO(data), len(data))

    def test_pending_log_rejected(self):
        data = bytearray(self.original)
        for pos in (65536, 131072):
            data[pos + 48] = 1
            checksum(data, pos, 4096)
        with self.assertRaisesRegex(ValueError, 'log'):
            analyze(io.BytesIO(data), len(data))

    def test_out_of_file_payload_rejected(self):
        data = bytearray(self.original)
        struct.pack_into('<Q', data, 2 * MIB, 99 * MIB | 7)
        with self.assertRaisesRegex(ValueError, 'extent'):
            analyze(io.BytesIO(data), len(data))

    def test_concurrent_bat_change_rejected(self):
        class Changing(io.BytesIO):
            bat_reads = 0

            def read(self, size=-1):
                if self.tell() == 2 * MIB:
                    self.bat_reads += 1
                    if self.bat_reads > 1:
                        result = bytearray(super().read(size))
                        result[0] ^= 1
                        return bytes(result)
                return super().read(size)
        with self.assertRaisesRegex(ValueError, 'changed'):
            analyze(Changing(self.original), len(self.original))


if __name__ == '__main__':
    unittest.main()
