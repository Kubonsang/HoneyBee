# New-VHD rejects an .avhdx parent by extension. The documented V2 native API
# accepts an explicit VHDX parent type; no rename, copy, or parent mutation.
# https://learn.microsoft.com/windows/win32/api/virtdisk/ns-virtdisk-create_virtual_disk_parameters
function New-CheckpointChild([string]$Destination,[string]$Parent) {
    if(Test-Path -LiteralPath $Destination){throw 'Child already exists'}
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HoneyBeeCheckpointChild {
    [StructLayout(LayoutKind.Sequential)]
    public struct Storage { public uint Device; public Guid Vendor; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Parameters {
        public uint Version, Pad;
        public Guid Unique;
        public ulong Maximum;
        public uint Block, Sector, PhysicalSector, Pad2;
        public IntPtr Parent, Source;
        public uint Flags;
        public Storage ParentType, SourceType;
        public Guid Resiliency;
        public uint Pad3;
    }
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode)]
    static extern uint CreateVirtualDisk(ref Storage storage, string path, uint access,
        IntPtr security, uint flags, uint providerFlags, ref Parameters parameters,
        IntPtr overlapped, out IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static void Create(string destination, string parent) {
        if(IntPtr.Size != 8 || Marshal.SizeOf(typeof(Parameters)) != 128)
            throw new Exception("Unexpected native layout");
        var storage = new Storage {Device=3, Vendor=new Guid("ec984aec-a0f9-47e9-901f-71415a66345b")};
        var parameters = new Parameters {Version=2, ParentType=storage, Parent=Marshal.StringToHGlobalUni(parent)};
        IntPtr handle=IntPtr.Zero;
        try {
            uint code=CreateVirtualDisk(ref storage,destination,0,IntPtr.Zero,0,0,ref parameters,IntPtr.Zero,out handle);
            if(code!=0) throw new Win32Exception((int)code);
        } finally {
            if(handle!=IntPtr.Zero) CloseHandle(handle);
            Marshal.FreeHGlobal(parameters.Parent);
        }
    }
}
'@
    [HoneyBeeCheckpointChild]::Create($Destination,$Parent)
}
