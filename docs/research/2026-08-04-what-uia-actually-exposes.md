# 划线到底能不能读到那一行：四类应用的实测结论

> 日期：2026-08-04
> 方法：`scripts/uia_tree_dump.cs` / `.py`（本次新增，**只读**，不改产品代码）对真实窗口 dump 完整 UIA 树
> 状态：**测量结果**，不是推断。每一行都能用文中命令复现。

## 为什么要做这次测量

用户报"微信和 PowerShell 都只知道是哪个窗口、读不到划的那一行"，并判断"UIA 一定是能读到的"。
在此之前，所有关于"UIA 能读到什么"的讨论都是**读我们自己探针的源码**得出的，而探针有控件类型白名单、
节点预算和多条互斥路径——所以"探针没找到"和"应用根本没暴露"从外部看完全一样。

`uia_tree_dump` 不套任何白名单：每个节点、控件类型、Name、Value、矩形，全部打印。

## 结论一览

| 应用 | UIA 树规模 | 能读到划线那一行？ | 正确路径 |
|---|---|---|---|
| 记事本 | 完整 | **能** | Document 元素 |
| Edge / Chromium 网页与卡片 | **完整 DOM 映射成 UIA**，Text/Group/Hyperlink 都带真实矩形，`cls=` 里甚至是 CSS 类名 | **能** | 现有 `TryRegionElements` 的树遍历就够 |
| Windows Terminal / PowerShell | 整个缓冲区只有**一个** `TermControl` Text 元素，`Name` = exe 路径 | **能，但必须走 TextPattern** | `RangeFromPoint` → `ExpandToEnclosingUnit(Line)` → `GetBoundingRectangles` |
| **微信 4.x（`Weixin.exe`，Qt）** | **整棵树 8 个节点**，消息区是一整块 `MMUIRenderSubWindowHW`，**无任何子节点** | **不能** | 只能像素 / OCR |

所以"UIA 一定能读到"这句话，**对浏览器和绝大多数原生应用成立，对微信 4.x 不成立**。

## 证据

### 微信 4.x：整棵树 8 个节点

```
$ ./data/runtime/uia_tree_dump.exe 67370 --max-nodes 2000 --all
root  :  Window        [615,60 1516x1907]   cls=Qt51514QWindowIcon     "微信"
   Pane                 [2116,1952 2x2]      cls=Qt51514QWindowIcon     "Weixin"
   Pane                 [628,60 1490x1894]   cls=MMUIRenderSubWindowHW  "MMUIRenderSubWindowHW"
   TitleBar             [empty]                                        "微信"
     Button ×4          （最小化 / 最大化 / 上下文帮助 / 关闭）
visited=8 printed=8 with_text=8
types : Button=4  Pane=2  TitleBar=1  Window=1
```

窗口最小化时和**恢复到前台后**结果完全一致，排除"树没建起来"。
消息区那块 `MMUIRenderSubWindowHW`（腾讯自研渲染层）尺寸 1490×1894，覆盖整个聊天区域，**子节点为零**。
在消息区中心点做 `TextPattern` 探测：`no element in the tree supports TextPattern at this point`。

佐证：wxauto 开源版 README 标注支持版本是**微信 3.9.X**，不是 4.x。
（`docs/research/2026-08-02-...-wechat-media.md` 当时引用的"支持 4.1"来自其商业文档，与本机 4.x 客户端的 UIA 实测不符。）

### 浏览器：UIA 就是 DOM

```
Document   [8,228 3104x1748]                       "https://www.perplexity.ai/search/..."
  Group    [8,228 480x1748]   cls=group/sidebar …  "主导航"
  Hyperlink[24,244 80x80]     cls=reset interactable…
  Text     [104,365 56x32]                          "新建"
```

矩形是物理屏幕坐标，可直接和笔画求交。**浏览器内的卡片完全可读**，这条路今天没有走通只是因为我们的
适配器在浏览器上先去试 DevTools 端口失败后就没有回落到 UIA 树。

### 终端：文字在，但不在 Name 上

生产探针 region 模式返回：

```json
{"result_kind": "region_elements",
 "text": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
 "region_elements": [{"text": "C:\\...\\powershell.exe",
                      "control_type": "ControlType.Text",
                      "rect": [196, 277, 2346, 1142]}],
 "terminal_anchor_text": ""}
```

同一个元素上做 TextPattern：

```
  found  : Text cls=TermControl [196,277 2346x1142]
  line   : "LINE-BRAVO 第二行 world"
  rect   : [212,330 2280x37]
```

**精确到那一行，还附带该行的矩形。** 探针在 region 模式下走了 `TryRegionElements` 就返回了，
`terminal_anchor_text` 为空说明终端专用路径压根没被调用。这是一个可以精确修掉的分支缺陷，
修完终端不需要 OCR。

## 对"画一圈亮色带证明拿到了"的可行性

**三类情况都拿得到矩形**，所以这个反馈在任何应用上都能做，而且它同时是最好的调试工具：

| 来源 | 矩形从哪来 |
|---|---|
| 浏览器 / 原生应用 | UIA 元素的 `BoundingRectangle` |
| 终端 | `TextPatternRange.GetBoundingRectangles()`（逐行） |
| 微信等不可读应用 | OCR 文字块的 rect（今天已验证：整屏 53 块里精确命中划线那一块） |

关键设计含义：**高亮带的颜色/形态应当区分来源**。结构层命中和 OCR 命中是两种不同的可信度，
用同一种高亮显示会让"我确切知道"和"我认出来了"看起来一样。

## 待办（本文档不含实现）

1. 终端：region 模式命中支持 TextPattern 的元素时，用 `RangeFromPoint` 取行文本与行矩形，而不是取 Name。
2. 浏览器：DevTools 端口不可用时回落到 UIA 树遍历（证据显示树完全可用）。
3. 微信 4.x：接受"结构层无解"，走 OCR，并在界面上**说明**这一条是认出来的而不是读出来的。
4. 高亮带：按来源分色，作为"证明拿到了"的统一反馈。

## 复现命令

```bash
python scripts/uia_tree_dump.py --title-contains "Notepad" --all
./data/runtime/uia_tree_dump.exe <hwnd> --max-nodes 2000 --all
./data/runtime/uia_tree_dump.exe <hwnd> --text-at <x> <y>   # 需目标窗口在前台
```
