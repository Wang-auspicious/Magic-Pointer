# Magic Pointer macOS native host

这个小型原生宿主把 macOS 的鼠标轨迹、按键、滚轮和前台应用以 JSONL 流交给
Electron 侧的同一个 `WiggleDetector`。它不读取屏幕内容；屏幕录制权限只在后续
截图/视觉 grounding 时由宿主明确检查和请求。

构建：

```bash
swiftc -O -framework AppKit -framework ApplicationServices \
  MagicPointerHost.swift -o magic-pointer-host
```

权限检查与申请：

```bash
./magic-pointer-host --check-permissions
./magic-pointer-host --request-permissions
```

运行流：

```bash
./magic-pointer-host
```

每行都是一个 `PointerSample` JSON。Electron 端应像 Windows
`pointer_input_state.ps1` 一样启动它，并把 `buttons`、`foregroundApp`、
`scrollDelta` 与 `NSEvent.mouseLocation` 坐标送入检测器。

状态：接口和源码已经实现，但当前开发机是 Windows，未在 macOS 实机验证。
发布前必须在 Intel 与 Apple Silicon 上分别验证辅助功能授权、屏幕录制授权、
多显示器坐标和应用签名/公证。
