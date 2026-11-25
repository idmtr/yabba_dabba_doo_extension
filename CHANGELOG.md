# Changelog

## Unreleased
- Add completion triggers: URI handler (`cursor://idmtr.cursor-sound-toggle/done`) for Cursor `stop` hooks, terminal command end, and task end.
- Add spoken announcements with a templated text (`announceMode`, `announceText`).
- Add `minDurationSeconds` and `onlyWhenUnfocused` filters; `play` now honors them.
- Run as a UI extension so sound plays on your machine in Remote SSH/WSL; `soundFile` is machine-scoped so it no longer syncs to machines where the file is missing.
- Add per-event overrides (`events` setting: `sound`, `text`, `mode`, `enabled`) and a **Test Event Announcement…** command.
- Add **Snooze Done Sound…** and `quietHours.start`/`quietHours.end`. They mute Cursor's native chime and restore it only if the extension muted it; the status bar shows `quiet until HH:MM`.
- Add `replaceNativeChime`: keeps Cursor's built-in chime off and makes the extension own ON/OFF, so a hook-triggered sound never doubles with the native one.
- Add **Install Cursor Stop Hook** command: merges the hook into `~/.cursor/hooks.json` without touching other hooks, and is offered when enabling `replaceNativeChime`.
- Fix: the chosen sound now also reaches Cursor's built-in chime. Changing `soundFile` mirrors it into `cursor.composer.customChimeSoundPath` (cleared on reset; missing files are ignored).
- Fix: no more double sound when the hook is installed and Cursor's chime is on. With `replaceNativeChime` off, agent-done is played by Cursor's chime only (the extension stays silent for it, speech still works); with it on, only the extension plays. The status bar tooltip now shows the sound of whichever player is active.
- Add sounds per agent outcome: **Install Cursor Hooks** (renamed from *Install Cursor Stop Hook*) now also installs `subagentStop` and `postToolUseFailure` and a helper script that reads the hook status. New event keys `agent.succeeded` / `agent.failed` / `agent.aborted`, `subagent.*` and `tool.failed`; the last two stay silent until set in `events`. Re-running the command upgrades an existing hook in place.
- Fix: announcements are debounced per source, so a sub-agent finishing right before the agent no longer swallows the agent's sound.
- Fix: a sound in a macOS-protected folder (Downloads, Desktop, Documents) no longer fails with `AudioFileOpen failed (-54)`. Files picked with **Choose Done Sound… > Browse** are now copied into the extension's own storage, so they keep working wherever the original is. An unreadable or missing file plays the default sound instead and shows a one-click **Pick the Sound Again** / **Privacy Settings** message (once per file per session).
- Requires VS Code 1.93+ (terminal shell integration events).

## 0.3.0
- Fix: the toggle now controls Cursor's own agent-done chime (`cursor.composer.shouldChimeAfterChatFinishes`). Before, it only gated this extension's `play` command, so Cursor kept playing its sound while "OFF".
- ON/OFF state now follows that setting, so changing it in Settings updates the status bar.
- Add extension icon.

## 0.2.1
- Keyboard shortcuts: `Ctrl+Alt+M` toggles, `Ctrl+Alt+Shift+M` opens the sound picker.

## 0.2.0
- Add **Choose Done Sound…** picker with live preview and file browser.
- Status bar tooltip with Mute / Change sound / Test links.
- Replace `macSound` setting with the cross-platform `soundFile`.

## 0.1.0
- Activate on startup so the status bar item always appears.
- Persist ON/OFF state; add `play` and `test` commands, volume setting.
- Safe playback via `execFile`; Linux player fallback; error logging.
