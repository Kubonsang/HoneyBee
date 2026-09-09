"""Validate the independent DAG-candidate lifecycle campaign, without changing size gates."""
import argparse
import json
from pathlib import Path


def summarize(root):
    root = root.resolve()
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8-sig'))
    campaign, status = read('campaign.json'), read('status.json')
    if campaign['protocol'] != 'startup-lifecycle-v1' or status['protocol'] != campaign['protocol']:
        raise ValueError('unexpected lifecycle protocol')
    if not status['ok'] or not status.get('lifecycleValidated') or status['qualified']:
        raise ValueError('lifecycle did not complete independently of the capacity gate')
    rows = read('measurements.json')
    if sorted((r['mode'], r['iteration']) for r in rows) != [('E-dag', 10), ('E-dag', 11)]:
        raise ValueError('two distinct DAG samples required')
    if len({r['externalPath'].casefold() for r in rows}) != 2 or len({r['child'].casefold() for r in rows}) != 2:
        raise ValueError('samples share writable storage')
    phases = []
    samples = []
    for row in rows:
        name = f"{row['mode']}-{row['iteration']}"
        if Path(row['child']) != root / (name + '.vhdx') or Path(row['externalPath']) != root / (name + '-bee'):
            raise ValueError('sample storage outside its owned identity')
        expected = [f'{name}-{p}' for p in ('first', 'reopen', 'cycle1-edit_mode', 'cycle1-play_mode')]
        if row.get('error') or [p['name'] for p in row['phases']] != expected:
            raise ValueError('incomplete initial workload')
        if row['geometry']['BlockSize'] != 1048576 or row['detached'] != row['afterReadonlyVerification']:
            raise ValueError('invalid geometry or verification growth')
        phases.extend(row['phases'][2:])
        cleanup = read(name + '-cleanup.json')
        required = {row['child'], row['externalPath'], str(root / name)}
        if not cleanup['ok'] or not required.issubset(cleanup['removed']) or any(Path(p).exists() for p in cleanup['removed']):
            raise ValueError('sample cleanup incomplete')
        samples.append({'name': name, 'initialChildBytes': row['detached']['allocatedBytes'],
                        'initialExternalBytes': row['phases'][-1]['external']['allocatedBytes'],
                        'removed': True, 'archiveSHA256': cleanup['archiveSHA256']})
    compatibility = read('compatibility.json')
    expected = [f'E-dag-{i}-compat{r}-{p}' for r in range(1, 4) for i in (10, 11)
                for p in ('edit_mode', 'play_mode')]
    expected += [f'E-dag-11-compat4-{p}' for p in ('edit_mode', 'play_mode')]
    if not compatibility['ok'] or sorted(p['name'] for p in compatibility['phases']) != sorted(expected):
        raise ValueError('missing or duplicate retained rounds')
    phases.extend(compatibility['phases'])
    runs = []
    for phase in phases:
        count = 37 if phase['name'].endswith('edit_mode') else 15
        evidence = read(phase['name'] + '.json')
        if (phase['passed'] != count or phase['total'] != count or evidence['backend'] != 'process'
                or evidence['passed'] != count
                or evidence['run_id'] != phase['testRunId'] or evidence['exit_code'] != 0
                or evidence['failed'] != 0 or evidence['skipped'] != 0):
            raise ValueError('test evidence mismatch')
        runs.append({'phase': phase['name'], 'runId': phase['testRunId'], 'passed': count})
    if len({r['runId'] for r in runs}) != 18:
        raise ValueError('duplicate process run identity')
    return {'protocol': campaign['protocol'], 'ok': True, 'candidate': 'E-dag',
            'capacityGateChanged': False, 'samples': samples, 'passedTests': sum(r['passed'] for r in runs),
            'initialPassedTests': 104, 'concurrentPassedTests': 312, 'survivorPassedTests': 52,
            'runs': runs, 'rebootTested': compatibility['rebootTested'],
            'backend': compatibility['backend'],
            'limits': ['Native isolated lifecycle only; installed broker integration is separate.',
                       'No GUI session, service restart or physical reboot was tested.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = summarize(args.root)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k not in ('runs', 'samples')}, indent=2))


if __name__ == '__main__':
    main()
