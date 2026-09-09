import csv
import io
import unittest

from summarize_fileio import summarize


def trace(rows):
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(['BeginHeader'])
    for event in ('FileIoWrite', 'FileIoRead', 'FileIoSetInfo'):
        writer.writerow([event, 'Process Name ( PID)', 'Size', 'FileName'])
    writer.writerow(['EndHeader'])
    writer.writerows(rows)
    stream.seek(0)
    return stream


class FileIoTests(unittest.TestCase):
    def test_rewrites_and_system_writeback_are_counted(self):
        result = summarize(trace([
            ['FileIoWrite', 'Unity.exe (1)', '0x1000', r'C:\work\Library\ArtifactDB'],
            ['FileIoWrite', 'System (4)', '0x1000', r'C:\work\Library\ArtifactDB'],
            ['FileIoRead', 'Unity.exe (1)', '0x2000', r'C:\work\Library\ArtifactDB'],
            ['FileIoSetInfo', 'Unity.exe (1)', '', r'C:\work\Library\ArtifactDB'],
        ]), r'C:\work\Library')
        self.assertEqual(result['requestedWriteBytes'], 8192)
        self.assertEqual(result['requestedReadBytes'], 8192)
        self.assertEqual(result['writeBytesByProcess']['System (4)'], 4096)
        self.assertEqual(result['operations']['FileIoSetInfo'], 1)

    def test_exact_path_and_xperf_escaping(self):
        result = summarize(trace([
            ['FileIoWrite', 'Unity.exe (1)', '0x1000', r'c:\\WORK\\Library\\Bee\\file'],
            ['FileIoWrite', 'Unity.exe (1)', '0x2000', r'C:\work\LibrarySibling\file'],
            ['FileIoWrite', 'System (4)', '0x2000', r'C:\work\child.vhdx'],
            ['FileIoWrite', 'System (4)', '0x2000', '<unknown>'],
        ]), r'C:\work\Library')
        self.assertEqual(result['writeBytesByDirectory'], {'Bee': 4096})
        self.assertEqual(result['unresolvedGlobalWriteEvents'], 1)

    def test_undecodable_bytes_preserved_and_reported(self):
        result = summarize(trace([
            ['FileIoWrite', 'Unity.exe (1)', '0x1000', 'C:\\work\\Library\\a\udca0'],
        ]), r'C:\work\Library')
        self.assertEqual(result['rowsWithUndecodableBytes'], 1)
        self.assertEqual(result['requestedWriteBytes'], 4096)
        self.assertEqual(result['topWrittenFiles'][0]['path'], 'a\udca0')

    def test_invalid_input_rejected(self):
        with self.assertRaises(ValueError):
            summarize(io.StringIO('unrelated text\n'), r'C:\work\Library')
        with self.assertRaises(ValueError):
            summarize(trace([
                ['FileIoWrite', 'Unity.exe (1)', '-1', r'C:\work\Library\file'],
            ]), r'C:\work\Library')


if __name__ == '__main__':
    unittest.main()
