"""Aggregate xperf FileIo CSV by exact Library path (streaming, bounded memory).

Counts are requested I/O bytes, including repeated writes and System writeback;
they are not unique content, physical disk traffic, or child allocation.
"""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path


def normalized(value):
    # xperf escapes backslashes in its CSV string payloads.
    return value.strip().replace('\\\\', '\\').replace('/', '\\')


def summarize(stream, library):
    prefix = normalized(library).rstrip('\\') + '\\'
    headers = {}
    in_header = True
    writes, reads, writers, operations = Counter(), Counter(), Counter(), Counter()
    write_count = 0
    unresolved = 0
    undecodable_rows = 0
    matched_undecodable_rows = 0
    for row in csv.reader(stream, skipinitialspace=True):
        if not row:
            continue
        undecodable = any(any('\udc80' <= c <= '\udcff' for c in value) for value in row)
        undecodable_rows += undecodable
        event = row[0].strip()
        if event == 'EndHeader':
            in_header = False
            continue
        if in_header:
            headers[event] = [v.strip() for v in row]
            continue
        if event not in ('FileIoWrite', 'FileIoRead', 'FileIoSetInfo'):
            continue
        fields = dict(zip(headers.get(event, []), row))
        name = normalized(fields.get('FileName', ''))
        if not name or name.lower() in ('unknown', '<unknown>', 'n/a'):
            unresolved += event == 'FileIoWrite'
            continue
        if not name.casefold().startswith(prefix.casefold()):
            continue
        matched_undecodable_rows += undecodable
        relative = name[len(prefix):].replace('\\', '/')
        operations[event] += 1
        if event == 'FileIoSetInfo':
            continue
        size = int(fields['Size'].strip(), 0)
        if size < 0:
            raise ValueError('negative I/O size')
        if event == 'FileIoWrite':
            writes[relative] += size
            write_count += 1
            writers[fields.get('Process Name ( PID)', '').strip()] += size
        else:
            reads[relative] += size
    if in_header or 'FileIoWrite' not in headers:
        raise ValueError('missing xperf FileIo header')
    folders = Counter()
    for name, size in writes.items():
        top = name.split('/')[0] if '/' in name else '(root)'
        if name.startswith('$'):
            top = '(filesystem metadata)'
        folders[top] += size
    return {'schemaVersion': 1, 'library': library, 'writeEvents': write_count,
            'requestedWriteBytes': sum(writes.values()), 'requestedReadBytes': sum(reads.values()),
            'operations': dict(operations), 'writeBytesByDirectory': dict(folders.most_common()),
            'writeBytesByProcess': dict(writers.most_common()),
            'topWrittenFiles': [{'path': name, 'requestedBytes': size} for name, size in writes.most_common(30)],
            'unresolvedGlobalWriteEvents': unresolved,
            'rowsWithUndecodableBytes': undecodable_rows,
            'matchedRowsWithUndecodableBytes': matched_undecodable_rows,
            'caveat': 'Exact Library path only; includes System writeback. Rewrites count repeatedly. Unresolved names are not attributed.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--library', required=True)
    parser.add_argument('--encoding', default='utf-8', help='CSV encoding; undecodable bytes are preserved and counted')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    with args.csv.open(encoding=args.encoding, errors='surrogateescape', newline='') as stream:
        result = summarize(stream, args.library)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
