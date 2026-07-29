# Magic Pointer Windows icon

`magic-pointer-icon.svg` is the editable, original vector source: a single
pointer and blue-to-purple motion trail on a transparent canvas. It uses no
external or licensed artwork.

Regenerate the committed Windows icon with:

```powershell
python assets/app/generate_icon.py
```

`icon.ico` contains 16, 24, 32, 48, 64, 128, and 256 pixel Windows-compatible
BMP-backed frames. It is used by the app executable, NSIS installer, and NSIS
uninstaller.
