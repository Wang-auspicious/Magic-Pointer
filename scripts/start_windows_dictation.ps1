$signature = @'
using System;
using System.Runtime.InteropServices;

public static class MagicPointerVoiceTyping
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
'@

Add-Type -TypeDefinition $signature -ErrorAction Stop

$keyUp = 0x0002
$leftWindowsKey = 0x5B
$hKey = 0x48
[MagicPointerVoiceTyping]::keybd_event($leftWindowsKey, 0, 0, [UIntPtr]::Zero)
[MagicPointerVoiceTyping]::keybd_event($hKey, 0, 0, [UIntPtr]::Zero)
[MagicPointerVoiceTyping]::keybd_event($hKey, 0, $keyUp, [UIntPtr]::Zero)
[MagicPointerVoiceTyping]::keybd_event($leftWindowsKey, 0, $keyUp, [UIntPtr]::Zero)
