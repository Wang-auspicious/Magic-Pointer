# JavaScript to TypeScript Wave 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate stage anchor geometry and turn-stream composition policies with their direct tests.

**Architecture:** Keep both policies as IIFE-scoped classic scripts with CommonJS and renderer globals. Model anchor candidates, rectangles, stream entry unions, chips, readiness results, and unknown runtime boundaries explicitly.

**Tech Stack:** TypeScript 6, tsx, Electron renderer classic scripts, CommonJS.

---

- [x] Add turn-stream JavaScript to the browser namespace test and verify current globals.
- [x] Rename both direct tests to `.ts` and run against JavaScript implementations.
- [x] Migrate `stage_anchor.js`, update its namespace fixture, and pass focused checks.
- [x] Migrate `stage_turn_stream.js`, update its namespace fixture, and pass focused checks.
- [x] Run strict typecheck, lint, build, and full Node tests.
- [x] Commit only wave-eight files, preserving unrelated worktree changes.
