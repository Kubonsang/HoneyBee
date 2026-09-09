"""Validate the isolated product-broker Unity campaign, without capacity qualification."""
import argparse
import json
from pathlib import Path


def summarize(root):
    root = root.resolve()
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8-sig'))
    status, campaign = read('status.json'), read('campaign.json')
    if not status['ok'] or status['protocol'] not in ('broker-bee-v1', 'broker-bee-compressed-v1') or campaign['protocol'] != status['protocol']:
        raise ValueError('broker campaign did not complete')
    compressed = status['protocol'] == 'broker-bee-compressed-v1'
    parent = campaign['parent']
    if parent['compatibilityKey']['layout'] != 'external-bee-dag-v1' or not parent['immutable'] or not parent['beeSeed']['sha256']:
        raise ValueError('parent was not committed with a Bee seed')
    expected = [f'{name}-{phase}' for name in ('one', 'two') for phase in ('first', 'reopen')]
    cycles_by_sample = (('one', 5), ('two', 6)) if compressed else (('one', 3), ('two', 4))
    expected += [f'{name}-cycle{cycle}-{platform}' for name, cycles in cycles_by_sample
                 for cycle in range(1, cycles + 1) for platform in ('edit_mode', 'play_mode')]
    phases = status['phases']
    if sorted(p['name'] for p in phases) != sorted(expected):
        raise ValueError('missing or duplicate workload phase')
    runs = []
    for phase in phases:
        if read(phase['name'] + '-phase.json') != phase:
            raise ValueError('phase evidence mismatch')
        if '-cycle' not in phase['name']:
            continue
        result = read(phase['name'] + '.json')
        count = 37 if phase['name'].endswith('edit_mode') else 15
        if (result['backend'] != 'process' or result['run_id'] != phase['testRunId']
                or result['exit_code'] != 0 or result['failed'] or result['skipped']
                or result['passed'] != count or result['total'] != count
                or phase['passed'] != count or phase['total'] != count):
            raise ValueError('Unity test evidence mismatch')
        runs.append({'name': phase['name'], 'runId': result['run_id'], 'passed': count})
    if len({r['runId'] for r in runs}) != (22 if compressed else 14):
        raise ValueError('duplicate test run identity')
    if compressed:
        for name in ['one-created', 'two-created'] + [r['name'] for r in runs]:
            state = read(name + '-compression.json')
            if (state['files'] == 0 or state['files'] != state['compressedFiles']
                    or state['directories'] != state['compressedDirectories']):
                raise ValueError('product compression evidence missing')
        for round_number in range(3, 6):
            record = read(f'concurrent-round-{round_number}.json')
            if not record['ok'] or record['children'] != 2 or record['round'] != round_number:
                raise ValueError('concurrent retained round missing')
    user_root = Path(parent['vhdxPath']).parents[2]
    if user_root.parent != root / 'store':
        raise ValueError('foreign parent storage')
    samples = []
    for name in ('one', 'two'):
        exported_receipt = root / (name + '-removal.json')
        receipt_path = exported_receipt if exported_receipt.exists() else user_root / 'receipts' / ('removal-' + name + '.json')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8-sig'))
        child = user_root / 'children' / (receipt['leaseId'] + '.vhdx')
        cache = child.with_suffix('.bee')
        if (receipt['state'] != 'committed' or receipt['runId'] != name
                or Path(receipt['childPath']) != child or child.exists() or cache.exists()
                or (root / name / 'Library').exists()):
            raise ValueError('sample removal incomplete')
        last = [p for p in phases if p['name'].startswith(name + '-')][-1]
        samples.append({'name': name, 'removed': True,
                        'removal': {key: receipt[key] for key in ('runId', 'leaseId', 'childPath', 'state')},
                        'lastObservedChildBytes': last['child']['allocatedBytes'],
                        'lastObservedExternalAllocatedBytes': last['external']['allocatedBytes'],
                        'lastObservedExternalLogicalBytes': last['external']['logicalBytes']})
    return {'protocol': status['protocol'], 'ok': True, 'compressionValidated': compressed,
            'concurrentRetainedRounds': 3 if compressed else 0, 'passedTests': sum(r['passed'] for r in runs),
            'samples': samples, 'runs': runs, 'rebootTested': False, 'capacityQualified': False,
            'limits': ['Phase observations precede final detach; this is not a capacity qualification.',
                       ('External Bee allocated bytes use compressed/sparse allocation or ordinary file allocation; logical lengths are reported separately.'
                        if compressed else 'External Bee phase figures are file lengths, not allocated-cluster measurements.'),
                       'This Unity campaign uses an isolated in-process broker; installed-service validation is recorded separately.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = summarize(args.root)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'runs'}, indent=2))
