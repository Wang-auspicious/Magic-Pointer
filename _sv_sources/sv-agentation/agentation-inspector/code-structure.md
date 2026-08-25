# sv-agentation Code Structure

Short map of the package for contributors.

## High-Level Flow

```text
Agentation
  -> element-source-inspector.svelte
  -> CopyOpenController
      -> internal/controller-state.svelte.ts
      -> internal/controller-selection.ts
      -> internal/controller-composer.ts
      -> internal/controller-browser.ts
  -> components/*
  -> utils/*
```

## Runtime Flow

```text
inspect / select
  -> build composer state
  -> save note
  -> persist to localStorage
  -> render markers + previews
```

## Folder Map

```text
src/lib/
  components/   visible inspector UI
  internal/     controller-only helpers
  utils/        pure transforms, storage, geometry, source helpers
  types.ts      public package types
  index.ts      public exports
```

## Main Files

- `element-source-inspector.svelte`: thin public mount shell
- `copy-open.svelte.ts`: main runtime coordinator
- `internal/controller-state.svelte.ts`: shared controller state shapes
- `internal/controller-selection.ts`: drag, text, group selection flow
- `internal/controller-composer.ts`: note/composer creation and layout refresh
- `internal/controller-browser.ts`: browser-only side effects
- `utils/note-*.ts`: note storage, formatting, layout, rendering

## Read Order

```text
1. index.ts
2. element-source-inspector.svelte
3. copy-open.svelte.ts
4. internal/*
5. components/*
6. utils/*
```
