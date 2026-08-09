# JavaScript to TypeScript Wave 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate coordinate-space normalization and its Node tests to strict TypeScript.

**Architecture:** Type points, rectangles, gestures, screen conversion APIs, geometry inputs, and immutable results while retaining fail-closed validation and CommonJS loading.

**Tech Stack:** TypeScript 6, Electron-compatible screen geometry, CommonJS.

---

- [x] Run coordinate unit and integration tests against JavaScript.
- [x] Rename both tests to `.ts` and type screen fixtures.
- [x] Rename and type `coordinate_space.js`.
- [x] Run focused and complete verification, then commit and continue.
