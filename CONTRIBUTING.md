# Contributing to SachCheck

First off, thank you for taking the time to contribute! Contributions make the open-source community an amazing place to learn, inspire, and create. Any contribution you make to **SachCheck** is greatly appreciated.

By participating in this project, you agree to abide by our standards of professional and respectful communication.

---

## 📖 Table of Contents

- [How Can I Contribute?](#how-can-i-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Pull Requests](#pull-requests)
- [Development Setup](#development-setup)
- [Style Guide & Rules](#style-guide--rules)
- [Community & Communication](#community--communication)

---

## How Can I Contribute?

### Reporting Bugs

If you find a bug or unexpected behavior:
1. **Search existing issues** to make sure the bug hasn't already been reported.
2. If it's a new issue, open a new bug report in the repository.
3. Use a clear and descriptive title.
4. Include steps to reproduce the bug, the expected behavior, and what actually happened.
5. If possible, add screenshots/recordings and details of your browser version, operating system, and Groq API model choice.

### Suggesting Enhancements

We welcome new feature proposals:
1. Check the existing issues to ensure the idea hasn't been proposed yet.
2. Open an issue describing the feature, why it would be useful, and how it could be implemented.
3. If it involves changes to the UI/UX, feel free to mock up or describe how it should look.

### Pull Requests

To submit code changes:
1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add instructions or screenshots showing it works.
3. Ensure your code conforms to the style guide below.
4. Issue a Pull Request (PR) targeting the `main` branch.
5. Link the PR to any related issues.

---

## Development Setup

SachCheck is built as a lightweight Chrome Extension using Vanilla JS. It requires no complex build systems, bundle compilers, or transpilation steps.

1. Clone your fork of the repo:
   ```bash
   git clone https://github.com/<your-username>/sachcheck.git
   ```
2. Navigate to `chrome://extensions/` in your browser.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `/sachcheck-v2` sub-folder in this repository.
5. When making changes to any files:
   - Save the file.
   - Go back to `chrome://extensions/`.
   - Click the reload icon (refresh arrow) on the SachCheck card.
   - Reload the YouTube tab where you are testing the extension to apply the latest changes.

---

## Style Guide & Rules

To keep the codebase clean, legible, and maintainable, please follow these guidelines:

*   **Vanilla JS Priority:** Keep the core extension dependencies-free. Do not introduce npm packages, bundlers, or frameworks unless discussed and agreed upon in an issue first.
*   **Code Formatting:** Use 2 spaces for indentation, clean variable naming, and group logic logically (e.g. state, DOM helper functions, UI rendering, event listeners).
*   **Error Handling:** Always handle potential failures, especially around browser storage, tab communication (`chrome.runtime.lastError`), and asynchronous `fetch` requests.
*   **Performance:** The extension scrapes the active DOM on a timer. Keep DOM operations highly optimized to avoid rendering delays or high CPU usage on the YouTube tab.

---

## Code of Conduct

Help us maintain a welcoming and inclusive environment. Please be respectful, helpful, and kind in all issues, pull requests, and review comments.

Thank you for contributing to SachCheck! ⚡
