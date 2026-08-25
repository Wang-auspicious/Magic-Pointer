# sv-agentation

Svelte Agentation turns UI annotations into structured context that AI coding agents can understand and act on.
It is a dev-only Svelte inspector for source-aware inspection, page-scoped notes, and structured copy output.

## Installation

### npm

```bash
npm install sv-agentation
```

### pnpm

```bash
pnpm add sv-agentation
```

### bun

```bash
bun add sv-agentation
```

### yarn

```bash
yarn add sv-agentation
```

## Usage

Mount the inspector only in development and only in the browser.
Route-based note sessions are automatic by default.

```svelte
<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { Agentation } from 'sv-agentation';

	const workspaceRoot = '/absolute/path/to/your/repo';
</script>

{#if browser && dev}
	<Agentation {workspaceRoot} />
{/if}
```

## Core Features

- Inspect source-aware DOM elements and jump to files quickly.
- Annotate elements, text ranges, grouped targets, and selected page areas.
- Keep notes isolated per page automatically as routes change.
- Copy notes in `compact`, `standard`, `detailed`, or `forensic` modes.
- Use a compact floating toolbar with output cycling and denser settings.
- Capture selector paths, bounds, nearby text, component context, and forensic computed styles.
- Hook into local annotation lifecycle and copy callbacks.
- Mount it only in development with `browser && dev`.

## Public Props

### Core

- `workspaceRoot?: string | null`
  Absolute project root for source lookup and editor links.
- `selector?: string | null`
  Optional selector to scope inspectable elements.
- `vscodeScheme?: 'vscode' | 'vscode-insiders'`
  Choose the VS Code URL scheme for open-in-editor actions.
- `openSourceOnClick?: boolean`
  Open source directly on click instead of only showing metadata.
- `deleteAllDelayMs?: number`
  Confirmation delay for delete-all notes.
- `toolbarPosition?: 'top-left' | 'top-center' | 'top-right' | 'mid-right' | 'mid-left' | 'bottom-left' | 'bottom-center' | 'bottom-right'`
  When provided, keeps the floating toolbar anchored to this preset and overrides saved toolbar placements.
- `pageSessionKey?: string | null`
  Optional advanced override for note session scoping. Most apps do not need this.
- `keyBindings?: Partial<Record<'inspect' | 'copy' | 'reset' | 'open' | 'delete' | 'cancel' | 'submit', string | null>>`
  Override or disable keyboard actions without changing saved toolbar settings.

### Behavior

- `outputMode?: 'compact' | 'standard' | 'detailed' | 'forensic'`
  When provided, controls the copy mode and overrides saved toolbar settings.
- `pauseAnimations?: boolean`
  When provided, controls animation pausing and overrides saved toolbar settings.
- `clearOnCopy?: boolean`
  When provided, controls note clearing after copy and overrides saved toolbar settings.
- `includeComponentContext?: boolean`
  When provided, controls component-context capture and overrides saved toolbar settings.
- `includeComputedStyles?: boolean`
  When provided, controls computed-style capture and overrides saved toolbar settings.
- `copyToClipboard?: boolean`
  Lets you intercept copy output without writing to the clipboard.

### Callbacks

- `onAnnotationAdd?: (annotation: Annotation) => void`
  Fires when a new annotation is saved.
- `onAnnotationUpdate?: (annotation: Annotation) => void`
  Fires when an existing annotation is edited.
- `onAnnotationDelete?: (annotation: Annotation) => void`
  Fires when one annotation is removed.
- `onAnnotationsClear?: (annotations: Annotation[]) => void`
  Fires after the current page notes are cleared.
- `onCopy?: (markdown: string, payload: AnnotationPayload) => void`
  Receives the generated markdown and structured export payload.

## Exported Types

- `AnnotationProps`
- `OutputMode`
- `Annotation`
- `AnnotationPayload`
- `ComputedStyleSnapshot`
- `ComponentContextMode`

## Example: Typed Callbacks

```svelte
<script lang="ts">
	import { Agentation, type Annotation, type AnnotationPayload } from 'sv-agentation';

	const workspaceRoot = '/absolute/path/to/your/repo';

	const handleAnnotationAdd = (annotation: Annotation) => {
		console.log(annotation.targetLabel);
	};

	const handleCopy = (markdown: string, payload: AnnotationPayload) => {
		console.log(markdown);
		console.log(payload.annotations.length);
	};
</script>

<Agentation
	{workspaceRoot}
	outputMode="detailed"
	keyBindings={{
		inspect: 'Alt+I',
		copy: 'Alt+C',
		reset: 'Alt+R',
		open: 'Alt+O',
		delete: 'Alt+D'
	}}
	copyToClipboard={false}
	onAnnotationAdd={handleAnnotationAdd}
	onCopy={handleCopy}
/>
```

## Shortcuts

- `i` toggles inspect mode by default and maps to `keyBindings.inspect`.
- `c` copies notes for the current page and maps to `keyBindings.copy`.
- `r` resets toolbar position and maps to `keyBindings.reset`.
- `o` opens the current source target and maps to `keyBindings.open`.
- `d` deletes the currently edited note and maps to `keyBindings.delete`.
- `esc` cancels the current action and maps to `keyBindings.cancel`.
- `enter` submits the current note and maps to `keyBindings.submit`.
- `shift + ctrl/cmd + click` builds a grouped selection.
