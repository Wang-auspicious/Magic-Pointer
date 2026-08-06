# 生图提示词

> 给图像模型用。每条都可以单独复制粘贴，不依赖上下文。
> 风格依据：[DESIGN.md 视觉语言](../DESIGN.md#视觉语言oreo-暖)、[design/GUI.md](GUI.md)。
> 拿到图后放 `assets/`，命名照每条末尾的「落点」。

---

## 0. 所有图共用

**只有一种风格：Oreo 暖。**不再有冷蓝／石墨那两套。

| | 定死的值 |
|---|---|
| **底色** | 暖灰白 `#F2F1ED`。**不是纯白，更不是黑** |
| **墨色** | 暖近黑 `#17170F`。全局不出现纯黑和中性灰 |
| **彩色** | 只以浅底深字的小面积出现：靛 `#5B5BD6`（结构层）、琥珀 `#B4690E`（像素来源）、青 `#0E7C86`（代码）、绿 `#3D8B5F`（成功）、赭红 `#B44A24`（危险） |
| **形** | 全圆角。图标 1.5px 细描边、末端圆头、单色 |
| **禁止** | 拟物阴影、塑料高光、3D 渲染、库存插画风、紫粉赛博朋克、深色背景、霓虹、任何文字 |

**不用生图的两项**：头像和能量球用 [`@oreo-design/avatar`](https://github.com/BIAsia/oreo-design-avatar)（`npm i @oreo-design/avatar`，MIT、零依赖、纯 SVG、按 `variantId` 确定性生成）。别再让模型画球。

---

## 1. 图标集 · 4×4 十六个（最先要）

**为什么是这 16 个**：工作室侧栏 + 舞台动作 + 卡片里用到的全部符号。风格照 Oreo 那套 1700+ 图标——细描边、几何、单色。**不要渐变图标**，Google Workspace 那次改版评论区骂得最多的就是"渐变让图标分不清"。

```
A 4x4 grid of 16 minimalist UI icons on a single flat canvas, evenly spaced with
generous padding, each icon centered in its own invisible square cell.

Style: thin monochrome line icons, 1.5px uniform stroke weight, rounded stroke
caps and rounded joins, geometric and highly simplified, drawn on a 24x24 pixel
grid, optically balanced. Warm near-black strokes (#17170F) on a warm off-white
background (#F2F1ED). No fills, no gradients, no shadows, no color, no text, no
labels. Consistent visual weight across all 16 — none should read heavier or
lighter than its neighbours.

Row 1: a computer mouse cursor arrow with two small motion arcs beside it
       suggesting a quick shake; a hand-drawn wavy underline stroke crossing a
       short text line; a crosshair reticle snapping onto a rounded rectangle;
       a vertical timeline with three dots and connecting line.
Row 2: a crescent-moon-in-circle suggesting stored memory; two stacked
       overlapping rounded rectangles as a clipboard history; a stack of layered
       documents; a four-pointed sparkle star with slightly concave curved edges.
Row 3: a pen nib writing on a line; a square with one tab extending as a plug-in
       symbol; a rounded rectangle chip with radiating connection lines; an eye
       with a soft radiating arc above it.
Row 4: a shield with a keyhole; a pulse waveform inside a rounded square; an
       arrow entering a text input box from above; a paper-plane handing off to a
       small circle.

Flat 2D vector look, crisp edges, no perspective, no 3D. Icons only.
```

**负向**：`gradient, color, 3D, bevel, drop shadow, glossy, text, labels, watermark, photo, skeuomorphic, thick strokes, inconsistent stroke width, dark background, black background`

**落点**：`assets/icons/sheet-16.png` → 切成单个 SVG 进 `electron/renderer/`

> 若 16 个粗细不齐，拆成 4 张 2×2 分别生成，一致性会好很多。

---

## 2. 产品主图（最重要的一张）

**它必须一眼说清产品**：不是聊天框，是**你在别人的软件里划了一笔，一张小白卡就地浮出来**。所以主体不能是我们的界面，得是"别人的界面 + 我们的一张卡"。

**为什么是暖的**：这是产品的第一印象，必须和真实界面同调。之前那版冷蓝近黑的作废。

```
A cinematic product hero image, 16:9, bright warm editorial mood, shot like
high-end Apple product photography.

Scene: a laptop screen seen slightly off-axis, filling most of the frame,
showing an ordinary working document with small unreadable body text (softly
blurred, no legible words). Across one single line of that text, a hand-drawn
underline stroke has been made — a soft indigo (#5B5BD6) band with a sharp,
confident leading edge on the right where the cursor just passed and a gently
diffusing tail to the left, suggesting direction and momentum.

Floating just below and right of that underlined line: one small pure-white
card with generous rounded corners (18px), separated from the screen by a very
soft warm shadow only — no border, no glow. The card is simple: a small
rounded-square thumbnail at its left, two short abstract text bars, and one tiny
pale-indigo pill shape. Everything on the card is abstract, no readable letters.

Background: the rest of the screen and the surrounding desk are warm off-white
(#F2F1ED), softly out of focus, lit by natural window light from the left with
long soft falloff. Fine natural grain. Shallow depth of field — everything soft
except the underline's leading edge and the card, which are tack sharp.

Photographic, calm, spacious, expensive. No text anywhere, no UI labels, no
logos, no hands, no people, no dark mode.
```

**负向**：`readable text, letters, words, logo, watermark, hands, people, chat bubble, chat interface, dark background, black, neon, purple cyberpunk, glow, cluttered UI, flat vector, screenshot look`

**落点**：`assets/hero/product-hero.png` → README 顶部、官网首屏、Release 配图

---

## 3. 应用图标（打包必须有，现在缺）

**约束**：Windows 任务栏 24px 也要认得出。所以只能有**一个**形状。

```
A single app icon, centered, on a transparent background.

Shape: a soft-cornered squircle tile in warm off-white (#FAF9F6), with a very
subtle warm inner shadow along its top edge suggesting thin paper depth.

On it, one symbol only: a pointer/cursor arrow in warm near-black (#17170F),
geometric and simplified, with a single short soft indigo (#5B5BD6) underline
stroke sweeping out from behind its tail — as if the cursor just drew a line.
The indigo stroke tapers and fades toward its far end.

Extremely simple, instantly readable at 24 pixels. No text, no letters, no
background scene, no border, no gradient mesh clutter. Centered with generous
padding inside the tile.
```

**负向**：`text, letters, multiple symbols, busy detail, realistic mouse device, drop shadow outside tile, photo, dark background, glow, neon`

**落点**：`assets/icon/app-1024.png` → `packaging/` 出 ico/icns

---

## 4. 空态插画三张（侧栏各处空着的时候）

**为什么要**：时间线／记忆／收藏箱刚装完全是空的，那是用户对产品的第一印象。规范里明写"必须设计空态"，现在我们一张都没有。

```
Three minimalist illustrations in a 1x3 horizontal strip, on a warm off-white
background (#F2F1ED). Evenly spaced, each centered in its own third.

Drawn as fine hand-inked line work — thin, slightly irregular strokes with the
character of a real pen, not vector-perfect. Ink is warm charcoal (#17170F);
exactly one element in each drawing is picked out in a muted terracotta red
(#B44A24). Subtle, quiet, editorial. Generous negative space.

1. An empty horizontal ruled line running left to right with three small hollow
   circles on it, unfilled — a timeline with nothing recorded yet. The leftmost
   circle is terracotta.
2. A loose scatter of small pen marks and dots drifting apart, not yet gathered
   into any shape — memory with nothing in it yet. One mark is terracotta.
3. Two thin overlapping rectangles outlined in ink, both empty, the top one
   slightly rotated as if a slip of paper laid on another — a stash with nothing
   saved yet. The top outline is terracotta.

Extremely restrained, poetic and quiet rather than cute. No text, no icons, no
mascots, no arrows, no filled shapes, no UI chrome, no color other than the
charcoal ink and the single terracotta accent.
```

**负向**：`mascot, character, cartoon, cute, text, arrows, filled shapes, busy, clipart, 3D, dark background, blue, neon, glow`

**落点**：`assets/empty/states-1x3.png`

---

## 5. Hero 背景（首屏用，可选）

**先看能不能不生**：首选方案是取用户自己的桌面壁纸做模糊背景（零版权、且"这是你的电脑"正好是产品隐喻）。次选是从 [Pexels Videos](https://www.pexels.com/videos/) / [Coverr](https://coverr.co/) 拉免费商用循环视频——Oreo 那张就是动图，静态图撑不出同样的感觉。

**这条只在上面两条都走不通时用**，且只作为视频的静帧兜底：

```
A cinematic atmospheric photograph, 16:9, shot on medium format, natural light.
Warm and slightly desaturated — soft cream, dusty sage, pale sand. One soft
luminous focal area. Shallow depth of field, fine natural grain. Contemplative
and spacious — lots of empty space in the upper two thirds so that large serif
text can sit over it comfortably.

Subject: [四选一]
  A — soft cumulus clouds lit from behind in late afternoon, one bird far away
  B — sheer white curtains moving in front of a bright window, warm interior
  C — tall dry grass in low golden light, out of focus behind
  D — light falling through a window onto an empty wooden desk, dust in the beam

No people's faces, no text, no logos, no watermark, no HDR look, no
oversaturation, no cold blue cast, no night scenes.
```

**负向**：`people faces, text, logo, watermark, oversaturated, HDR, stock photo look, vignette, tilt-shift, cold blue, dark, night, neon`

**落点**：`assets/mood/hero-{a,b,c,d}.jpg`

---

## 拿到图之后我做什么

1. 图标集切成 16 个 SVG，替掉 `dashboard.html` 里现在那套 `<use href="#icon-*">`。
2. 主图进 README 和 `docs/design/`。
3. 应用图标进 `packaging/`，补上现在缺的 ico/icns。
4. 空态接进侧栏三个空列表。
5. 背景（如果生了）进工作室首屏，作为视频加载前的静帧。

**生图模型建议**：图标集用能锁风格一致性的（Nano Banana / Seedream 这类对"同一张图里多个元素保持一致"更稳）；主图和背景用摄影感强的。
