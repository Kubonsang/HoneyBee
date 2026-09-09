"""Read-only VHDX allocation analysis. Never mounts, repairs, or writes an image.

BAT/bitmap counts describe the read source, not semantic differences from a
parent, live NTFS file sizes, historical write traffic, or reclaimable bytes.
"""

import argparse
from collections import Counter
import ctypes
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import uuid

MIB = 1 << 20
BAT_GUID = '2dc27766-f623-4200-9d64-115e9bfd4a08'
METADATA_GUID = '8b7ca206-4790-4b9a-b8fe-575f050f886e'
PARAMETERS_GUID = 'caa16737-fa36-4d43-b3b6-33f0aa44e76b'
SIZE_GUID = '2fa54224-cd1b-4876-b211-5dbed83bf4b8'
SECTOR_GUID = '8141bf1d-a96f-4709-ba47-f233a8faab5f'


def crc32c(data):
    value = 0xffffffff
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value ^ 0xffffffff


def checked(data, signature):
    if data[:len(signature)] != signature:
        raise ValueError('invalid VHDX structure signature')
    expected = struct.unpack_from('<I', data, 4)[0]
    if crc32c(data[:4] + bytes(4) + data[8:]) != expected:
        raise ValueError('VHDX CRC32C mismatch')


def analyze(stream, file_bytes):
    def read(offset, length):
        if offset < 0 or length < 0 or offset + length > file_bytes:
            raise ValueError('VHDX extent outside backing file')
        stream.seek(offset)
        data = stream.read(length)
        if len(data) != length:
            raise ValueError('short VHDX read')
        return data

    if read(0, 8) != b'vhdxfile':
        raise ValueError('not a VHDX file')
    headers = []
    original_headers = {}
    for offset in (65536, 131072):
        raw = read(offset, 4096)
        original_headers[offset] = raw
        try:
            checked(raw, b'head')
            headers.append((struct.unpack_from('<Q', raw, 8)[0], raw))
        except ValueError:
            pass  # One header may be interrupted; use the valid newest header.
    if not headers:
        raise ValueError('no valid VHDX header')
    sequence, header = max(headers, key=lambda h: h[0])
    if header[48:64] != bytes(16):
        raise ValueError('active VHDX metadata log; offline replay required, not performed')
    region_tables = []
    for offset in (192 * 1024, 256 * 1024):
        raw = read(offset, 65536)
        try:
            checked(raw, b'regi')
            region_tables.append(raw)
        except ValueError:
            pass
    if not region_tables or any(t != region_tables[0] for t in region_tables):
        raise ValueError('missing or inconsistent region tables')
    region = region_tables[0]
    count = struct.unpack_from('<I', region, 8)[0]
    if count > 2047:
        raise ValueError('too many regions')
    regions = {}
    for index in range(count):
        guid, offset, length, _ = struct.unpack_from('<16sQII', region, 16 + index * 32)
        key = str(uuid.UUID(bytes_le=guid))
        if key in regions or offset % MIB or length % MIB:
            raise ValueError('duplicate or unaligned region')
        regions[key] = (offset, length)
    meta_offset, meta_length = regions[METADATA_GUID]
    bat_offset, bat_length = regions[BAT_GUID]
    if meta_length > 16 * MIB or bat_length > 64 * MIB:
        raise ValueError('image exceeds bounded diagnostic metadata size')
    meta = read(meta_offset, meta_length)
    if meta[:8] != b'metadata':
        raise ValueError('invalid metadata signature')
    count = struct.unpack_from('<H', meta, 10)[0]
    if count > 2047:
        raise ValueError('too many metadata items')
    items = {}
    for index in range(count):
        guid, offset, length, _, _ = struct.unpack_from('<16sIIII', meta, 32 + index * 32)
        key = str(uuid.UUID(bytes_le=guid))
        if key in items or offset + length > len(meta):
            raise ValueError('invalid metadata item')
        items[key] = meta[offset:offset + length]
    block, flags = struct.unpack('<II', items[PARAMETERS_GUID])
    virtual = struct.unpack('<Q', items[SIZE_GUID])[0]
    sector = struct.unpack('<I', items[SECTOR_GUID])[0]
    if block < MIB or block > 256 * MIB or block & (block - 1) or sector not in (512, 4096):
        raise ValueError('invalid disk geometry')
    if not flags & 2:
        raise ValueError('diagnostic requires a differencing VHDX')
    bat = read(bat_offset, bat_length)
    payload_count = math.ceil(virtual / block)
    ratio = (1 << 23) * sector // block
    if not virtual or math.ceil(payload_count / ratio) * (ratio + 1) * 8 > len(bat):
        raise ValueError('BAT cannot describe virtual disk')

    def entry(index):
        value = struct.unpack_from('<Q', bat, index * 8)[0]
        if value & 0xffff8:
            raise ValueError('reserved BAT bits set')
        return value & 7, (value >> 20) << 20

    states = Counter()
    bitmaps = {}
    owned = 0
    one_mib_blocks = 0
    extents = []
    payload_blocks = []
    for index in range(payload_count):
        owned_before = owned
        sector_runs = []
        state, offset = entry(index + index // ratio)
        states[state] += 1
        if state not in (0, 1, 2, 3, 6, 7):
            raise ValueError('reserved payload state')
        if state in (6, 7):
            if not offset or offset + block > file_bytes:
                raise ValueError('invalid payload extent')
            extents.append((offset, offset + block))
        if state == 6:
            owned += min(block, virtual - index * block)
            one_mib_blocks += block // MIB
            sector_runs = [[0, min(block, virtual - index * block) // sector]]
        elif state == 7:
            chunk = index // ratio
            if chunk not in bitmaps:
                bitmap_state, bitmap_offset = entry((chunk + 1) * (ratio + 1) - 1)
                if bitmap_state != 6 or not bitmap_offset:
                    raise ValueError('partial payload has no valid sector bitmap')
                bitmaps[chunk] = (bitmap_offset, read(bitmap_offset, MIB))
                extents.append((bitmap_offset, bitmap_offset + MIB))
            _, bitmap = bitmaps[chunk]
            start = index % ratio * (block // sector) // 8
            length = block // sector // 8
            bits = bitmap[start:start + length]
            owned += int.from_bytes(bits, 'little').bit_count() * sector
            run_start = None
            for bit in range(length * 8 + 1):
                present = bit < length * 8 and bool(bits[bit // 8] & (1 << (bit % 8)))
                if present and run_start is None:
                    run_start = bit
                if not present and run_start is not None:
                    sector_runs.append([run_start, bit - run_start])
                    run_start = None
            step = MIB // sector // 8
            one_mib_blocks += sum(any(bits[p:p + step]) for p in range(0, len(bits), step))
        if state in (6, 7):
            payload_blocks.append({'virtualBlockIndex': index,
                                   'childSourcedSectorBytes': owned - owned_before,
                                   'childSectorRuns': sector_runs})
    extents.extend([(0, MIB), (meta_offset, meta_offset + meta_length), (bat_offset, bat_offset + bat_length)])
    log_length, log_offset = struct.unpack_from('<IQ', header, 68)
    if log_length:
        extents.append((log_offset, log_offset + log_length))
    ordered = sorted(extents)
    if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
        raise ValueError('overlapping VHDX extents')
    stable = bat == read(bat_offset, bat_length) and meta == read(meta_offset, meta_length)
    stable = stable and all(data == read(offset, MIB) for offset, data in bitmaps.values())
    stable = stable and all(raw == read(offset, 4096) for offset, raw in original_headers.items())
    if not stable:
        raise ValueError('VHDX changed during inspection; retry when idle')
    payload = (states[6] + states[7]) * block
    return {
        'fileBytes': file_bytes, 'blockBytes': block, 'sectorBytes': sector,
        'virtualBytes': virtual, 'headerSequence': sequence,
        'payloadStates': dict(sorted(states.items())), 'presentPayloadBytes': payload,
        'allocatedPayloadBlocks': payload_blocks,
        'childSourcedSectorBytes': owned, 'payloadSlackBytes': payload - owned,
        'otherFileBytes': file_bytes - payload, 'sectorBitmapCountRead': len(bitmaps),
        'modeledOneMiBPayloadBytes': one_mib_blocks * MIB,
        'modelCaveat': 'Same sector ownership and virtual offsets; excludes metadata and filesystem layout changes. Not measured savings.',
        'stableAcrossRead': True, 'batSha256': hashlib.sha256(bat).hexdigest(),
    }


def inspect(path):
    import msvcrt
    class StandardInfo(ctypes.Structure):
        _fields_ = [('allocation', ctypes.c_int64), ('eof', ctypes.c_int64),
                    ('links', ctypes.c_uint32), ('delete_pending', ctypes.c_ubyte),
                    ('directory', ctypes.c_ubyte)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    with os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), 'rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        result = analyze(stream, size)
        kernel.GetFileInformationByHandleEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        info = StandardInfo()
        if not kernel.GetFileInformationByHandleEx(handle, 1, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.GetFileAttributesW.argtypes = [ctypes.c_wchar_p]
        kernel.GetFileAttributesW.restype = ctypes.c_uint32
        attributes = kernel.GetFileAttributesW(str(path))
        if attributes == 0xffffffff:
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.GetCompressedFileSizeW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.GetCompressedFileSizeW.restype = ctypes.c_uint32
        high = ctypes.c_uint32()
        ctypes.set_last_error(0)
        low = kernel.GetCompressedFileSizeW(str(path), ctypes.byref(high))
        if low == 0xffffffff and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())
        result['allocatedBytes'] = ((high.value << 32) | low) if attributes & (0x200 | 0x800) else info.allocation
        result['standardInfoAllocationBytes'] = info.allocation
        if os.fstat(stream.fileno()).st_size != size:
            raise ValueError('file length changed during inspection')
    return {'path': str(path), **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('native inspection requires Windows')
    files = []
    for path in args.images:
        try:
            files.append(inspect(path.resolve(strict=True)))
        except (OSError, ValueError, KeyError, struct.error) as error:
            files.append({'path': str(path), 'error': str(error)})
    report = {'schemaVersion': 1, 'measuredAt': datetime.now(timezone.utc).isoformat(),
              'readOnly': True, 'snapshotCaveat': 'Repeated stable reads are not a frozen snapshot.', 'files': files}
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(encoded + '\n', encoding='utf-8')
    print(encoded)
    return int(any('error' in f for f in files))


if __name__ == '__main__':
    raise SystemExit(main())
