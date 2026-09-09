"""Correlate current NTFS file extents with allocated virtual blocks (not write attribution)."""
import argparse
import json
from pathlib import Path


def correlate(allocation, extents, volume):
    block = allocation['blockBytes']
    allocated = {b['virtualBlockIndex']: b['childSourcedSectorBytes']
                 for b in allocation['allocatedPayloadBlocks']}
    groups = {}
    for file in extents['files']:
        if file.get('error'):
            continue
        group = file['path'].split('/')[0] if '/' in file['path'] else '(root)'
        present = groups.setdefault(group, set())
        for extent in file['extents'] or []:
            if extent['lcn'] < 0:
                continue
            start = volume['partitionOffsetBytes'] + extent['lcn'] * volume['clusterBytes']
            end = start + extent['clusters'] * volume['clusterBytes']
            present.update(b for b in range(start // block, (end - 1) // block + 1) if b in allocated)
    return {'byDirectory': {name: {'overlappingAllocatedBlocks': len(blocks),
                                   'childSourcedBytesInOverlappingBlocks': sum(allocated[b] for b in blocks)}
                             for name, blocks in groups.items()},
            'extentFailures': [{'path': f['path'], 'error': f['error']} for f in extents['files'] if f.get('error')],
            'caveat': 'Up to 80 largest selected Library files only. Overlap is not causal write attribution; groups may share blocks. Do not sum groups.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('allocation', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = {}
    for image in json.loads(args.allocation.read_text(encoding='utf-8'))['files']:
        if 'error' in image:
            raise ValueError(image['error'])
        name = Path(image['path']).stem
        extents = json.loads((args.root / (name + '-extents.json')).read_text(encoding='utf-8'))
        volume = json.loads((args.root / (name + '-volume.json')).read_text(encoding='utf-8'))
        result[name] = correlate(image, extents, volume)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
