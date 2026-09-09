"""Validate footprint evidence and keep exploratory counters separate from qualification."""
import argparse
import json
from pathlib import Path
from statistics import median

TIMINGS = ('firstMs', 'reopenMs', 'editMs', 'playMs', 'readyMs')


def metrics(rows, cycles, precise=False):
    if not rows:
        raise ValueError('missing samples')
    values = {key: [] for key in (*TIMINGS, 'childMedianBytes', 'externalMedianBytes', 'combinedMedianBytes')}
    child_peak = combined_peak = passed = 0
    for row in rows:
        if row.get('error') or row['detached'] != row['afterReadonlyVerification']:
            raise ValueError('failed or mutated sample')
        if precise and row.get('allocationMeasurement') != 'native-allocated-v2':
            raise ValueError('qualification requires native allocated-byte counters')
        if row['geometry']['BlockSize'] != 1048576 or row['geometry']['SectorSize'] != 4096:
            raise ValueError('unexpected disk geometry')
        phases = row['phases']
        if len(phases) != 2 + cycles * 2:
            raise ValueError('incomplete workload')
        edit, play = [], []
        for i, phase in enumerate(phases):
            child_peak = max(child_peak, phase['observedPeakAllocatedBytes'])
            combined_peak = max(combined_peak, phase['observedCombinedPeakAllocatedBytes'])
            if i < 2:
                continue
            expected, suffix = (37, 'edit_mode') if i % 2 == 0 else (15, 'play_mode')
            if not phase['name'].endswith(suffix) or phase.get('total') != expected or phase.get('passed') != expected or not phase.get('testRunId'):
                raise ValueError('missing expected test executions')
            (edit if suffix == 'edit_mode' else play).append(phase['elapsedMs'])
            passed += phase['passed']
        child = row['detached']['allocatedBytes']
        combined = child + phases[-1]['external']['allocatedBytes']
        child_peak, combined_peak = max(child_peak, child), max(combined_peak, combined)
        values['childMedianBytes'].append(child)
        values['externalMedianBytes'].append(phases[-1]['external']['allocatedBytes'])
        values['combinedMedianBytes'].append(combined)
        values['firstMs'].append(phases[0]['elapsedMs'])
        values['reopenMs'].append(phases[1]['elapsedMs'])
        values['readyMs'].append(row['readyMs'])
        if row['readyMs'] != row['preparationMs'] + phases[0]['elapsedMs']:
            raise ValueError('preparation excluded from ready time')
        values['editMs'].append(median(edit))
        values['playMs'].append(median(play))
    return {**{k: median(v) for k, v in values.items()}, 'peakBytes': child_peak,
            'observedCombinedPeakBytes': combined_peak, 'passedTests': passed,
            'samples': len(rows), 'individualValues': values}


def evaluate(candidate, control):
    ratios = {key: candidate[key] / control[key] for key in TIMINGS}
    savings = 1 - candidate['combinedMedianBytes'] / control['combinedMedianBytes']
    gates = {'combinedSavings': savings >= .20 - 1e-12,
             'combinedPeak': candidate['observedCombinedPeakBytes'] <= control['observedCombinedPeakBytes'],
             **{key: value <= 1.10 for key, value in ratios.items()}}
    return {'savingsFraction': savings, 'timingRatios': ratios, 'gates': gates,
            'childPeakRatioInformational': candidate['peakBytes'] / control['peakBytes'],
            'capacityTimingQualified': all(gates.values())}


def summarize(root):
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8-sig'))
    rows = read('measurements.json')
    result = {'protocol': 'footprint-report-v1', 'qualified': False,
              'pilotGroups': {}, 'finalGroups': {}, 'comparisons': {},
              'mbDefinition': 1000000, 'sharedParentAndAuthoredFilesExcluded': True}
    policies = sorted({r['mode'] for r in rows if r['iteration'] < 10})
    for policy in policies:
        pilot = [r for r in rows if r['mode'] == policy and r['iteration'] < 10]
        result['pilotGroups'][policy] = metrics(pilot, 1)
        result['pilotGroups'][policy]['preciseAllocation'] = all(r.get('allocationMeasurement') == 'native-allocated-v2' for r in pilot)
    confirmation = root / 'confirmation-measurements.json'
    if confirmation.exists():
        final = [r for r in read(confirmation.name) if 200 <= r['iteration'] <= 202]
        terminal = read('confirmation.json')
    else:
        final = [r for r in rows if 10 <= r['iteration'] <= 12 and r.get('allocationMeasurement') == 'native-allocated-v2']
        terminal = read('status.json')
    if not terminal['ok']:
        raise ValueError('campaign is not successfully terminal')
    if final:
        for policy in sorted({r['mode'] for r in final}):
            samples = [r for r in final if r['mode'] == policy]
            if len(samples) != 3 or len({r['iteration'] for r in samples}) != 3:
                raise ValueError('three distinct final samples required')
            result['finalGroups'][policy] = metrics(samples, 5, precise=True)
        control = result['finalGroups']['E-fp-base']
        for policy, value in result['finalGroups'].items():
            if policy != 'E-fp-base':
                result['comparisons'][policy] = evaluate(value, control)
        selected = terminal.get('selected', '')
        if terminal.get('qualified'):
            if not result['comparisons'][selected]['capacityTimingQualified']:
                raise ValueError('runner qualification disagrees with independent validator')
            compatibility = read('compatibility.json')
            if not compatibility['ok'] or len(compatibility['phases']) != 14:
                raise ValueError('missing concurrent/retained/survivor validation')
            result.update(qualified=True, selected=selected)
    # Count the unique phase receipts, including diagnostic and compatibility runs.
    result['totalRecordedPassingTestExecutions'] = sum(read(p.name).get('passed', 0) for p in root.glob('E-fp-*-phase.json'))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = summarize(args.root)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result['comparisons'], indent=2))


if __name__ == '__main__':
    main()
