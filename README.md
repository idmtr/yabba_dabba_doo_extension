# Cursor Sound Toggle

Play a sound when a task is done, and mute it with one click.

## Features

- **Status bar toggle** (bottom right): click `Sound: ON/OFF`. State persists across restarts.
- **Choose Done Sound…**: browse system sounds, hear each one as you arrow through the list, press Enter to keep it. Or pick any audio file.
- **Test Done Sound**: preview the current sound, even while muted.
- **Play Done Sound (if enabled)**: `cursor-sound-toggle.play`, for keybindings, tasks or automations to call when work finishes.

## Commands

| Command | ID |
| --- | --- |
| Cursor Sound: Toggle Done Sound | `cursor-sound-toggle.toggle` |
| Cursor Sound: Choose Done Sound… | `cursor-sound-toggle.chooseSound` |
| Cursor Sound: Play Done Sound (if enabled) | `cursor-sound-toggle.play` |
| Cursor Sound: Test Done Sound | `cursor-sound-toggle.test` |

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
| `cursorSoundToggle.volume` | `100` | 0-100. Not applied on Windows. |

## Requirements

- macOS: `afplay` (built in)
- Windows: PowerShell (built in)
- Linux: `paplay` (PulseAudio/PipeWire) or `aplay` (ALSA)

Playback failures are logged to the **Cursor Sound Toggle** output channel.
