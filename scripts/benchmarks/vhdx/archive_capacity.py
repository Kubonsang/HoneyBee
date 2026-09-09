"""Archive capacity evidence without retaining disposable Library/VHDX caches."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--sample', help='Archive one terminal sample before reclaiming its caches')
    parser.add_argument('--exploratory', action='store_true', help='Preserve a footprint sample with superseded allocation accounting; never qualification evidence')
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if args.sample and (Path(args.sample).name != args.sample or '/' in args.sample or '\\' in args.sample or args.sample in ('.', '..')):
        raise ValueError('invalid sample name')
    terminal = args.sample + '-sample.json' if args.sample else 'status.json'
    if not (root / terminal).is_file() or not (root / 'campaign.json').is_file():
        raise ValueError('campaign must have a terminal status and identity')
    if args.sample:
        sample = json.loads((root / terminal).read_text(encoding='utf-8-sig'))
        if sample.get('mode', '').startswith('E-fp-') and 10 <= sample.get('iteration', -1) <= 12 and sample.get('allocationMeasurement') != 'native-allocated-v2' and not args.exploratory:
            raise SystemExit('footprint-accounting-confirmation-required: ordinary-file EOF is not allocated bytes; archive explicitly as exploratory and use fresh native-allocated-v2 confirmation')
    if args.archive.exists():
        raise ValueError('archive already exists')
    paths = [p for p in root.iterdir() if p.is_file() and p.suffix in ('.json', '.log', '.traceevents', '.etl')
             and (not args.sample or p.name.startswith(args.sample + '-') or p.name == 'campaign.json')]
    projects = [root / args.sample] if args.sample else root.iterdir()
    for project in projects:
        for node in (project, project / '.testplay'):
            if node.exists() and getattr(node.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError(f'unexpected evidence ancestor link: {node}')
        if not project.is_dir() or not (project / '.testplay').is_dir():
            continue
        for relative in ('.testplay/results', '.testplay/runs'):
            location = project / relative
            if not location.exists():
                continue
            if getattr(location.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError(f'unexpected evidence root link: {location}')
            for folder, dirs, files in os.walk(location, followlinks=False):
                for name in dirs + files:
                    p = Path(folder, name)
                    if getattr(p.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                        raise ValueError(f'unexpected evidence link: {p}')
                paths.extend(Path(folder, name) for name in files)
    inventory = []
    with zipfile.ZipFile(args.archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for path in sorted(paths):
            if getattr(path.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('linked evidence file')
            relative = path.relative_to(root).as_posix()
            digest = hashlib.sha256()
            size = 0
            with path.open('rb') as source, archive.open(relative, 'w', force_zip64=True) as target:
                while chunk := source.read(1 << 20):
                    digest.update(chunk)
                    target.write(chunk)
                    size += len(chunk)
            inventory.append({'path': relative, 'bytes': size, 'sha256': digest.hexdigest()})
        archive.writestr('archive-inventory.json', json.dumps(inventory, indent=2))
    with zipfile.ZipFile(args.archive) as archive:
        if archive.testzip() is not None:
            raise ValueError('archive CRC verification failed')
        for entry in inventory:
            digest = hashlib.sha256()
            with archive.open(entry['path']) as source:
                while chunk := source.read(1 << 20):
                    digest.update(chunk)
            if digest.hexdigest() != entry['sha256']:
                raise ValueError('archive content verification failed')
    with args.archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    receipt = {'root': str(root), 'archive': str(args.archive.resolve()), 'sha256': digest,
               'exploratoryOnly': args.exploratory,
               'sample': args.sample,
               'files': len(inventory), 'verified': True, 'archiveBytes': args.archive.stat().st_size,
               'verifiedAt': datetime.now(timezone.utc).isoformat()}
    args.archive.with_suffix('.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
