import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


class ArchiveTests(unittest.TestCase):
    def test_superseded_footprint_accounting_requires_explicit_exploratory_archive(self):
        with tempfile.TemporaryDirectory() as location:
            root = Path(location) / 'campaign'
            root.mkdir()
            (root / 'campaign.json').write_text('{}')
            (root / 'E-fp-base-10-sample.json').write_text(json.dumps({'mode': 'E-fp-base', 'iteration': 10}))
            archive = Path(location) / 'sample.zip'
            cmd = [sys.executable, str(Path(__file__).with_name('archive_capacity.py')),
                   str(root), str(archive), '--sample', 'E-fp-base-10']
            rejected = subprocess.run(cmd, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('footprint-accounting-confirmation-required', rejected.stderr)
            self.assertFalse(archive.exists())
            kept = subprocess.run(cmd + ['--exploratory'], capture_output=True, text=True)
            self.assertEqual(kept.returncode, 0, kept.stderr)
            self.assertTrue(json.loads(archive.with_suffix('.receipt.json').read_text())['exploratoryOnly'])

    def test_sample_evidence_is_verified_without_library_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as location:
            root = Path(location) / 'campaign'
            root.mkdir()
            (root / 'campaign.json').write_text('{}')
            (root / 'E-control-0-sample.json').write_text('{}')
            project = root / 'E-control-0'
            (project / 'Library').mkdir(parents=True)
            (project / 'Library' / 'cache').write_text('disposable')
            evidence = project / '.testplay' / 'results'
            evidence.mkdir(parents=True)
            (evidence / 'result.json').write_text('{"passed":37}')
            archive = Path(location) / 'sample.zip'
            cmd = [sys.executable, str(Path(__file__).with_name('archive_capacity.py')),
                   str(root), str(archive), '--sample', 'E-control-0']
            completed = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            receipt = json.loads(archive.with_suffix('.receipt.json').read_text())
            self.assertTrue(receipt['verified'])
            with zipfile.ZipFile(archive) as z:
                self.assertIn('E-control-0/.testplay/results/result.json', z.namelist())
                self.assertFalse(any('/Library/' in n for n in z.namelist()))
            original = archive.read_bytes()
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            self.assertEqual(archive.read_bytes(), original)
            cmd[-1] = '../escape'
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
