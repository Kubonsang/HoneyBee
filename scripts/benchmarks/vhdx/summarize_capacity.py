"""Validate a capacity-v1 campaign; partial/pilot results never qualify a candidate."""
import argparse
import json
from pathlib import Path
from statistics import median

MODES = ('A-legacy', 'B-fresh', 'C-no-bee', 'D-hot-last', 'E-external-bee')
TARGET = 300_000_000


def summarize(campaign, status, rows):
    if campaign.get('protocol') != 'capacity-v1' or status.get('protocol') != 'capacity-v1':
        raise ValueError('unsupported measurement protocol')
    runs, cycles = campaign['runs'], campaign['cycles']
    if len(rows) != len(MODES) * runs:
        raise ValueError('missing samples')
    seen = set()
    grouped = {mode: [] for mode in MODES}
    for row in rows:
        key = row['mode'], row['iteration']
        if key in seen or key[0] not in MODES or not 0 <= key[1] < runs:
            raise ValueError('duplicate or unexpected sample')
        seen.add(key)
        expected = [f'{key[0]}-{key[1]}-{p}' for p in ('first', 'reopen')]
        expected += [f'{key[0]}-{key[1]}-cycle{c}-{p}' for c in range(1, cycles + 1)
                     for p in ('edit_mode', 'play_mode')]
        if row.get('error'):
            grouped[key[0]].append({'error': row['error'], 'iteration': key[1]})
            continue
        if [p['name'] for p in row['phases']] != expected:
            raise ValueError('missing, reordered or unexpected workload phases')
        if row['geometry']['BlockSize'] != 1_048_576:
            raise ValueError('unexpected child geometry')
        if row['detached'] != row['afterReadonlyVerification']:
            raise ValueError('verification changed allocation')
        for p in row['phases'][2:]:
            count = 37 if p['name'].endswith('edit_mode') else 15
            if p['total'] != count or p['passed'] != count or not p.get('testRunId'):
                raise ValueError('test coverage missing or failed')
        phases = row['phases']
        peak = max([row['detached']['allocatedBytes']] +
                   [max(p['observedPeakAllocatedBytes'], p['child']['allocatedBytes']) for p in phases])
        external = phases[-1]['external']['allocatedBytes']
        grouped[key[0]].append({
            'iteration': key[1], 'childBytes': row['detached']['allocatedBytes'],
            'externalBytes': external, 'combinedBytes': row['detached']['allocatedBytes'] + external,
            'observedPeakBytes': peak, 'firstOpenMs': phases[0]['elapsedMs'],
            'reopenMs': phases[1]['elapsedMs'],
            'editCompileAndTestMs': median(p['elapsedMs'] for p in phases[2:] if p['name'].endswith('edit_mode')),
            'playModeMs': median(p['elapsedMs'] for p in phases[2:] if p['name'].endswith('play_mode')),
        })
    result = {}
    fields = ('childBytes', 'externalBytes', 'combinedBytes', 'firstOpenMs', 'reopenMs',
              'editCompileAndTestMs', 'playModeMs')
    for mode, values in grouped.items():
        failed = [v for v in values if 'error' in v]
        if failed:
            result[mode] = {'valid': False, 'failures': failed}
            continue
        result[mode] = {'valid': True, 'samples': values,
                        'medians': {k: median(v[k] for v in values) for k in fields},
                        'maxObservedChildBytes': max(v['observedPeakBytes'] for v in values)}
    baseline = result['A-legacy']
    qualified_protocol = runs == 3 and cycles == 5 and status.get('ok') is True
    for mode, value in result.items():
        if not value['valid'] or not baseline['valid']:
            value['qualified'] = False
            continue
        med, base = value['medians'], baseline['medians']
        value['combinedSavingsFraction'] = 1 - med['combinedBytes'] / base['combinedBytes']
        value['timingRatios'] = {k: med[k] / base[k] for k in
                                ('firstOpenMs', 'reopenMs', 'editCompileAndTestMs')}
        value['capacityTargetMet'] = value['maxObservedChildBytes'] <= TARGET
        value['timingGatePassed'] = all(v <= 1.1 for v in value['timingRatios'].values())
        value['qualified'] = (qualified_protocol and value['capacityTargetMet'] and
                              value['timingGatePassed'] and value['combinedSavingsFraction'] > 0)
    return {'schemaVersion': 1, 'protocol': 'capacity-v1', 'qualifiedProtocol': qualified_protocol,
            'targetBytes': TARGET, 'runs': runs, 'cycles': cycles, 'candidates': result,
            'sharedParentUsage': campaign.get('parentUsage', {}),
            'limits': ['Observed peaks use 250 ms sampling, not a guaranteed upper bound.',
                       'Edit timing includes compilation and EditMode tests, not isolated compiler CPU time.',
                       'Timed phases exclude parent preparation and initial source/external Bee copies.',
                       'Shared parents and authored files are excluded from per-workspace totals.',
                       'Concurrent/reconnect/removal validation is a separate gate for qualifying candidates.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    read = lambda name: json.loads((args.root / name).read_text(encoding='utf-8-sig'))
    result = summarize(read('campaign.json'), read('status.json'), read('measurements.json'))
    encoded = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(encoded + '\n', encoding='utf-8')
    print(encoded)


if __name__ == '__main__':
    main()
