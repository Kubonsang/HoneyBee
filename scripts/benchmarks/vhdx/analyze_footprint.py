"""Attribute owned sectors to final NTFS extents without claiming causal writes.

Regular files, filesystem metadata, mixed blocks and unresolved sectors remain
separate. A directory's estimated opportunity subtracts its entire private copy;
it is only a screening bound, never a predicted or measured saving.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path


def mask(start, count):
    return ((1 << count) - 1) << start


def with_metadata(inventory, metadata):
    recovered = {r['path'].casefold(): r for r in metadata.get('files', [])}
    rows = [r for r in inventory['files'] if r['path'].casefold() not in recovered]
    return {**inventory, 'files': rows + list(recovered.values()),
            'metadataRecovery': metadata}


def analyze(allocation, inventory, volume, manifest):
    block, sector = allocation['blockBytes'], allocation['sectorBytes']
    cluster, partition = volume['clusterBytes'], volume['partitionOffsetBytes']
    owned = {}
    for item in allocation['allocatedPayloadBlocks']:
        if 'childSectorRuns' not in item:
            raise ValueError('sector bitmap runs required; coarse block overlap is insufficient')
        bits = 0
        for start, count in item['childSectorRuns']:
            if start < 0 or count <= 0 or start + count > block // sector:
                raise ValueError('invalid owned sector run')
            bits |= mask(start, count)
        if bits.bit_count() * sector != item['childSourcedSectorBytes']:
            raise ValueError('owned sector byte mismatch')
        owned[item['virtualBlockIndex']] = bits
    owners = defaultdict(lambda: defaultdict(int))
    failures, sizes = [], Counter()
    metadata = '(filesystem metadata)'
    paths = {p.casefold() for p in manifest}
    for file in inventory['files']:
        name = file['path']
        is_meta = name.startswith('$') or file.get('directory') or name.casefold() not in paths
        group = metadata if is_meta else name.split('/')[0] if '/' in name else '(root files)'
        if not is_meta:
            sizes[group] += file['bytes']
        if file.get('error'):
            failures.append({'path': name, 'error': file['error']})
            continue
        for extent in file.get('extents') or []:
            if extent['lcn'] < 0:
                continue
            begin = partition + extent['lcn'] * cluster
            end = begin + extent['clusters'] * cluster
            if begin % sector or end % sector:
                raise ValueError('extent/sector alignment mismatch')
            for index in range(begin // block, (end - 1) // block + 1):
                if index not in owned:
                    continue
                left = max(begin - index * block, 0) // sector
                right = min(end - index * block, block) // sector
                bits = mask(left, right - left) & owned[index]
                if bits:
                    owners[index][group] |= bits
    counts = Counter()
    groups = defaultdict(lambda: {'overlappingBlocks': 0, 'ownedSectorBytes': 0,
                                 'exclusiveFullyExplainedBlocks': 0})
    unknown_bytes = 0
    for index, bits in owned.items():
        mapped = 0
        for name, present in owners[index].items():
            groups[name]['overlappingBlocks'] += 1
            groups[name]['ownedSectorBytes'] += present.bit_count() * sector
            mapped |= present
        unknown = bits & ~mapped
        unknown_bytes += unknown.bit_count() * sector
        names = set(owners[index])
        if unknown or not names:
            counts['unresolved'] += 1
        elif names == {metadata}:
            counts['metadataOnly'] += 1
        elif metadata in names or len(names) > 1:
            counts['mixed'] += 1
        else:
            counts['regularOnly'] += 1
            groups[next(iter(names))]['exclusiveFullyExplainedBlocks'] += 1
    candidates = []
    for name, row in groups.items():
        row['logicalCopyBytes'] = sizes[name]
        row['screeningNetBytes'] = row['exclusiveFullyExplainedBlocks'] * block - sizes[name]
        if not name.startswith('(') and row['screeningNetBytes'] >= 50_000_000:
            candidates.append({'directory': name, **row})
    candidates.sort(key=lambda row: (-row['screeningNetBytes'], row['directory']))
    return {'allocatedBlocks': len(owned), 'blockClasses': dict(counts),
            'ownedSectorBytes': sum(v.bit_count() * sector for v in owned.values()),
            'unresolvedOwnedSectorBytes': unknown_bytes, 'groups': dict(groups),
            'extentFailures': failures, 'directoryCandidates': candidates,
            'causalAttribution': False,
            'caveat': 'Final extent/sector correlation. Renames, freed/reallocated files, resident data and inaccessible metadata prevent complete causal attribution. Group overlaps must not be summed; screening estimates require an independent experiment.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    results = {}
    read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
    for path in sorted(args.root.glob('E-fp-*-sample.json')):
        row = read(path)
        name = path.name.removesuffix('-sample.json')
        if row.get('error'):
            results[name] = {'error': row['error']}
            continue
        allocation = read(args.root / (name + '-allocation.json'))['files'][0]
        inventory = read(args.root / (name + '-full-extents.json'))
        metadata_path = args.root / (name + '-metadata.json')
        if metadata_path.exists():
            inventory = with_metadata(inventory, read(metadata_path))
        results[name] = analyze(allocation, inventory,
                                read(args.root / (name + '-volume.json')),
                                read(args.root / (name + '-manifest.json')))
    if not results:
        raise ValueError('no samples')
    args.output.write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: {'blocks': v.get('blockClasses'),
                         'candidates': v.get('directoryCandidates')} for k, v in results.items()}, indent=2))


if __name__ == '__main__':
    main()
