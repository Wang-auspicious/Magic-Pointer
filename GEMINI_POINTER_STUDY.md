# Gemini / DeepMind AI Pointer Study

Date: 2026-07-06

Scope: 20 saved demo files in this folder plus the local DeepMind article HTML. Static images were reviewed individually. The four webm videos were sampled into time-sequence contact sheets and metadata; this is not yet a pixel-perfect manual annotation of every original frame.

## 0. Main conclusion

The important lesson is not to build a smaller AI chat window. The AI pointer is an interaction layer attached to the user's current screen object.

Target product language:

```text
transparent pointer overlay + default listening + object glow + short action chips + source-to-destination path + small local result card
```

The control panel should become settings/status/debug only. It should not be the main AI surface.

## 1. DeepMind principles and what they imply

### 1. Maintain the flow
AI must meet the user inside the current app: PDF, browser, document, image, video, map, shopping list. Do not force the user to move the task into an AI window.

Implementation implication: after selection, do not center a big result/chat box. Render local UI near the selected object.

### 2. Show and tell
The user points at an object, then says a short command. The pointer supplies the missing context.

Examples:
- make this orange
- compare these
- add this there
- use that style on this

Implementation implication: default entry should be voice/listening. Text input is a fallback, not the main path.

### 3. This / That / These / There
The real primitive is deictic reference. THIS is the current hover/selection. THAT is the previous or contrasted object. THESE/THOSE is the current short-lived group. THERE is a destination object or location.

Implementation implication: do not require users to manually maintain groups. Infer groups from recent continuous selections and expire them by task/session idle time.

### 4. Turn pixels into actionable entities
The demos treat screen pixels as entities: text blocks, notes, ingredients, places, images, video-frame objects, calendar events, products, maps.

Implementation implication: the object store should not be just screenshot history. Each object needs id, bbox, type, content, source, timestamp, relations, and capabilities.

## 2. Per-demo notes

| File | What it demonstrates | What Magic Pointer should learn |
|---|---|---|
| 演示1.png | Selected a band/concert image; Gemini shows an object-adjacent card: Select anything to ask Gemini, plus chips such as Visualize Together, Compare items, Synthesize. | Do not open a chat box. Show capability chips next to the selected object. |
| 演示2.png | Multiple images are used together with a short command: Combine these images to create a band poster. The UI enters a generating state near the objects. | These should be inferred from current continuous selections, not manually managed history. |
| 演示3.png | A document/slide object shows a Merge these chip. | Document objects need object-specific actions: merge, format, summarize, rewrite. |
| 演示4.png | Recipe and shopping list are visible together; Add this appears. | This is a source-to-destination workflow: add current ingredients to the visible list. |
| 演示5.png | Shopping list operation: Double that. | For structured text/list objects, actions should modify quantities or items directly. |
| 演示6.jpg/png | Summary chips: Move this, Merge those, Add that. | The interaction grammar is verb + deictic pronoun. No long prompt required. |
| 演示7.webm | Recipe-to-shopping-list video workflow. | Short-lived task context is enough; avoid permanent thumbnail history in the main UI. |
| 演示8.webm | Image-internal objects such as penguin/crab/sign can be addressed and edited. | Selection rectangle is only MVP; later we need semantic object candidates or masks. |
| 演示9.webm | Local text/document editing with short Make this... bubbles. | AI should behave like an inline local editor, not a remote chatbot. |
| 演示10.webm | Video frame entity becomes actionable: Book it, Processing, place/time card. | Results should become action cards: book, route, add, paste, create. |
| 演示11.png | Ingredients/list text is detected as an entity. | OCR blocks should become structured entities with items, quantities, units. |
| 演示12.png | Debug-like object identifiers appear, e.g. text_notes_841 and HOVERING state. | There is clearly an object registry and hover-current-object state machine. |
| 演示13.png | Text/image replacement action, e.g. replace object with emoji. | Objects need capabilities such as replace, style, summarize, add-to, route-to. |
| 演示14.png | Shopping list transformed into a more visual/result form. | The result should be written back or attached locally, not only answered in chat. |
| 演示15.png | Text note/list is represented as a selectable object. | Every object needs id, bbox, type, content, capabilities, source, timestamp. |
| 演示16.png | Another text object with stable id, e.g. text_notes_529. | Hover should continuously update THIS. |
| 演示17.png | Calendar event is filled from content: title, date, time, location. | Extraction-to-action is a first-class workflow. |
| 演示18.png | Natural command: make this orange. | Short voice command + current object should be enough. |
| 演示19.png | Two place cards and map directions. | Two place entities imply route/compare/travel actions. |
| 演示20.png | Text menu/style and parrot image combined: use that style on this. | Cross-object relationships matter: style source + target object. |

## 3. Video motion / pointer design observations

The smoothness is mostly from continuity, not from a complex window. The visual state moves through hover -> select -> listen -> think -> chips -> action -> done, without changing context.

### 3.1 Pointer states

```text
Idle: normal background state
Listening: soft breathing halo near the pointer
HoverTarget: current object gets a subtle glow; THIS updates
Selecting: translucent rounded selection, not a harsh rectangle
Thinking: small shimmer/spinner near the object
ActionReady: 2-4 short chips appear near object edge
Executing: source-to-destination arc/trail if an object is moved/added
Done: local result card appears briefly, then collapses
```

### 3.2 Mouse visual form

- 12-24 px translucent halo around pointer/selection.
- Breathing alpha animation while listening.
- Soft edge glow on selected/hovered object.
- Tiny sparkle/shimmer only during thinking, not always.
- Chips slide/fade from the object edge; they should not cover the content.

### 3.3 Path / flow

For add/move/use-style workflows, the UI should show a short source-to-destination path: a curved line or moving dot from THIS to THERE/THAT. This is why the demos feel like direct manipulation, not chat.

Low-cost implementation: Tk transparent overlay canvas, quadratic Bezier path, 30-60 FPS alpha/motion update.

## 4. Current project implications

### 4.1 Control panel
The current panel is too central. It should be reduced to status/settings/debug/exit. It should not be the user-facing AI experience.

### 4.2 Voice
The default interaction should be: launch in background -> hotkey/gesture -> listening -> user speaks one short command -> local action. Text is fallback only.

### 4.3 History thumbnails and groups
Do not show all historical thumbnails by default. Yesterday's task should not pollute today's THIS/THAT/GROUP.

Recommended rule: short-lived task context; idle timeout around 30 minutes; previous sessions accessible only from debug/history, not automatically active.

### 4.4 Object capabilities

```text
image/object: explain, edit, move, use style
text: summarize, rewrite, translate, format, add to
list: add, double, format, sort
place: route, compare, book
two objects: compare, merge, route
source + destination: add this there, move this there
```

## 5. Next work direction

1. Build the transparent pointer overlay first: halo, glow, chips, tiny result card.
2. Make voice/listening the default activation state.
3. Keep the command bar only as fallback.
4. Replace manual group management with automatic task-scoped groups.
5. Add source-to-destination path animation for add/move/use-style workflows.
6. Then add write-back/execution: clipboard paste first, UI Automation/browser DOM later.

## 6. Generated research artifacts

- Image contact sheet: `data/runtime/demo_images_contact_sheet.jpg`
- Video frame sheets: `data/runtime/demo_video_frames/`
- Video metadata: `data/runtime/video_metadata.json`
- Per-demo AI analysis: `data/runtime/per_demo_ai_analysis/`
- Extracted DeepMind text: `data/runtime/deepmind_ai_pointer_page_text.txt`

## 7. Bottom line

If Magic Pointer keeps growing into a panel with a text box and AI replies, it becomes another web AI shell. To match Gemini / DeepMind, the product must feel like AI attached to the pointer: point, speak, local object glows, short chips appear, action happens in place.
