"""Stream a footprint diagnostic trace into conservative file/write/block correlations.

Only unchanged before/after extent maps are used to translate file offsets.
Matching maps do not prove absence of intermediate relocation or file replacement;
the reported amplification is a diagnostic association, not causal attribution.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

from summarize_fileio import normalized
from analyze_footprint import with_metadata


def decoder_warnings(text):
    """Keep known CLR decoder warnings distinct from FileIO evidence failures."""
    if not text.strip():
        return {'invalidEventsByProvider': {}, 'fileIODecoderWarnings': 0}
    providers = Counter()
    for warning in re.split(r'(?m)^Warning:', text):
        if not warning.strip():
            continue
        match = re.search(r'ProviderId:\s*\{([0-9a-f-]+)\}', warning, re.I)
        if 'signaled an Invalid Event:' not in warning or not match:
            raise ValueError('unclassified xperf decoder output; preserve trace for review')
        provider = match.group(1).lower()
        if provider != 'e13c0d23-ccbc-4e12-931b-d9cc2eee27e4':
            raise ValueError('non-CLR decoder warning may affect FileIO evidence')
        providers[provider] += 1
    return {'invalidEventsByProvider': dict(providers), 'fileIODecoderWarnings': 0}


def correlate(stream, library, before, after, allocation, volume, before_allocation=None):
    prefix = normalized(library).rstrip('\\') + '\\'
    initial = {f['path'].casefold(): f for f in before['files']}
    final = {f['path'].casefold(): f for f in after['files']}
    block = allocation['blockBytes']
    present = {b['virtualBlockIndex'] for b in allocation['allocatedPayloadBlocks']}
    if before_allocation is not None:
        present -= {b['virtualBlockIndex'] for b in before_allocation['allocatedPayloadBlocks']}
    cluster, partition = volume['clusterBytes'], volume['partitionOffsetBytes']
    headers, in_header = {}, True
    writes, intersections, unmapped = Counter(), defaultdict(set), Counter()
    events = unresolved = 0
    for row in csv.reader(stream, skipinitialspace=True):
        if not row:
            continue
        event = row[0].strip()
        if event == 'EndHeader':
            in_header = False
            continue
        if in_header:
            headers[event] = [v.strip() for v in row]
            continue
        if event != 'FileIoWrite':
            continue
        fields = dict(zip(headers.get(event, []), row))
        name = normalized(fields.get('FileName', ''))
        if not name or name.lower() in ('unknown', '<unknown>', 'n/a'):
            unresolved += 1
            continue
        if not name.casefold().startswith(prefix.casefold()):
            continue
        relative = name[len(prefix):].replace('\\', '/').casefold()
        size = int(fields['Size'].strip(), 0)
        if size < 0:
            raise ValueError('negative write size')
        writes[relative] += size
        events += 1
        a, b = initial.get(relative), final.get(relative)
        if not a or not b or a.get('error') or b.get('error') or a.get('extents') != b.get('extents'):
            unmapped['absentFailedOrChangedExtentWriteBytes'] += size
            continue
        offset_value = fields.get('Offset', fields.get('ByteOffset', '')).strip()
        if not offset_value:
            unmapped['missingOffsetWriteBytes'] += size
            continue
        offset = int(offset_value, 0)
        if offset < 0:
            raise ValueError('negative write offset')
        mapped_bytes = 0
        for extent in b.get('extents') or []:
            if extent['lcn'] < 0:
                continue
            left = max(offset, extent['vcn'] * cluster)
            right = min(offset + size, (extent['vcn'] + extent['clusters']) * cluster)
            if right <= left:
                continue
            mapped_bytes += right - left
            lba = partition + extent['lcn'] * cluster + left - extent['vcn'] * cluster
            intersections[relative].update(i for i in range(lba // block, (lba + right - left - 1) // block + 1) if i in present)
        unmapped['outsideMappedExtentsWriteBytes'] += size - mapped_bytes
    if in_header or 'FileIoWrite' not in headers:
        raise ValueError('missing FileIO headers')
    rows = []
    for name, size in writes.items():
        count = len(intersections[name])
        rows.append({'path': name, 'requestedWriteBytes': size,
                     'overlappingAllocatedBlocks': count,
                     'associatedBlockBytesPerRequestedByte': count * block / size if size else None})
    rows.sort(key=lambda r: (-r['overlappingAllocatedBlocks'], -r['requestedWriteBytes'], r['path']))
    return {'writeEvents': events, 'requestedWriteBytes': sum(writes.values()),
            'blockScope': 'newly allocated in edit/test cycle' if before_allocation is not None else 'final one-cycle allocation, including pre-launch allocation',
            'eligiblePayloadBlocks': len(present),
            'unresolvedGlobalWriteEvents': unresolved, 'unmapped': dict(unmapped),
            'files': rows, 'causalAttribution': False,
            'caveat': 'Requested bytes include repeated writes and System writeback. Only matching endpoint extents are mapped. Block overlaps are not exclusive or first-touch attribution; do not sum amplification across files.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--xperf', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--phase', choices=('first', 'edit'), default='first')
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
    campaign = read(args.root / 'campaign.json')
    name = 'E-fp-base-90' if args.phase == 'first' else 'E-fp-base-91'
    archive = Path(campaign['evidence']) / (name + '.zip')
    receipt = read(archive.with_suffix('.receipt.json'))
    with archive.open('rb') as stream:
        if not receipt['verified'] or hashlib.file_digest(stream, 'sha256').hexdigest() != receipt['sha256']:
            raise ValueError('unverified diagnostic archive')
    etl = args.output.with_suffix('.etl')
    if etl.exists():
        raise ValueError('diagnostic extraction already exists')
    with zipfile.ZipFile(archive) as data:
        member = data.getinfo(name + '-' + args.phase + '.log.etl')
        if shutil.disk_usage(args.output.parent).free < (20 << 30) + member.file_size * 2:
            raise ValueError('insufficient diagnostic free-space reserve')
        if member.file_size * 2 > 15 << 30:
            raise ValueError('diagnostic exceeds experiment budget')
        with data.open(member) as src, etl.open('xb') as dst:
            shutil.copyfileobj(src, dst)
    stats = args.output.with_suffix('.stats.txt')
    subprocess.run([str(args.xperf), '-i', str(etl), '-o', str(stats), '-a', 'tracestats'], check=True)
    text = stats.read_text(encoding='utf-8-sig')
    lost = {}
    for kind in ('Buffers', 'Events'):
        found = re.search(r'Total # Lost ' + kind + r'\s*:\s*(\d+)', text)
        if not found or int(found.group(1)):
            raise ValueError('missing or lossy trace statistics')
        lost[kind] = int(found.group(1))
    with args.output.with_suffix('.stderr.log').open('w', encoding='utf-8') as stderr:
        with subprocess.Popen([str(args.xperf), '-i', str(etl), '-quiet', '-a', 'dumper',
                               '-provider', '{90cbdc39-4a3e-11d1-84f4-0000f80464e3}'],
                              stdout=subprocess.PIPE, stderr=stderr, text=True,
                              encoding='utf-8', errors='surrogateescape') as process:
            try:
                before = with_metadata(read(args.root / 'diagnostic-parent-extents.json'), read(args.root / 'diagnostic-parent-metadata.json')) if args.phase == 'first' else with_metadata(read(args.root / (name + '-before-edit-full-extents.json')), read(args.root / (name + '-before-edit-metadata.json')))
                before_allocation = None if args.phase == 'first' else read(args.root / (name + '-before-edit-allocation.json'))['files'][0]
                result = correlate(process.stdout, str(args.root / name / 'Library'),
                                   before,
                                   with_metadata(read(args.root / (name + '-full-extents.json')), read(args.root / (name + '-metadata.json'))),
                                   read(args.root / (name + '-allocation.json'))['files'][0],
                                   read(args.root / (name + '-volume.json')), before_allocation)
            except BaseException:
                process.kill()
                raise
            if process.wait() != 0:
                raise ValueError('xperf conversion failed')
    warnings = decoder_warnings(args.output.with_suffix('.stderr.log').read_text(encoding='utf-8'))
    result.update(archiveSHA256=receipt['sha256'], lost=lost, csvMaterialized=False, decoderWarnings=warnings)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    etl.unlink()
    print(json.dumps({'writeEvents': result['writeEvents'], 'unmapped': result['unmapped']}))


if __name__ == '__main__':
    main()
