"""Validate the isolated product-broker Unity campaign, without capacity qualification."""
import argparse
import json
from pathlib import Path


def summarize(root):
    root = root.resolve()
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8-sig'))
    status, campaign = read('status.json'), read('campaign.json')
    if not status['ok'] or status['protocol'] != 'broker-bee-v1' or campaign['protocol'] != status['protocol']:
        raise ValueError('broker campaign did not complete')
    parent = campaign['parent']
    if parent['compatibilityKey']['layout'] != 'external-bee-dag-v1' or not parent['immutable'] or not parent['beeSeed']['sha256']:
        raise ValueError('parent was not committed with a Bee seed')
    expected = [f'{name}-{phase}' for name in ('one', 'two') for phase in ('first', 'reopen')]
    expected += [f'{name}-cycle{cycle}-{platform}' for name, cycles in (('one', 3), ('two', 4))
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
    if len({r['runId'] for r in runs}) != 14:
        raise ValueError('duplicate test run identity')
    user_root = Path(parent['vhdxPath']).parents[2]
    if user_root.parent != root / 'store':
        raise ValueError('foreign parent storage')
    samples = []
    for name in ('one', 'two'):
        receipt = read(name + '-removal.json')
        child = user_root / 'children' / (receipt['leaseId'] + '.vhdx')
        cache = child.with_suffix('.bee')
        if (receipt['state'] != 'committed' or receipt['runId'] != name
                or Path(receipt['childPath']) != child or child.exists() or cache.exists()
                or (root / name / 'Library').exists()):
            raise ValueError('sample removal incomplete')
        last = [p for p in phases if p['name'].startswith(name + '-')][-1]
        samples.append({'name': name, 'removed': True,
                        'lastObservedChildBytes': last['child']['allocatedBytes'],
                        'lastObservedExternalLogicalBytes': last['external']['logicalBytes']})
    return {'protocol': 'broker-bee-v1', 'ok': True, 'passedTests': sum(r['passed'] for r in runs),
            'samples': samples, 'runs': runs, 'rebootTested': False, 'capacityQualified': False,
            'limits': ['Phase observations precede final detach; this is not a capacity qualification.',
                       'External Bee phase figures are file lengths, not allocated-cluster measurements.',
                       'Isolated in-process broker; the installed service was not replaced.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = summarize(args.root)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'runs'}, indent=2))
