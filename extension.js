const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const STATE_KEY = 'cursorSoundToggle.enabled';
const MIN_REPLAY_MS = 400;
const AUDIO_EXT = /\.(aiff?|wav|mp3|m4a|oga|ogg|flac)$/i;

const SOUND_DIRS = {
    darwin: ['/System/Library/Sounds', '/Library/Sounds'],
    win32: ['C:\\Windows\\Media'],
    linux: ['/usr/share/sounds/freedesktop/stereo', '/usr/share/sounds/alsa']
};
const DEFAULT_SOUND = {
    darwin: '/System/Library/Sounds/Glass.aiff',
    win32: 'C:\\Windows\\Media\\notify.wav',
    linux: '/usr/share/sounds/freedesktop/stereo/complete.oga'
};

let isSoundEnabled = true;
let statusBarItem;
let lastPlayedAt = 0;
let currentPlayback;
let output;

function config() {
    return vscode.workspace.getConfiguration('cursorSoundToggle');
}

function log(message) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function activate(context) {
    output = vscode.window.createOutputChannel('Cursor Sound Toggle');
    context.subscriptions.push(output);

    // Persist across restarts and windows (the status bar is created per window).
    isSoundEnabled = context.globalState.get(STATE_KEY, true);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'cursor-sound-toggle.toggle';
    context.subscriptions.push(statusBarItem);
    updateStatusBar();

    context.subscriptions.push(
        vscode.commands.registerCommand('cursor-sound-toggle.toggle', async () => {
            isSoundEnabled = !isSoundEnabled;
            await context.globalState.update(STATE_KEY, isSoundEnabled);
            updateStatusBar();
        }),

        // Call this when a task is "done" (e.g. from a hook or keybinding).
        vscode.commands.registerCommand('cursor-sound-toggle.play', () => {
            if (isSoundEnabled) {
                playSound(resolveSoundFile());
            }
        }),

        // Plays regardless of the toggle, so the configured sound can be previewed.
        vscode.commands.registerCommand('cursor-sound-toggle.test', () =>
            playSound(resolveSoundFile(), { force: true })
        ),

        vscode.commands.registerCommand('cursor-sound-toggle.chooseSound', chooseSound),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cursorSoundToggle')) {
                updateStatusBar();
            }
        }),

        { dispose: stopPlayback }
    );
}

/** The configured sound if it exists, otherwise the platform default. */
function resolveSoundFile() {
    const custom = (config().get('soundFile', '') || '').trim();
    if (custom) {
        if (fs.existsSync(custom)) {
            return custom;
        }
        log(`Configured soundFile not found, falling back to default: ${custom}`);
    }
    return DEFAULT_SOUND[process.platform] || DEFAULT_SOUND.linux;
}

/** Lists system sounds available on this machine as QuickPick items. */
function discoverSounds() {
    const dirs = SOUND_DIRS[process.platform] || SOUND_DIRS.linux;
    const items = [];
    for (const dir of dirs) {
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue; // directory absent on this machine
        }
        for (const name of names.filter((n) => AUDIO_EXT.test(n)).sort()) {
            items.push({
                label: path.basename(name, path.extname(name)),
                description: dir,
                filePath: path.join(dir, name)
            });
        }
    }
    return items;
}

/** Interactive picker: arrow through the list to hear each sound, Enter to keep it. */
function chooseSound() {
    const current = resolveSoundFile();
    const BROWSE = { label: '$(folder-opened) Browse for a sound file…', action: 'browse' };
    const RESET = { label: '$(discard) Reset to default', action: 'reset' };
    const sounds = discoverSounds().map((s) => ({
        ...s,
        label: `${s.filePath === current ? '$(check) ' : ''}${s.label}`,
        action: 'pick'
    }));

    const picker = vscode.window.createQuickPick();
    picker.title = 'Choose Done Sound';
    picker.placeholder = 'Highlight a sound to preview it, press Enter to select';
    picker.matchOnDescription = true;
    picker.items = [
        ...sounds,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        BROWSE,
        RESET
    ];
    const currentItem = picker.items.find((i) => i.filePath === current);
    if (currentItem) {
        picker.activeItems = [currentItem];
    }

    // Preview as the highlight moves (debounced so fast scrolling doesn't spam audio).
    let previewTimer;
    picker.onDidChangeActive((active) => {
        clearTimeout(previewTimer);
        const item = active[0];
        if (item && item.action === 'pick') {
            previewTimer = setTimeout(() => playSound(item.filePath, { force: true, interrupt: true }), 150);
        }
    });

    picker.onDidAccept(async () => {
        const item = picker.selectedItems[0];
        picker.hide();
        if (!item) {
            return;
        }
        if (item.action === 'pick') {
            await saveSound(item.filePath);
        } else if (item.action === 'reset') {
            await saveSound('');
        } else if (item.action === 'browse') {
            const [uri] = (await vscode.window.showOpenDialog({
                canSelectMany: false,
                title: 'Select a sound file',
                filters: { Audio: ['aiff', 'aif', 'wav', 'mp3', 'm4a', 'oga', 'ogg', 'flac'] }
            })) || [];
            if (uri) {
                await saveSound(uri.fsPath);
            }
        }
    });

    picker.onDidHide(() => {
        clearTimeout(previewTimer);
        stopPlayback();
        picker.dispose();
    });
    picker.show();
}

async function saveSound(filePath) {
    await config().update('soundFile', filePath || undefined, vscode.ConfigurationTarget.Global);
    playSound(resolveSoundFile(), { force: true, interrupt: true });
}

/**
 * Builds the ordered list of [binary, args, env] candidates for the current platform.
 * Arguments are passed as an array (no shell), so paths with spaces or quotes are safe.
 */
function buildPlayers(file) {
    const volume = Math.min(100, Math.max(0, config().get('volume', 100))) / 100;

    if (process.platform === 'darwin') {
        return [['afplay', ['-v', String(volume), file]]];
    }

    if (process.platform === 'win32') {
        // Path goes through an env var so no quoting/escaping is needed.
        return [[
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
                '(New-Object Media.SoundPlayer $env:CST_SOUND_FILE).PlaySync()'],
            { CST_SOUND_FILE: file }
        ]];
    }

    return [
        ['paplay', ['--volume', String(Math.round(volume * 65536)), file]],
        ['aplay', ['-q', file]]
    ];
}

function stopPlayback() {
    if (currentPlayback) {
        currentPlayback.kill();
        currentPlayback = undefined;
    }
}

function playSound(file, { force = false, interrupt = false } = {}) {
    const now = Date.now();
    if (!force && now - lastPlayedAt < MIN_REPLAY_MS) {
        return; // avoid stacked/overlapping playback from rapid triggers
    }
    lastPlayedAt = now;
    if (interrupt) {
        stopPlayback();
    }

    runFirstAvailable(buildPlayers(file)).catch((err) => {
        if (err.killed) {
            return; // intentionally interrupted by the next preview
        }
        log(`Playback failed: ${err.message}`);
        vscode.window
            .showWarningMessage('Cursor Sound Toggle: could not play sound.', 'Show Log')
            .then((choice) => choice && output.show(true));
    });
}

function runFirstAvailable(players) {
    return players.reduce(
        (chain, [bin, args, env]) =>
            chain.catch((prev) => {
                if (prev && prev.killed) {
                    throw prev; // don't fall through to another player after a deliberate stop
                }
                return new Promise((resolve, reject) => {
                    const child = execFile(
                        bin,
                        args,
                        { env: { ...process.env, ...env }, windowsHide: true },
                        (err) => {
                            if (currentPlayback === child) {
                                currentPlayback = undefined;
                            }
                            if (err) {
                                err.killed = err.killed || child.killed;
                                if (!err.killed) {
                                    log(`${bin} failed: ${err.message}`);
                                }
                                reject(err);
                            } else {
                                resolve();
                            }
                        }
                    );
                    currentPlayback = child;
                });
            }),
        Promise.reject(new Error('no audio player available'))
    );
}

function updateStatusBar() {
    const soundName = path.basename(resolveSoundFile(), path.extname(resolveSoundFile()));
    const tooltip = new vscode.MarkdownString(
        [
            `**Done sound: ${isSoundEnabled ? 'ON' : 'OFF'}** (${soundName})`,
            '',
            `[${isSoundEnabled ? 'Mute' : 'Enable'}](command:cursor-sound-toggle.toggle) · ` +
                '[Change sound](command:cursor-sound-toggle.chooseSound) · ' +
                '[Test](command:cursor-sound-toggle.test)'
        ].join('\n')
    );
    tooltip.isTrusted = true;

    statusBarItem.text = isSoundEnabled ? '$(unmute) Sound: ON' : '$(mute) Sound: OFF';
    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}

function deactivate() {
    stopPlayback();
}

module.exports = { activate, deactivate };
