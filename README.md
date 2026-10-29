# Cursor Sound Toggle

Play a sound when a task is done, and mute it with one click.

## Features

- **Status bar toggle** (bottom right): click `Sound: ON/OFF`. It switches Cursor's own agent-done chime (`cursor.composer.shouldChimeAfterChatFinishes`), so OFF really silences the agent.
- **Choose Done Sound…**: browse system sounds, hear each one as you arrow through the list, press Enter to keep it. Or pick any audio file.
- **Test Done Sound**: preview the current sound, even while muted.
- **Play Done Sound (if enabled)**: `cursor-sound-toggle.play`, for keybindings, tasks or automations to call when work finishes.

## Sound for Cursor's own chime

Changing the sound (**Choose Done Sound…** or editing `cursorSoundToggle.soundFile`) also writes it to Cursor's `cursor.composer.customChimeSoundPath`, so Cursor's built-in agent-done chime plays the same sound, with no hook needed. Resetting to default clears it. A path that does not exist is ignored. Which audio formats the built-in chime accepts is up to Cursor. The hook below is only needed for speech, per-event sounds and the filters, and per-event sounds and filters only apply with `replaceNativeChime` on. If you set `customChimeSoundPath` by hand it is kept until you change `soundFile` again.

## Completion triggers

The sound only fires when something calls it. Pick any of these:

- **Cursor agent `stop` hook** (recommended): run **Cursor Sound: Install Cursor Stop Hook**. It merges the entry below into `~/.cursor/hooks.json`, keeps your other hooks, is safe to run twice, and leaves a file it cannot parse untouched. Or add it by hand:

  ```json
  {
    "version": 1,
    "hooks": {
      "stop": [
        { "command": "open -g 'cursor://idmtr.cursor-sound-toggle/done?event=agent'" }
      ]
    }
  }
  ```

  `open -g` is macOS and keeps Cursor in the background (the installer uses `xdg-open` on Linux and `start` on Windows, untested there). Optional query params: `status` and `duration` (seconds).
- **Terminal commands**: enable `cursorSoundToggle.triggers.terminalCommands`.
- **Tasks**: enable `cursorSoundToggle.triggers.tasks`.
- **Keybinding / command**: `cursor-sound-toggle.play`.

### Which player makes the agent-done sound?

Exactly one, chosen by `cursorSoundToggle.replaceNativeChime`:

| `replaceNativeChime` | Who plays when the agent finishes | Sound used |
| --- | --- | --- |
| `false` (default) | Cursor's built-in chime. The hook still runs, but the extension plays no sound for agent-done (it only speaks, if you set up speech). | `cursor.composer.customChimeSoundPath` |
| `true` | This extension, via the hook. Cursor's chime is kept off. Per-event sounds and the filters apply. | `cursorSoundToggle.soundFile` |

The toggle, snooze and quiet hours control whichever player is active, and the status bar tooltip shows which sound that is. Turning the setting off hands the ON/OFF state back to Cursor's chime. In `true` mode, nothing plays unless the hook is installed. Terminal-command and task triggers are separate and always play through the extension.

## Spoken announcements

Set `cursorSoundToggle.announceMode` to `speech` or `both` and write `cursorSoundToggle.announceText`, for example `{workspace} on {branch} is {status} {duration}`. It uses the OS voice (`say`, Windows speech, `spd-say`/`espeak`). Variables: `{workspace}`, `{branch}`, `{duration}`, `{event}`, `{status}`. Use **Test Done Sound** to preview.

## Per-event sounds and phrases

`cursorSoundToggle.events` overrides the sound, text or mode per event. Keys are `event.status` (checked first) or `event`. Built-in events are `agent` (from the hook URI), `command` and `task`, with statuses `succeeded`, `failed` or `finished`. Your hook can send any `event=` name, for example `event=input` for "needs input".

```json
"cursorSoundToggle.events": {
  "command.failed": { "sound": "/System/Library/Sounds/Basso.aiff", "text": "{workspace}: command failed" },
  "command.succeeded": { "enabled": false },
  "agent": { "text": "Agent finished {duration}" }
}
```

Each entry accepts `sound`, `text`, `mode` and `enabled`. An entry with `text` but no `mode` speaks it even when the global mode is `sound`. Preview any of them with **Cursor Sound: Test Event Announcement…**.

## Quiet hours and snooze

- **Snooze Done Sound…** (also in the status bar tooltip): mute for 15 minutes to 2 hours, then it restores itself.
- **Quiet hours**: set `cursorSoundToggle.quietHours.start` and `.end` as `HH:MM` (overnight ranges work).

Both mute Cursor's native chime too, and the status bar shows `quiet until HH:MM`. The extension only restores the chime if it was the one that turned it off, so a chime you muted yourself stays muted. Clicking the status bar toggles manually and overrides a snooze until the next quiet-hours boundary.

## Filters

- `cursorSoundToggle.minDurationSeconds`: ignore short tasks (when the duration is known).
- `cursorSoundToggle.onlyWhenUnfocused`: stay silent while the Cursor window is focused.

## Commands

| Command | ID |
| --- | --- |
| Cursor Sound: Toggle Done Sound | `cursor-sound-toggle.toggle` |
| Cursor Sound: Choose Done Sound… | `cursor-sound-toggle.chooseSound` |
| Cursor Sound: Play Done Sound (if enabled) | `cursor-sound-toggle.play` |
| Cursor Sound: Test Done Sound | `cursor-sound-toggle.test` |
| Cursor Sound: Install Cursor Stop Hook | `cursor-sound-toggle.installHook` |
| Cursor Sound: Snooze Done Sound… | `cursor-sound-toggle.snooze` |
| Cursor Sound: Test Event Announcement… | `cursor-sound-toggle.testEvent` |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+M` | Toggle sound on/off |
| `Ctrl+Alt+Shift+M` | Choose done sound |

Rebind them in Keyboard Shortcuts (search "Cursor Sound").

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorSoundToggle.soundFile` | `""` | Absolute path to the sound. Empty uses the platform default. |
| `cursorSoundToggle.volume` | `100` | 0-100. Not applied to sounds on Windows (speech only). |
| `cursorSoundToggle.replaceNativeChime` | `false` | Keep Cursor's built-in chime off; only this extension plays. |
| `cursorSoundToggle.announceMode` | `sound` | `sound`, `speech` or `both`. |
| `cursorSoundToggle.announceText` | `""` | Spoken text with `{workspace}`, `{branch}`, `{duration}`, `{event}`, `{status}`. |
| `cursorSoundToggle.events` | `{}` | Per-event `sound`, `text`, `mode`, `enabled` overrides. |
| `cursorSoundToggle.quietHours.start` / `.end` | `""` | `HH:MM` range during which the chime is muted. |
| `cursorSoundToggle.minDurationSeconds` | `0` | Skip tasks shorter than this. |
| `cursorSoundToggle.onlyWhenUnfocused` | `false` | Only announce when the window is unfocused. |
| `cursorSoundToggle.triggers.terminalCommands` | `false` | Announce when terminal commands end. |
| `cursorSoundToggle.triggers.tasks` | `false` | Announce when tasks end. |

## Requirements

- macOS: `afplay` (built in)
- Windows: PowerShell (built in)
- Linux: `paplay` (PulseAudio/PipeWire) or `aplay` (ALSA)

Playback failures are logged to the **Cursor Sound Toggle** output channel.
