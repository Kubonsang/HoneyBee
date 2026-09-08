"""Summarize untraced, completed VHDX benchmark runs; never infer a pass from partial data."""
import argparse
import json
from pathlib import Path
from statistics import median


def summarize(rows, status):
    if status.get('ok') is not True:
        raise ValueError('benchmark did not complete successfully')
    if any(r.get('measurementProtocol') != 'readonly-verification-v2' for r in rows):
        raise ValueError('legacy scans can change NTFS metadata; rerun with read-only verification')
    if any(r['afterDetach'] != r['afterVerification'] for r in rows):
        raise ValueError('verification changed allocation')
    groups = {mode: [r for r in rows if r['mode'] == mode] for mode in ('2mib', '1mib')}
    if any(r.get('traced') is not False for r in rows):
        raise ValueError('traced runs cannot qualify performance')
    if any(len(group) < 3 for group in groups.values()):
        raise ValueError('at least three fresh children per geometry are required')
    iterations = [{r['iteration'] for r in group} for group in groups.values()]
    if iterations[0] != iterations[1] or any(len(g) != len(i) for g, i in zip(groups.values(), iterations)):
        raise ValueError('unpaired or duplicate iterations')
    result = {}
    for mode, group in groups.items():
        compact = [r for r in group if r.get('compactBefore') is not None]
        if not compact or not all(r.get('compactVerified') is True for r in compact):
            raise ValueError('missing verified compaction experiment')
        result[mode] = {
            'samples': len(group),
            'firstOpenMedianMs': median(r['unityMs'] for r in group),
            'reopenMedianMs': median(r['reopenMs'] for r in group),
            'afterUnityMedianBytes': median(r['afterUnity']['allocatedBytes'] for r in group),
            'afterDetachMedianBytes': median(r['afterDetach']['allocatedBytes'] for r in group),
            'afterReopenMedianBytes': median(r['afterReopen']['allocatedBytes'] for r in group),
            'compactionSamples': [
                {'beforeBytes': r['compactBefore']['allocatedBytes'],
                 'afterBytes': r['compactAfter']['allocatedBytes'],
                 'durationMs': r['compactMs']} for r in compact],
        }
    base, candidate = result['2mib'], result['1mib']
    saving = 1 - candidate['afterDetachMedianBytes'] / base['afterDetachMedianBytes']
    first = candidate['firstOpenMedianMs'] / base['firstOpenMedianMs'] - 1
    reopen = candidate['reopenMedianMs'] / base['reopenMedianMs'] - 1
    return {'schemaVersion': 1, 'modes': result, 'savedFraction': saving,
            'firstOpenChangeFraction': first, 'reopenChangeFraction': reopen,
            'benchmarkGatePassed': saving >= .05 and first <= .10 and reopen <= .10,
            'releaseCaveat': 'Benchmark gate only; installed broker/reboot and packaged payload validation remain separate.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    try:
        result = summarize(json.loads((args.root / 'measurements.json').read_text()),
                           json.loads((args.root / 'status.json').read_text()))
    except (OSError, ValueError, KeyError, ZeroDivisionError) as error:
        parser.exit(1, f'Cannot qualify: {error}\n')
    (args.root / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
