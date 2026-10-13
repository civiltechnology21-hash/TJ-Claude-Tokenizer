# TJ Claude Tokenizer

A small browser extension for keeping an eye on your Claude usage.

TJ Claude Tokenizer adds a lightweight status line above the chat box on [claude.ai](https://claude.ai). It estimates the text handled during a five-hour tracking cycle, keeps a history of previous cycles, and helps you learn roughly where your own usage limits tend to land.

It is a personal tracker, not an official Claude tool—and its token numbers are estimates, not Claude's actual internal counts.

## What it does

- **Shows a five-hour cycle timer.** See when the current tracking window started and how much time is left.
- **Estimates text tokens.** It uses configurable character-based estimates for Latin/ASCII text, Bengali text, and other characters.
- **Tracks activity across chats and tabs.** The extension stores one shared cycle, so activity from multiple open Claude tabs contributes to the same totals.
- **Adds a small on-page status line.** When enabled, a compact banner appears above the Claude chat composer.
- **Notices possible usage-limit messages.** It scans visible page text for common limit wording and may record a cycle as limit-reached.
- **Builds a personal history.** Completed cycles are saved with their duration, message count, estimated text totals, and ending reason.
- **Learns from your own limit points.** Cycles marked as limit-reached are summarized as minimum, median, and maximum estimates. This is a personal reference range, not a prediction or a guaranteed quota.
- **Exports history to CSV.** Open the file in a spreadsheet app for your own analysis.
- **Lets you tune the estimate.** Adjust character ratios, optional per-message overhead, banner visibility, and notifications.

## A quick note about accuracy

Claude does not expose its actual token usage to this extension. The numbers shown here are calculated from text found in the page, using simple character ratios. They should be treated as rough estimates.

That distinction matters:

- A character-based estimate is not the same as Claude's tokenizer.
- Images and files can contain content the extension cannot count as ordinary page text. When an attachment is detected, the extension marks the processed estimate as a minimum.
- The page structure on claude.ai can change. If Claude changes its interface, message or limit detection may need an update.
- The five-hour timer is a **personal tracking window**. It is not a live reading of Claude's official quota or a guarantee that your account's limit resets exactly when the timer reaches zero.
- The “vs typical limit” gauge compares the current estimate with the median of your recorded cycles that ended in a detected or manually marked limit. It becomes more useful after you have collected several records.

Use the numbers to spot patterns in your own workflow—not as exact billing, quota, or tokenization data.

## Install it locally

This project currently contains the extension source files; it does not include a packaged store release.

1. Download or clone this repository.
2. Unzip the project if you downloaded it as an archive.
3. Open your Chromium-based browser's extensions page. In Chrome, visit `chrome://extensions`.
4. Turn on **Developer mode**.
5. Choose **Load unpacked**.
6. Select the project folder that contains `manifest.json` (the `claude-tokenizer` folder in the supplied source archive).
7. Open or refresh [claude.ai](https://claude.ai).

The extension's popup is available from the browser toolbar. If you do not see the on-page status line, open the popup and check that **Show banner above chat box** is enabled, then refresh Claude.

> The manifest targets `https://claude.ai/*` and uses Manifest V3, so it is intended for Chrome and compatible Chromium-based browsers. Other browsers may require adjustments.

## Using the extension

### Start tracking

The first message you send while no cycle is active starts a new five-hour cycle automatically. You can also open the extension popup and select **Start cycle now** to start one manually.

### Read the popup

- **Window / Resets in** — the tracked cycle's start and scheduled end.
- **Typed** — the extension's estimate for newly observed text, including the assistant reply text it records.
- **Processed** — an estimate that also accounts for the visible conversation text included when a message is sent.
- **Messages** — the number of send events recorded in the cycle.
- **vs typical limit** — compares the current processed estimate with the median from previous cycles marked as limit-reached.
- **Limit points** — the minimum, median, and maximum estimates from recorded limit cycles.
- **History** — recent completed cycles and why each one ended.

The popup keeps up to 300 completed cycles in local extension storage, and displays the most recent 60 in the history list.

### Mark a limit or end a cycle

- Select **Limit reached** when Claude tells you that you've reached a usage limit. This saves the cycle as a limit point.
- If the extension recognizes a limit notice on the page, it can record the limit automatically.
- Select **End cycle** to finish the current cycle without marking it as a limit.
- After a cycle ends, the next tracked activity can start a new one.

Automatic detection relies on wording found in the page, so it can miss a notice or occasionally match unexpected text. You can use the manual button when needed.

### Adjust settings

Open **Settings** in the popup to change:

| Setting | What it changes |
| --- | --- |
| Latin characters per token | How many Latin/ASCII-range characters the estimator treats as one token. The default is `4`. |
| Bengali tokens per character | The estimated token contribution for each character in the Bengali Unicode block. The default is `1.75`. |
| Other tokens per character | The estimated token contribution for characters outside the other two groups. The default is `1`. |
| Extra tokens per message | An optional amount added to the processed estimate for each recorded message. The default is `0`. |
| Show banner above chat box | Turns the on-page status line on or off. |
| Notify when the cycle / limit resets | Enables browser notifications for the tracked cycle ending and a detected reset time, when one is available. |

Changing the character ratios also recalculates estimates for saved history because the extension stores raw character counts rather than fixed token totals.

The defaults are starting points, not universal conversion rates. You can adjust them based on your own observations, but doing so still will not make the estimate identical to Claude's internal tokenizer.

### Export or clear history

- **Export CSV** downloads `claude-tokenizer-history.csv`. It includes timestamps, end reason, message and attachment counts, estimated totals, raw character counts, and any captured limit notice.
- To delete one history entry, use the **×** beside that entry.
- **Clear history** asks for a second click before deleting all saved history.

Clearing history does not uninstall the extension. Your current active cycle is stored separately from completed history.

## How the estimate works

The extension counts text characters in three broad groups:

| Group | Default calculation |
| --- | --- |
| Latin / ASCII-range characters | character count ÷ `4` |
| Bengali Unicode block (`U+0980`–`U+09FF`) | character count × `1.75` |
| Other characters | character count × `1` |

For each send event, it reads the text it can find in the visible conversation and combines that with the message being sent. When the assistant's reply finishes, it records that reply text as well. This helps approximate the fact that a conversation's existing text may be sent as context again, but it is still only a page-text-based model.

The extension does **not** call Claude's private APIs, inspect account quota endpoints, or retrieve authoritative token counts. It works with text visible in the claude.ai page.

## Project structure

```text
claude-tokenizer/
├── manifest.json    # Extension metadata, permissions, and entry points
├── background.js    # Shared cycle/history state, alarms, and notifications
├── content.js       # Reads page text, estimates counts, detects limits, and draws the banner
├── content.css      # Styles for the on-page status line
├── popup.html       # Toolbar popup interface
├── popup.css        # Popup styling
├── popup.js         # Popup display, settings, history, and CSV export
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Privacy

The extension is designed to keep its tracking data in the browser:

- It uses `chrome.storage.local` to store the current cycle, settings, and history.
- It does not include analytics, an external server, or a remote API integration in the supplied source.
- The content script reads text from the Claude page to calculate estimates and look for usage-limit notices.
- CSV export creates a file locally in your browser.

Because the extension reads conversation text from the page, only install it if you are comfortable granting it access to `claude.ai`. Review the source before using it with sensitive conversations. Browser extensions and browser profiles are not a substitute for a dedicated secure archive.

## Permissions

The manifest requests these Chrome extension permissions:

- **`storage`** — save settings, the active cycle, and history locally.
- **`alarms`** — close a cycle at its scheduled end and schedule an optional reset notification.
- **`notifications`** — show browser notifications when the related setting is enabled.

The content script is configured to run on `https://claude.ai/*`.

## Known limitations

- Estimates can differ substantially from actual model tokenization.
- Hidden, unloaded, or virtualized conversation content may not be present in the page DOM and therefore may not be counted.
- File and image contents are not tokenized; an attachment flag only warns that the processed estimate may be incomplete.
- Limit detection depends on text patterns and can break if Claude changes its wording or page layout.
- If you switch chats while a reply is being generated, that reply may not be included.
- The extension tracks a fixed five-hour window; it does not know your plan-specific quota rules.
- Browser notification delivery depends on browser and operating-system settings.

## Contributing

Bug reports, suggestions, and pull requests are welcome. If you report a counting issue, include the browser, what you expected to happen, and what the extension showed. Please avoid sharing private Claude conversations or other sensitive content in an issue.

A useful contribution is one that keeps the tool simple, makes its estimates easier to understand, or improves resilience when Claude's interface changes.

## License

No license file was included in the supplied project archive. Until a license is added, others should not assume they have permission to redistribute or modify the project.

If you plan to publish this repository publicly, choose a license that matches how you want others to use the code and add it as a `LICENSE` file. For example, MIT is a common permissive option, but the choice is yours.

---

Made to make Claude usage a little easier to understand, one estimate at a time.
