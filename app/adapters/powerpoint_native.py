"""Resolve PowerPoint's native document window from the captured HWND.

PowerPoint DocumentWindow does not expose HWND. OBJID_NATIVEOM on its
mdiClass child provides the document window without activating another deck.
"""

POWERPOINT_NATIVE_WINDOW_SCRIPT = r'''
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MpPowerPointWindow {
  private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr root, EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("oleacc.dll")]
  private static extern int AccessibleObjectFromWindow(
    IntPtr hwnd, uint id, ref Guid iid,
    [MarshalAs(UnmanagedType.IDispatch)] out object result);
  private static object ReadDocument(IntPtr hwnd) {
    var name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    if (name.ToString() != "mdiClass") return null;
    var iid = new Guid("00020400-0000-0000-C000-000000000046");
    object result;
    return AccessibleObjectFromWindow(hwnd, 0xFFFFFFF0, ref iid, out result) == 0
      ? result : null;
  }
  public static object FromHandle(long hwnd) {
    var root = new IntPtr(hwnd);
    object result = ReadDocument(root);
    if (result != null) return result;
    EnumProc callback = (child, data) => {
      result = ReadDocument(child);
      return result == null;
    };
    EnumChildWindows(root, callback, IntPtr.Zero);
    return result;
  }
}
"@
'''
