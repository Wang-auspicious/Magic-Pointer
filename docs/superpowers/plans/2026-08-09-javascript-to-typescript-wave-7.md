# JavaScript to TypeScript Wave 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Electron main-process security hardening module and its static wiring contract to TypeScript.

**Architecture:** Use Electron and Node type-only interfaces for web contents, shell, app, dialog, filesystem, path, and process boundaries. Keep runtime dependency validation, fatal recovery semantics, CommonJS exports, and main-process extensionless loading unchanged.

**Tech Stack:** TypeScript 6, Electron 43 types, Node.js types, CommonJS.

---

- [x] Run the existing security behavior test against JavaScript as a baseline.
- [x] Rename `security_hardening.js` to `.ts` and type all dependency boundaries and fatal handlers.
- [x] Rename the wiring test to `.ts` and point its static source read at the TypeScript file.
- [x] Run focused tests and strict typecheck.
- [x] Run batch lint, build, and full Node tests; commit without staging `docs/STATUS.md`.
