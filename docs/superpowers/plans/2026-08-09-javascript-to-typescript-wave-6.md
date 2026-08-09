# JavaScript to TypeScript Wave 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the answer-shape and capture-proof renderer policies plus their direct tests to strict TypeScript.

**Architecture:** Preserve both CommonJS and classic-script globals through file-local IIFEs. Type policy results and geometry explicitly while keeping runtime parsing and renderer `.js` URLs unchanged because Electron consumes compiled output.

**Tech Stack:** TypeScript 6, tsx, CommonJS, Electron renderer classic scripts.

---

- [x] Add both current JavaScript policies to the browser namespace characterization test and verify it passes.
- [x] Rename the answer-shape, capture-proof, and capture-proof wiring tests to `.ts`; run them against JavaScript sources.
- [x] Migrate `answer_shape_policy.js` with typed inputs, shape results, proposal extraction, and dual exports.
- [x] Migrate `capture_proof_policy.js` with typed rectangles, sources, bands, coordinate mapping, and dual exports.
- [x] Switch namespace fixtures to TypeScript source and make migrated tests strict-clean.
- [x] Run focused tests, typecheck, lint, build, and the full Node suite.
- [x] Commit only wave-six files; keep `docs/STATUS.md` unstaged.
