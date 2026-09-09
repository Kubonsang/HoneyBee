"""Read NTFS metadata retrieval maps with FSCTL_GET_NTFS_FILE_RECORD.

Uses a read-only volume handle. No raw-sector writing, mounting or repair.
Only documented NTFS v3 file-record/attribute layouts are accepted. Attribute
lists are reported as partial; unparsed continuation segments remain unknown.
"""
import argparse
import ctypes
import json
import re
import struct
from pathlib import Path


def mapping_pairs(data, vcn, highest):
    rows, pos, lcn = [], 0, 0
    while pos < len(data) and data[pos]:
        sizes = data[pos]
        pos += 1
        length_bytes, offset_bytes = sizes & 15, sizes >> 4
        if not 1 <= length_bytes <= 8 or offset_bytes > 8 or pos + length_bytes + offset_bytes > len(data):
            raise ValueError('invalid mapping pair')
        count = int.from_bytes(data[pos:pos + length_bytes], 'little')
        pos += length_bytes
        if not count or vcn + count > highest + 1:
            raise ValueError('invalid mapping run length')
        if offset_bytes:
            lcn += int.from_bytes(data[pos:pos + offset_bytes], 'little', signed=True)
            if lcn < 0:
                raise ValueError('negative physical LCN')
        rows.append({'vcn': vcn, 'lcn': lcn if offset_bytes else -1, 'clusters': count})
        pos += offset_bytes
        vcn += count
    if pos >= len(data) or vcn != highest + 1:
        raise ValueError('unterminated or incomplete mapping pairs')
    return rows


def attributes(record, name):
    data = bytearray(record)
    if data[:4] != b'FILE' or len(data) < 48:
        raise ValueError('not an NTFS file record')
    usa, count = struct.unpack_from('<HH', data, 4)
    if count < 2 or usa + count * 2 > len(data) or len(data) % (count - 1):
        raise ValueError('invalid update sequence array')
    stride = len(data) // (count - 1)
    if stride not in (512, 4096):
        raise ValueError('unsupported update sequence stride')
    signature = data[usa:usa + 2]
    for index in range(1, count):
        end = index * stride
        replacement = data[usa + index * 2:usa + index * 2 + 2]
        if data[end - 2:end] == signature:
            data[end - 2:end] = replacement
        elif data[end - 2:end] != replacement:
            raise ValueError('torn file record')
    pos = struct.unpack_from('<H', data, 20)[0]
    used = struct.unpack_from('<I', data, 24)[0]
    if pos < 24 or used > len(data):
        raise ValueError('invalid attribute bounds')
    rows, partial = [], False
    while pos + 8 <= used:
        kind, length = struct.unpack_from('<II', data, pos)
        if kind == 0xffffffff:
            break
        if length < 24 or length % 8 or pos + length > used:
            raise ValueError('invalid attribute length')
        attr = data[pos:pos + length]
        partial |= kind == 0x20
        if attr[8] == 1 and kind in (0x80, 0xa0, 0xb0):
            if length < 64:
                raise ValueError('short nonresident attribute')
            low, high = struct.unpack_from('<QQ', attr, 16)
            offset = struct.unpack_from('<H', attr, 32)[0]
            if offset < 64 or offset >= length:
                raise ValueError('invalid mapping-pair offset')
            suffix = ''
            if attr[9]:
                name_offset = struct.unpack_from('<H', attr, 10)[0]
                if name_offset + attr[9] * 2 > length:
                    raise ValueError('invalid stream name')
                suffix = ':' + attr[name_offset:name_offset + attr[9] * 2].decode('utf-16-le')
            if kind != 0x80:
                suffix += ':' + hex(kind)
            rows.append({'path': name + suffix, 'bytes': struct.unpack_from('<Q', attr, 48)[0] if low == 0 else 0,
                         'extents': mapping_pairs(attr[offset:], low, high), 'source': 'FSCTL_GET_NTFS_FILE_RECORD'})
        pos += length
    for row in rows:
        row['partialAttributeList'] = partial
    return rows


def inspect(volume):
    if not re.fullmatch(r'\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\?', volume):
        raise ValueError('expected an exact volume GUID path')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                   ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.DeviceIoControl.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
                                      ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                                      ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    handle = kernel.CreateFileW(volume.rstrip('\\'), 0x80000000, 7, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    def control(code, payload, size):
        output = ctypes.create_string_buffer(size)
        source = ctypes.create_string_buffer(payload) if payload else None
        returned = ctypes.c_uint32()
        if not kernel.DeviceIoControl(handle, code, source, len(payload), output, size, ctypes.byref(returned), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return output.raw[:returned.value]
    try:
        info = control(0x90064, b'', 256)
        if len(info) < 104 or struct.unpack_from('<HH', info, 100) not in ((3, 0), (3, 1)):
            raise ValueError('unsupported NTFS version')
        record_size = struct.unpack_from('<I', info, 48)[0]
        if record_size < 512 or record_size > 65536:
            raise ValueError('invalid NTFS record size')
        rows, failures = [], []
        for index, name in ((0, '$MFT'), (1, '$MFTMirr'), (2, '$LogFile'), (6, '$Bitmap'),
                            (7, '$Boot'), (9, '$Secure'), (10, '$UpCase')):
            try:
                result = control(0x90068, struct.pack('<Q', index), record_size + 16)
                actual, size = struct.unpack_from('<QI', result)
                if actual != index or size != record_size or len(result) < 12 + size:
                    raise ValueError('unexpected NTFS file record identity')
                rows.extend(attributes(result[12:12 + size], name))
            except (OSError, ValueError) as exc:
                failures.append({'path': name, 'error': str(exc)})
        return {'files': rows, 'failures': failures, 'readOnly': True,
                'caveat': 'Nonresident attributes in the base records only; continuation attribute lists are explicitly partial.'}
    finally:
        kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--volume', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = inspect(args.volume)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
