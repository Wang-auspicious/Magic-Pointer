param([int]$StartX, [int]$EndX, [int]$Y)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PointerWitness {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct CursorInfo { public int size,flags; public IntPtr cursor; public Point point; }
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CursorInfo info);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  public static string Run(int start,int end,int y) {
    Point original; GetCursorPos(out original);
    int hidden=0, changes=0; long previous=-1;
    try {
      for(int i=0;i<160;i++) {
        SetCursorPos(start+(end-start)*i/159,y);
        Thread.Sleep(8);
        var info=new CursorInfo(); info.size=Marshal.SizeOf(typeof(CursorInfo));
        if(!GetCursorInfo(ref info)) throw new Exception("GetCursorInfo failed");
        if((info.flags&1)==0) hidden++;
        long handle=info.cursor.ToInt64(); if(previous!=-1 && previous!=handle) changes++; previous=handle;
      }
    } finally { SetCursorPos(original.x,original.y); }
    return "{\"samples\":160,\"hidden\":"+hidden+",\"shapeChanges\":"+changes+"}";
  }
}
'@
[PointerWitness]::Run($StartX,$EndX,$Y)
