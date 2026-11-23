# Cursor Sound Toggle

Play a sound when a task is done, and mute it with one click.

![YabaDaaDoo](ydd_logo.png)
![YabaDaaDoo](ydd_bar.jpg)

## Features

- **Status bar toggle** (bottom right): click `Sound: ON/OFF`. It switches Cursor's own agent-done chime (`cursor.composer.shouldChimeAfterChatFinishes`), so OFF really silences the agent.
- **Choose Done Sound…**: browse system sounds, hear each one as you arrow through the list, press Enter to keep it. Or pick any audio file.
- **Test Done Sound**: preview the current sound, even while muted.
- **Play Done Sound (if enabled)**: `cursor-sound-toggle.play`, for keybindings, tasks or automations to call when work finishes.

## Sound for Cursor's own chime

Changing the sound (**Choose Done Sound…** or editing `cursorSoundToggle.soundFile`) also writes it to Cursor's `cursor.composer.customChimeSoundPath`, so Cursor's built-in agent-done chime plays the same sound, with no hook needed. Resetting to default clears it. A path that does not exist is ignored. Which audio formats the built-in chime accepts is up to Cursor. The hook below is only needed for speech, per-event sounds and the filters, and per-event sounds and filters only apply with `replaceNativeChime` on. If you set `customChimeSoundPath` by hand it is kept until you change `soundFile` again.

## Completion triggers

The sound only fires when something calls it. Pick any of these:

- **Cursor agent hooks** (recommended): run **Cursor Sound: Install Cursor Hooks**. It adds `stop` (agent done), `subagentStop` and `postToolUseFailure` to `~/.cursor/hooks.json`, plus a small helper script `~/.cursor/cursor-sound-toggle-hook.sh` that reads Cursor's JSON to tell completed, error and aborted apart. It keeps your other hooks, upgrades its own entries in place when run again (never duplicates), and leaves a file it cannot parse untouched. Sub-agent and tool-failure sounds stay silent until you list them in `cursorSoundToggle.events` (see below). `AskQuestion` ("needs input") fires no Cursor hook at all, so it cannot get a sound. Or add the basic `stop` hook by hand:

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

  `open -g` is macOS and keeps Cursor in the background (the installer uses `xdg-open` on Linux and `start` on Windows, untested there; on Windows there is no status detection). Optional query params: `status` and `duration` (seconds).
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

`cursorSoundToggle.events` overrides the sound, text or mode per event. Keys are `event.status` (checked first) or `event`. Built-in events: `agent` (statuses `succeeded`, `failed`, `aborted`), `subagent` (same statuses, silent until configured), `tool` (a tool call failed, status `failed`, silent until configured, not fired for user cancels), `command` and `task` (`succeeded`, `failed` or `finished`). Per-event sounds for the agent need `replaceNativeChime` on. Your hook can send any `event=` name, for example `event=input` for "needs input".

```json
"cursorSoundToggle.events": {
  "command.failed": { "sound": "/System/Library/Sounds/Basso.aiff", "text": "{workspace}: command failed" },
  "command.succeeded": { "enabled": false },
  "agent.succeeded": { "sound": "/System/Library/Sounds/Hero.aiff" },
  "agent.failed": { "sound": "/System/Library/Sounds/Sosumi.aiff" },
  "agent.aborted": { "enabled": false },
  "subagent.succeeded": { "sound": "/System/Library/Sounds/Pop.aiff" },
  "tool.failed": { "sound": "/System/Library/Sounds/Basso.aiff" }
}
```

Each entry accepts `sound`, `text`, `mode` and `enabled`. An entry with `text` but no `mode` speaks it even when the global mode is `sound`. Preview any of them with **Cursor Sound: Test Event Announcement…**.

## Sound when the agent asks a question (`AskQuestion`)

Cursor fires no hook for the `AskQuestion` tool (checked: a `preToolUse` hook sees `Shell` and other tools but never `AskQuestion`), so the agent has to trigger the sound itself. The extension already handles `event=input`; you only need to set a sound and tell the agent to call it.

1. Pick a sound for the `input` event in `settings.json`. Any file `afplay` can play works (mp3, wav, aiff, m4a). Optionally add `text` to speak a phrase too:

   ```json
   "cursorSoundToggle.events": {
     "input": { "sound": "/System/Library/Sounds/Glass.aiff" }
   }
   ```

   Without this entry, `input` uses your normal `cursorSoundToggle.soundFile`. Preview it with **Cursor Sound: Test Event Announcement…** and choose `input`.

2. Add a rule so the agent runs this command right before every `AskQuestion` (put it in Cursor Settings → Rules → User Rules for all projects, or in `.cursor/rules/` for one repo):

   ```
   Before every AskQuestion call, first run this shell command with required_permissions ["all"]:
   open -g 'cursor://idmtr.cursor-sound-toggle/done?event=input'
   ```

   It needs to run outside the agent sandbox, otherwise macOS answers with `kLSExecutableIncorrectFormat` and nothing plays. This repo ships that rule in `.cursor/rules/ask-question-sound.mdc`. On Linux use `xdg-open`, on Windows `start` (untested).

It only works if the model follows the rule, and each question costs one extra shell call.

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
| Cursor Sound: Install Cursor Hooks | `cursor-sound-toggle.installHook` |
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
