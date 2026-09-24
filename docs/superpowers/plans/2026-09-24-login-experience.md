# Login Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished, responsive, single-screen login experience as the first deployable node of the Keling workspace.

**Architecture:** A dependency-free static Sites project keeps presentation in HTML/CSS and behavior in one ES module. Pure validation functions are exported for Node tests while browser-only setup is guarded by `document` availability.

**Tech Stack:** HTML5, CSS, browser ES modules, Node.js built-in test runner, OpenAI Sites static hosting.

---

### Task 1: Define login behavior with tests

**Files:**
- Create: `tests/login.test.mjs`
- Create: `dist/app.js`

- [ ] Write tests for empty, short, and valid credentials plus password visibility labels.
- [ ] Run `node --test tests/login.test.mjs` and confirm the module is missing.
- [ ] Implement the smallest validation and label helpers in `dist/app.js`.
- [ ] Re-run the test and confirm all cases pass.

### Task 2: Build the single-screen experience

**Files:**
- Create: `dist/index.html`
- Create: `dist/styles.css`
- Modify: `dist/app.js`

- [ ] Add the semantic login form, field errors, password toggle, submit feedback, and model marquee markup.
- [ ] Add the black editorial canvas, floating handset, restrained green terrain, responsive layout, and reduced-motion behavior.
- [ ] Wire form validation, focus management, password visibility, and success placeholder.

### Task 3: Verify, publish, and establish the baseline

**Files:**
- Create: `.openai/hosting.json`

- [ ] Run the Node tests and static reference checks.
- [ ] Capture one desktop and one narrow-screen visual inspection in the same browser session.
- [ ] Publish privately with Sites and confirm the deployment URL.
- [ ] Commit the verified source as the repository's first baseline commit.

