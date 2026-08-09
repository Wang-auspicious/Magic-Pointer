# JavaScript to TypeScript Wave 13 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the stage lifecycle/thread state machine to strict TypeScript.

**Architecture:** Type state names, turns, progress, configuration, events, transitions, and word-diff segments inside a classic-script IIFE while preserving no-op reference identity and dual exports.

**Tech Stack:** TypeScript 6, renderer classic scripts, CommonJS.

---

- [x] Run state and browser-global characterization tests.
- [x] Rename implementation and direct test to `.ts`.
- [x] Type state transitions and word diff without changing behavior.
- [x] Run complete verification, commit, and continue.
