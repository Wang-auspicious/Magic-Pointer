# JavaScript to TypeScript Wave 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the wiggle gesture detector to strict TypeScript.

**Architecture:** Model settings, samples, motion segments, metrics, calibration state, and detector outcomes while preserving the stateful CommonJS class and numeric thresholds.

**Tech Stack:** TypeScript 6, Node.js CommonJS.

---

- [x] Run the existing wiggle detector behavior test against JavaScript.
- [x] Rename and type `electron/wiggle_detector.js` without changing gesture thresholds.
- [x] Run focused test, typecheck, lint, build, and full Node suite.
- [x] Commit the isolated migration and continue.
