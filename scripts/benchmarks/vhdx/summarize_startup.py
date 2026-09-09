"""Validate and summarize startup-v2 without weakening historical capacity-v1 gates."""
import argparse
import json
import re
from pathlib import Path
from statistics import median


def snapshot_delta(before, after):
    before = {k: v for k, v in before.items() if not v['directory']}
    after = {k: v for k, v in after.items() if not v['directory']}
    common = before.keys() & after.keys()
    changed = [k for k in common if before[k]['sha256'] != after[k]['sha256']]
    return {
        'beforeFiles': len(before), 'afterFiles': len(after),
        'beforeBytes': sum(v['bytes'] for v in before.values()),
        'afterBytes': sum(v['bytes'] for v in after.values()),
        'addedFiles': len(after.keys() - before.keys()),
        'removedFiles': len(before.keys() - after.keys()),
        'changedContentFiles': len(changed),
        'changedContentAfterBytes': sum(after[k]['bytes'] for k in changed),
        'sameContentChangedMetadataFiles': sum(
            before[k]['sha256'] == after[k]['sha256'] and
            any(before[k][m] != after[k][m] for m in ('creation', 'write', 'attributes')) for k in common),
        'caveat': 'Snapshot changes do not measure write traffic or establish invalidation cause.',
    }


def summarize(root):
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8-sig'))
    campaign, status, rows = read('campaign.json'), read('status.json'), read('measurements.json')
    if campaign['protocol'] != 'startup-v2' or status['protocol'] != 'startup-v2':
        raise ValueError('unexpected startup protocol')
    groups = {}
    seen = set()
    tests = 0
    for row in rows:
        key = row['mode'], row['iteration']
        if key in seen:
            raise ValueError('duplicate startup sample')
        seen.add(key)
        if row.get('error'):
            continue
        name = f'{key[0]}-{key[1]}'
        cycles = 1 if key[1] < 10 else 5
        expected = [name + '-first', name + '-reopen'] + [f'{name}-cycle{c}-{p}'
                    for c in range(1, cycles + 1) for p in ('edit_mode', 'play_mode')]
        if [p['name'] for p in row['phases']] != expected:
            raise ValueError('incomplete startup workload')
        if row['geometry']['BlockSize'] != 1048576 or row['detached'] != row['afterReadonlyVerification']:
            raise ValueError('invalid geometry or readonly mutation')
        for p in row['phases'][2:]:
            expected_count = 37 if p['name'].endswith('edit_mode') else 15
            result = read(p['name'] + '.json')
            if p['total'] != expected_count or p['passed'] != expected_count or result['backend'] != 'process' or result['run_id'] != p['testRunId']:
                raise ValueError('test evidence mismatch')
            tests += p['passed']
        first = row['phases'][0]
        if row['readyMs'] != row['preparationMs'] + first['elapsedMs']:
            raise ValueError('initial preparation cost missing')
        log = (root / (name + '-first.log')).read_text(encoding='utf-8', errors='replace')
        matches = re.findall(r'Tundra requires additional run \(([\d.]+) seconds\)', log)
        group = ('pilot' if cycles == 1 else 'qualification') + '/' + key[0]
        groups.setdefault(group, []).append({
            'iteration': key[1], 'childBytes': row['detached']['allocatedBytes'],
            'externalBytes': row['phases'][-1]['external']['allocatedBytes'],
            'peakBytes': max([row['detached']['allocatedBytes']] + [p['observedPeakAllocatedBytes'] for p in row['phases']]),
            'preparationMs': row['preparationMs'], 'readyMs': row['readyMs'],
            'firstMs': first['elapsedMs'], 'reopenMs': row['phases'][1]['elapsedMs'],
            'editMs': median(p['elapsedMs'] for p in row['phases'][2:] if p['name'].endswith('edit_mode')),
            'beeAdditionalRunSeconds': [float(v) for v in matches],
            'beeBuildUpdatedItems': [int(v) for v in re.findall(r'Tundra build success \([\d.]+ seconds\), (\d+) items updated', log)],
            'ilppBusyObserved': bool(re.search(r'\[BUSY.*ILPP-Configuration', log)),
        })
        if (root / (name + '-before-bee-snapshot.json')).exists():
            groups[group][-1]['beeSnapshotDelta'] = snapshot_delta(
                read(name + '-before-bee-snapshot.json'), read(name + '-after-bee-snapshot.json'))
        if (root / (name + '-allocation.json')).exists():
            allocation = read(name + '-allocation.json')['files'][0]
            if not allocation['stableAcrossRead'] or allocation['allocatedBytes'] != row['detached']['allocatedBytes']:
                raise ValueError('allocation inspection differs from detached measurement')
            groups[group][-1]['allocation'] = {k: allocation[k] for k in (
                'childSourcedSectorBytes', 'payloadSlackBytes', 'otherFileBytes', 'presentPayloadBytes')}
    for group in groups.values():
        for sample in group:
            sample['combinedBytes'] = sample['childBytes'] + sample['externalBytes']
    result = {'protocol': 'startup-v2', 'ok': status['ok'], 'selected': status['selected'],
              'qualified': status['qualified'], 'passedTests': tests, 'groups': groups,
              'limits': ['Pilot snapshots can affect timing and are excluded from final qualification.',
                         'Ready time includes per-workspace preparation, excluding diagnostic collection.',
                         'Shared parent creation is a separate one-time preparation cost.',
                         'Batch process tests do not establish GUI behavior or reboot compatibility.']}
    if (root / 'qualification.json').exists():
        result['qualification'] = read('qualification.json')
    for name in ('refinement-pilot', 'confirmation-protocol'):
        if (root / (name + '.json')).exists():
            result[name] = read(name + '.json')
    if (root / 'compatibility.json').exists():
        compatibility = read('compatibility.json')
        result['compatibility'] = {k: compatibility[k] for k in ('ok', 'rebootTested', 'backend')}
        result['compatibility']['passedTests'] = sum(p.get('passed', 0) for p in compatibility['phases'])
        result['compatibility']['runs'] = []
        for phase in compatibility['phases']:
            evidence = read(phase['name'] + '.json')
            count = 37 if phase['name'].endswith('edit_mode') else 15
            if evidence['backend'] != 'process' or evidence['run_id'] != phase['testRunId'] or phase['passed'] != count or phase['total'] != count:
                raise ValueError('retained test evidence mismatch')
            result['compatibility']['runs'].append({'phase': phase['name'], 'runId': phase['testRunId'], 'passed': phase['passed']})
    if status['qualified']:
        if not status['ok'] or not status['selected']:
            raise ValueError('qualified study has no successful selection')
        baseline = groups.get('qualification/A-legacy', [])
        candidate = groups.get('qualification/' + status['selected'], [])
        if any(sorted(s['iteration'] for s in group) != [10, 11, 12] for group in (baseline, candidate)):
            raise ValueError('qualification requires three complete samples per mode')
        if median(s['childBytes'] for s in candidate) > 350e6 or max(s['peakBytes'] for s in candidate) > 400e6 or median(s['combinedBytes'] for s in candidate) > 550e6:
            raise ValueError('qualified study exceeds storage gates')
        for metric in ('firstMs', 'reopenMs', 'editMs', 'readyMs'):
            if median(s[metric] for s in candidate) > 1.1 * median(s[metric] for s in baseline):
                raise ValueError('qualified study exceeds timing gates')
        compatibility = result.get('compatibility', {})
        if not compatibility.get('ok') or compatibility.get('passedTests') != 364:
            raise ValueError('qualification lacks retained compatibility evidence')
        expected = [f"{status['selected']}-{i}-compat{r}-{p}" for r in range(1, 4)
                    for i in (10, 11) for p in ('edit_mode', 'play_mode')]
        expected += [f"{status['selected']}-11-compat4-{p}" for p in ('edit_mode', 'play_mode')]
        if sorted(p['phase'] for p in compatibility['runs']) != sorted(expected):
            raise ValueError('incomplete or duplicate retained rounds')
    if not status['ok']:
        result['error'] = status.get('error', 'study failed')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = summarize(args.root)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'groups'}, indent=2))


if __name__ == '__main__':
    main()
