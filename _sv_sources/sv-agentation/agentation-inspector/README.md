# Svelte Agentation

![Svelte Agentation OG](https://sv-agentation.com/og.png)

[![npm version](https://img.shields.io/npm/v/sv-agentation)](https://www.npmjs.com/package/sv-agentation)
[![downloads](https://img.shields.io/npm/dm/sv-agentation)](https://www.npmjs.com/package/sv-agentation)

**Live Preview:** [Svelte Agentation](https://sv-agentation.com)

## Overview

Svelte Agentation turns UI annotations into structured context that AI coding agents can understand and act on.

## Installation

```sh
pnpm i sv-agentation
```

```sh
npm i sv-agentation
```

```sh
bun i sv-agentation
```

```sh
yarn add sv-agentation
```

# Usage

```svelte
<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { Agentation } from 'sv-agentation';
</script>

{#if browser && dev}
	<Agentation />
{/if}
```

Mount the inspector only in development and only in the browser.

## Open in Editor

```svelte
<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { Agentation } from 'sv-agentation';

	// Absolute path to project root
	let workspaceRoot = 'C:/Users/YourName/Projects/YourProject';
</script>

{#if browser && dev}
	<Agentation {workspaceRoot} openSourceOnClick />
{/if}
```

## Annotation Callbacks

```svelte
<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { Agentation } from 'sv-agentation';
	import type { Annotation, AnnotationPayload } from 'sv-agentation';

	function handleAnnotationAdd(annotation: Annotation) {
		console.log('New annotation added:', annotation);
	}

	function handleCopy(markdown: string, payload: AnnotationPayload) {
		console.log('Notes copied:', markdown, payload);
	}
</script>

{#if browser && dev}
	<Agentation onAnnotationAdd={handleAnnotationAdd} onCopy={handleCopy} />
{/if}
```

## Custom Shortcuts

```svelte
<Agentation
	{workspaceRoot}
	keyBindings={{
		inspect: 'Alt+I',
		copy: 'Alt+C',
		reset: 'Alt+R',
		open: 'Alt+O',
		delete: 'Alt+D'
	}}
/>
```

## Shortcuts

| Shortcut                   | Action                  | Description                                                                                    |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `i`                        | Inspect                 | Toggle the inspector toolbar and annotation mode. Configurable through `keyBindings.inspect`.  |
| `c`                        | Copy                    | Copy notes as Markdown when at least one note exists. Configurable through `keyBindings.copy`. |
| `r`                        | Reset                   | Reset the floating toolbar position. Configurable through `keyBindings.reset`.                 |
| `o`                        | Open                    | Open the hovered source location. Configurable through `keyBindings.open`.                     |
| `d`                        | Delete                  | Delete the currently edited note. Configurable through `keyBindings.delete`.                   |
| `esc`                      | Cancel                  | Clear transient selections, close the composer, or dismiss settings/delete state.              |
| `enter`                    | Submit                  | Submit the current note from the composer. Configurable through `keyBindings.submit`.          |
| `shift + ctrl/cmd + click` | Build a group selection | Add or remove elements from a grouped annotation target before releasing the modifiers.        |

## Features

1. Annotate individual elements directly in the page.
2. Annotate selected text ranges.
3. Annotate grouped selections across multiple elements.
4. Use a draggable floating toolbar.
5. Toggle the inspector theme inside the tool UI.
6. Copy notes in `compact`, `standard`, `detailed`, or `forensic` output modes.
7. Include computed-style snapshots for forensic exports.
8. Preview all current-page notes together from the toolbar and jump directly into any saved note.
9. Toggle marker visibility for notes.
10. Block normal page interactions while inspecting.
11. Use a delete-all flow with configurable delay.
12. Hook into annotation lifecycle and copy events with callbacks.
13. Mount the inspector only in dev mode with `browser && dev`.

## Props

| Prop                      | Type                                                                                                                           | Description                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `workspaceRoot`           | `string \| null`                                                                                                               | Absolute project root for source lookup and editor links.                                              |
| `selector`                | `string \| null`                                                                                                               | Optional selector to scope inspectable elements.                                                       |
| `vscodeScheme`            | `'vscode' \| 'vscode-insiders'`                                                                                                | Choose the VS Code URL scheme for open-in-editor actions.                                              |
| `openSourceOnClick`       | `boolean`                                                                                                                      | Open source directly on click instead of only showing metadata.                                        |
| `deleteAllDelayMs`        | `number`                                                                                                                       | Confirmation delay for delete-all notes.                                                               |
| `toolbarPosition`         | `'top-left' \| 'top-center' \| 'top-right' \| 'mid-right' \| 'mid-left' \| 'bottom-left' \| 'bottom-center' \| 'bottom-right'` | When provided, syncs the floating toolbar to this preset and stores it as the latest saved placement.  |
| `outputMode`              | `'compact' \| 'standard' \| 'detailed' \| 'forensic'`                                                                          | When provided, syncs the copy/export mode and stores it for later sessions.                            |
| `pauseAnimations`         | `boolean`                                                                                                                      | When provided, syncs animation pausing while the inspector is active and stores it for later sessions. |
| `clearOnCopy`             | `boolean`                                                                                                                      | When provided, syncs whether copied notes are cleared and stores it for later sessions.                |
| `includeComponentContext` | `boolean`                                                                                                                      | When provided, syncs component-context capture and stores it for later sessions.                       |
| `includeComputedStyles`   | `boolean`                                                                                                                      | When provided, syncs computed-style capture and stores it for later sessions.                          |
| `copyToClipboard`         | `boolean`                                                                                                                      | Disable direct clipboard writes and use callbacks only.                                                |
| `keyBindings`             | `Partial<Record<'inspect' \| 'copy' \| 'reset' \| 'open' \| 'delete' \| 'cancel' \| 'submit', string \| null>>`                | Override or disable keyboard actions without changing persisted toolbar settings.                      |
| `onAnnotationAdd`         | `(annotation) => void`                                                                                                         | Called after a note is created.                                                                        |
| `onAnnotationUpdate`      | `(annotation) => void`                                                                                                         | Called after a note is updated.                                                                        |
| `onAnnotationDelete`      | `(annotation) => void`                                                                                                         | Called after a note is deleted.                                                                        |
| `onAnnotationsClear`      | `(annotations) => void`                                                                                                        | Called after all notes are cleared.                                                                    |
| `onCopy`                  | `(markdown, payload) => void`                                                                                                  | Called after note export is prepared.                                                                  |

## Credits

This project is highly inspired by [Agentation.com](https://www.agentation.com).

## Sponsor

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support-pink?logo=githubsponsors)](https://github.com/sponsors/SikandarJODD)
