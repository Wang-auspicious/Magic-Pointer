# JavaScript to TypeScript Wave 10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the resident voice worker client to strict TypeScript.

**Architecture:** Type constructor configuration, child-process lifecycle, active dictation state, JSONL commands/events, transport failure paths, and public results while preserving CommonJS exports and injected spawn support.

**Tech Stack:** TypeScript 6, Node.js child processes and events, CommonJS.

---

- [x] Run the current voice-worker behavior test against JavaScript.
- [x] Rename and type `voice_worker_client.js`.
- [x] Run focused behavior, strict typecheck, lint, build, and full Node suite.
- [x] Commit the isolated migration and continue.
