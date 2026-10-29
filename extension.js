const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Cursor's own "chime when the agent finishes" switch. The agent-done sound is played by
// Cursor itself, so this setting (not extension state) is what actually mutes it.
const NATIVE_CHIME_SECTION = 'cursor.composer';
const NATIVE_CHIME_KEY = 'shouldChimeAfterChatFinishes';
// Cursor's own setting for the sound its chime plays; we mirror our picked sound into it.
const NATIVE_CHIME_SOUND_KEY = 'customChimeSoundPath';
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

const MAX_SPEECH_CHARS = 200;
const SAFE_WORD = /^[\w -]{1,30}$/; // for event/status values arriving via URI

const STATE_AUTO_MUTED = 'autoMuted'; // true while *we* turned the native chime off
const STATE_SNOOZE_UNTIL = 'snoozeUntil'; // epoch ms
const STATE_OWN_ENABLED = 'ownEnabled'; // ON/OFF while replaceNativeChime is on
const SNOOZE_CHOICES = [
    { label: '15 minutes', minutes: 15 },
    { label: '30 minutes', minutes: 30 },
    { label: '1 hour', minutes: 60 },
    { label: '2 hours', minutes: 120 }
];
const SPEECH_MODES = ['sound', 'speech', 'both'];

let extContext;
let quietTimer;
let statusBarItem;
let lastPlayedAt = 0;
let lastAnnounceAt = 0;
let currentPlayback;
let output;

function config() {
    return vscode.workspace.getConfiguration('cursorSoundToggle');
}

/** When on, this extension owns ON/OFF and Cursor's native chime is kept off (no double sound). */
function replacesNativeChime() {
    return config().get('replaceNativeChime', false) === true;
}

function nativeChimeOn() {
    return vscode.workspace.getConfiguration(NATIVE_CHIME_SECTION).get(NATIVE_CHIME_KEY, false) === true;
}

function isSoundEnabled() {
    return replacesNativeChime() ? extContext.globalState.get(STATE_OWN_ENABLED, true) : nativeChimeOn();
}

async function writeNativeChime(enabled) {
    try {
        await vscode.workspace
            .getConfiguration(NATIVE_CHIME_SECTION)
            .update(NATIVE_CHIME_KEY, enabled, vscode.ConfigurationTarget.Global);
    } catch (err) {
        log(`Could not update ${NATIVE_CHIME_SECTION}.${NATIVE_CHIME_KEY}: ${err.message}`);
        vscode.window.showErrorMessage('Cursor Sound Toggle: could not change the Cursor chime setting.');
    }
}

/**
 * Flips ON/OFF. Normally that is Cursor's native agent-done chime (the status bar follows via
 * onDidChangeConfiguration); in replace mode it is the extension's own state.
 */
async function setSoundEnabled(enabled) {
    if (replacesNativeChime()) {
        await extContext.globalState.update(STATE_OWN_ENABLED, enabled);
    } else {
        await writeNativeChime(enabled);
    }
    updateStatusBar();
}

/**
 * Mirrors `soundFile` into Cursor's own `cursor.composer.customChimeSoundPath`, so the native
 * chime plays the sound picked here. An empty soundFile clears it (Cursor's default chime).
 * A path that doesn't exist is left alone so a typo can't wipe a working setup.
 */
async function syncNativeChimeSound() {
    const file = (config().get('soundFile', '') || '').trim();
    if (file && !fs.existsSync(file)) {
        return;
    }
    try {
        await vscode.workspace
            .getConfiguration(NATIVE_CHIME_SECTION)
            .update(NATIVE_CHIME_SOUND_KEY, file || undefined, vscode.ConfigurationTarget.Global);
    } catch (err) {
        log(`Could not update ${NATIVE_CHIME_SECTION}.${NATIVE_CHIME_SOUND_KEY}: ${err.message}`);
    }
}

/** Keeps the native chime consistent with `replaceNativeChime`, migrating the ON/OFF state. */
async function enforceNativeMode() {
    const state = extContext.globalState;
    const own = state.get(STATE_OWN_ENABLED);
    if (replacesNativeChime()) {
        if (own === undefined) {
            await state.update(STATE_OWN_ENABLED, nativeChimeOn()); // carry the current state over
        }
        if (nativeChimeOn()) {
            await writeNativeChime(false);
        }
    } else if (own !== undefined) {
        await writeNativeChime(own); // leaving replace mode: hand the state back to Cursor
        await state.update(STATE_OWN_ENABLED, undefined);
    }
    updateStatusBar();
}

function log(message) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function activate(context) {
    extContext = context;
    output = vscode.window.createOutputChannel('Cursor Sound Toggle');
    context.subscriptions.push(output);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'cursor-sound-toggle.toggle';
    context.subscriptions.push(statusBarItem);
    updateStatusBar();

    context.subscriptions.push(
        vscode.commands.registerCommand('cursor-sound-toggle.toggle', async () => {
            // A manual toggle takes control back from snooze / quiet hours.
            await context.globalState.update(STATE_AUTO_MUTED, false);
            await context.globalState.update(STATE_SNOOZE_UNTIL, 0);
            await setSoundEnabled(!isSoundEnabled());
            scheduleQuietTick();
        }),

        vscode.commands.registerCommand('cursor-sound-toggle.installHook', () => installHook(context)),
        vscode.commands.registerCommand('cursor-sound-toggle.snooze', snooze),
        vscode.commands.registerCommand('cursor-sound-toggle.testEvent', testEvent),

        // Call this when a task is "done" (e.g. from a keybinding). Honors the toggle and filters.
        vscode.commands.registerCommand('cursor-sound-toggle.play', () => announce()),

        // Announces regardless of the toggle and filters, so the sound/speech can be previewed.
        vscode.commands.registerCommand('cursor-sound-toggle.test', () =>
            announce({ event: 'test', durationMs: 65000 }, { force: true })
        ),

        // External completion trigger, e.g. a Cursor `stop` hook:
        //   cursor://idmtr.cursor-sound-toggle/done?event=agent&status=succeeded&duration=42
        vscode.window.registerUriHandler({ handleUri: handleDoneUri }),

        vscode.commands.registerCommand('cursor-sound-toggle.chooseSound', chooseSound),

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cursorSoundToggle.replaceNativeChime')) {
                enforceNativeMode().then(syncQuiet);
                if (replacesNativeChime()) {
                    vscode.window
                        .showInformationMessage(
                            'Cursor Sound Toggle: Cursor\'s built-in chime is now off and this extension plays the sound. ' +
                                'It needs the Cursor stop hook to fire when the agent finishes.',
                            'Install Hook'
                        )
                        .then((choice) => choice && installHook(context));
                }
            } else if (
                e.affectsConfiguration(`${NATIVE_CHIME_SECTION}.${NATIVE_CHIME_KEY}`) &&
                replacesNativeChime() &&
                nativeChimeOn()
            ) {
                enforceNativeMode(); // someone re-enabled the native chime; keep it off
            } else if (e.affectsConfiguration('cursorSoundToggle.quietHours')) {
                syncQuiet();
            } else if (e.affectsConfiguration('cursorSoundToggle.soundFile')) {
                syncNativeChimeSound();
                updateStatusBar();
            } else if (
                e.affectsConfiguration('cursorSoundToggle') ||
                e.affectsConfiguration(`${NATIVE_CHIME_SECTION}.${NATIVE_CHIME_KEY}`)
            ) {
                updateStatusBar();
            }
        }),

        { dispose: stopPlayback },
        { dispose: () => clearTimeout(quietTimer) }
    );

    registerCompletionListeners(context);
    // Settle the native-chime mode, then apply quiet hours / restore a snooze that ended while closed.
    enforceNativeMode().then(syncQuiet);
}

// --- Cursor stop hook installer --------------------------------------------------------

/** Shell command that opens our URI without stealing focus where the OS allows it. */
function hookCommand(context) {
    const url = `${vscode.env.uriScheme}://${context.extension.id}/done?event=agent`;
    if (process.platform === 'darwin') {
        return `open -g '${url}'`;
    }
    if (process.platform === 'win32') {
        return `cmd /c start "" "${url}"`;
    }
    return `xdg-open '${url}'`;
}

/**
 * Adds our `stop` hook to ~/.cursor/hooks.json, keeping every other hook and key.
 * Never overwrites a file it cannot parse.
 */
async function installHook(context) {
    const file = path.join(os.homedir(), '.cursor', 'hooks.json');
    const marker = `${context.extension.id}/done`;
    const OPEN = 'Open hooks.json';
    const offerOpen = (message, fn = 'showInformationMessage') =>
        vscode.window[fn](message, OPEN).then(
            (choice) => choice && vscode.window.showTextDocument(vscode.Uri.file(file))
        );

    let data = { version: 1, hooks: {} };
    if (fs.existsSync(file)) {
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('top level is not an object');
            }
            if (data.hooks !== undefined && (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks))) {
                throw new Error('"hooks" is not an object');
            }
            if (data.hooks && data.hooks.stop !== undefined && !Array.isArray(data.hooks.stop)) {
                throw new Error('"hooks.stop" is not an array');
            }
        } catch (err) {
            log(`Could not read ${file}: ${err.message}`);
            offerOpen(`Cursor Sound Toggle: ~/.cursor/hooks.json was left untouched because it could not be read (${err.message}).`, 'showErrorMessage');
            return;
        }
    }

    data.version = data.version || 1;
    data.hooks = data.hooks || {};
    data.hooks.stop = data.hooks.stop || [];
    if (data.hooks.stop.some((h) => h && typeof h.command === 'string' && h.command.includes(marker))) {
        offerOpen('Cursor Sound Toggle: the stop hook is already installed.');
        return;
    }

    data.hooks.stop.push({ command: hookCommand(context), timeout: 5 });
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    } catch (err) {
        log(`Could not write ${file}: ${err.message}`);
        vscode.window.showErrorMessage(`Cursor Sound Toggle: could not write hooks.json (${err.message}).`);
        return;
    }
    log(`Installed stop hook in ${file}`);
    offerOpen('Cursor Sound Toggle: stop hook installed. Cursor reloads hooks.json on save; restart Cursor if it does not fire.');
}

// --- Quiet hours & snooze --------------------------------------------------------------
// Both work by flipping Cursor's native chime setting (the single source of truth for ON/OFF)
// and remembering that *we* muted it, so we only ever restore what we turned off.

function parseClock(value) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

function quietWindow() {
    const start = parseClock(config().get('quietHours.start', ''));
    const end = parseClock(config().get('quietHours.end', ''));
    return start === undefined || end === undefined || start === end ? undefined : { start, end };
}

function inQuietHours(now = new Date()) {
    const w = quietWindow();
    if (!w) {
        return false;
    }
    const minutes = now.getHours() * 60 + now.getMinutes();
    return w.start < w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
}

/** Milliseconds from now until the next occurrence of a clock time (minutes after midnight). */
function msUntilClock(minutes, now = new Date()) {
    const target = new Date(now);
    target.setHours(0, minutes, 0, 0);
    const diff = target - now;
    return diff > 0 ? diff : diff + 24 * 60 * 60 * 1000;
}

function snoozeUntil() {
    const until = extContext.globalState.get(STATE_SNOOZE_UNTIL, 0);
    return until > Date.now() ? until : 0;
}

function isQuietNow() {
    return snoozeUntil() > 0 || inQuietHours();
}

async function syncQuiet() {
    const state = extContext.globalState;
    const quiet = isQuietNow();
    if (quiet && isSoundEnabled()) {
        await state.update(STATE_AUTO_MUTED, true);
        await setSoundEnabled(false);
    } else if (!quiet && state.get(STATE_AUTO_MUTED, false)) {
        await state.update(STATE_AUTO_MUTED, false);
        if (!isSoundEnabled()) {
            await setSoundEnabled(true);
        }
    }
    scheduleQuietTick();
    updateStatusBar();
}

/** One timer, set for the next boundary only (quiet start/end or snooze end). No polling. */
function scheduleQuietTick() {
    clearTimeout(quietTimer);
    const waits = [];
    const w = quietWindow();
    if (w) {
        waits.push(msUntilClock(w.start), msUntilClock(w.end));
    }
    const until = snoozeUntil();
    if (until) {
        waits.push(until - Date.now());
    }
    if (waits.length) {
        quietTimer = setTimeout(syncQuiet, Math.max(1000, Math.min(...waits)) + 500);
    }
}

async function snooze() {
    if (!isSoundEnabled() && !snoozeUntil()) {
        vscode.window.showInformationMessage('Cursor Sound Toggle: the sound is already off.');
        return;
    }
    const items = SNOOZE_CHOICES.map((c) => ({ label: c.label, minutes: c.minutes }));
    if (snoozeUntil()) {
        items.unshift({ label: '$(play) Resume now', minutes: 0 });
    }
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Snooze Done Sound',
        placeHolder: 'Mute Cursor\'s done sound for…'
    });
    if (!pick) {
        return;
    }
    await extContext.globalState.update(STATE_SNOOZE_UNTIL, pick.minutes ? Date.now() + pick.minutes * 60000 : 0);
    await syncQuiet();
}

function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Label for the status bar when we auto-muted, e.g. "quiet until 08:00". */
function quietUntilLabel() {
    let until = snoozeUntil();
    const w = quietWindow();
    if (w && inQuietHours()) {
        until = Math.max(until, Date.now() + msUntilClock(w.end));
    }
    return until ? `quiet until ${formatClock(until)}` : 'quiet';
}

/** Previews a per-event announcement (see the `events` setting), ignoring toggle and filters. */
async function testEvent() {
    const configured = Object.keys(config().get('events', {}) || {});
    const keys = [...new Set(['agent', 'command.succeeded', 'command.failed', 'task.succeeded', 'task.failed', ...configured])];
    const pick = await vscode.window.showQuickPick(keys, {
        title: 'Test Event Announcement',
        placeHolder: 'Event key as used in cursorSoundToggle.events'
    });
    if (!pick) {
        return;
    }
    const [event, status] = pick.split('.');
    announce({ event, status: status || 'finished', durationMs: 65000 }, { force: true });
}

/** Terminal command / task end listeners. Each checks its own setting at event time. */
function registerCompletionListeners(context) {
    const statusOf = (exitCode) =>
        exitCode === undefined ? 'finished' : exitCode === 0 ? 'succeeded' : 'failed';

    // Shell integration events need VS Code 1.93+; skip quietly on older hosts.
    if (vscode.window.onDidStartTerminalShellExecution && vscode.window.onDidEndTerminalShellExecution) {
        const started = new WeakMap();
        context.subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution((e) => started.set(e.execution, Date.now())),
            vscode.window.onDidEndTerminalShellExecution((e) => {
                if (!config().get('triggers.terminalCommands', false)) {
                    return;
                }
                const start = started.get(e.execution);
                announce({
                    event: 'command',
                    status: statusOf(e.exitCode),
                    durationMs: start === undefined ? undefined : Date.now() - start
                });
            })
        );
    }

    const taskStarted = new WeakMap();
    context.subscriptions.push(
        vscode.tasks.onDidStartTaskProcess((e) => taskStarted.set(e.execution, Date.now())),
        vscode.tasks.onDidEndTaskProcess((e) => {
            if (!config().get('triggers.tasks', false)) {
                return;
            }
            const start = taskStarted.get(e.execution);
            announce({
                event: 'task',
                status: statusOf(e.exitCode),
                durationMs: start === undefined ? undefined : Date.now() - start
            });
        })
    );
}

function handleDoneUri(uri) {
    if (uri.path !== '/done') {
        log(`Ignoring unknown URI path: ${uri.path}`);
        return;
    }
    const q = new URLSearchParams(uri.query);
    const seconds = q.has('duration') ? Number(q.get('duration')) : NaN;
    announce({
        event: SAFE_WORD.test(q.get('event') || '') ? q.get('event') : 'agent',
        status: SAFE_WORD.test(q.get('status') || '') ? q.get('status') : 'finished',
        durationMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
    });
}

/**
 * The single entry point for "something finished". Applies the toggle and the filters
 * (min duration, only-when-unfocused), then plays the sound, speaks the text, or both.
 */
async function announce(info = {}, { force = false } = {}) {
    const override = eventOverride(info);
    if (!force) {
        if (!isSoundEnabled() || override.enabled === false) {
            return;
        }
        const minMs = Math.max(0, Number(config().get('minDurationSeconds', 0)) || 0) * 1000;
        if (info.durationMs !== undefined && info.durationMs < minMs) {
            return;
        }
        if (config().get('onlyWhenUnfocused', false) && vscode.window.state.focused) {
            return;
        }
        if (Date.now() - lastAnnounceAt < MIN_REPLAY_MS) {
            return; // e.g. a task and its terminal both ending at once
        }
    }

    const globalMode = config().get('announceMode', 'sound');
    // An event with its own `text` but no `mode` speaks it, even if the global mode is sound-only.
    const mode = SPEECH_MODES.includes(override.mode)
        ? override.mode
        : override.text && globalMode === 'sound' ? 'both' : globalMode;
    const text = mode === 'sound' ? '' : renderAnnouncement(info, override.text);

    // The agent-done sound belongs to exactly one player. While Cursor's own chime is the owner
    // (replaceNativeChime off), it already plays for this event, so we must not play a second sound.
    // Speech is still allowed: it is not something Cursor's chime does.
    const nativeOwnsSound = !force && info.event === 'agent' && !replacesNativeChime();
    if (nativeOwnsSound && !text) {
        log('Agent done: Cursor\'s own chime plays the sound, so the extension stays silent (enable replaceNativeChime to use the extension sound instead).');
        return;
    }

    lastAnnounceAt = Date.now();
    stopPlayback();

    if (!nativeOwnsSound && (!text || mode === 'both')) {
        await playSound(resolveSoundFile(override.sound), { force: true });
    }
    if (text) {
        await speak(text);
    }
}

/**
 * Per-event settings from `cursorSoundToggle.events`. Looks up "event.status" first
 * (e.g. "command.failed"), then "event" (e.g. "agent"). Returns {} when none is set.
 */
function eventOverride({ event = 'task', status = 'finished' } = {}) {
    const events = config().get('events', {}) || {};
    const found = events[`${event}.${status}`] || events[event];
    return found && typeof found === 'object' ? found : {};
}

/** Fills {workspace} {branch} {duration} {event} {status} in the announcement text. */
function renderAnnouncement({ event = 'task', status = 'finished', durationMs } = {}, textOverride) {
    const source = typeof textOverride === 'string' ? textOverride : config().get('announceText', '');
    const template = (source || '').trim();
    if (!template) {
        return '';
    }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const vars = {
        workspace: folder ? folder.name : 'workspace',
        branch: folder ? currentBranch(folder.uri.fsPath) : '',
        duration: formatDuration(durationMs),
        event,
        status
    };
    return template
        .replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_SPEECH_CHARS);
}

function formatDuration(ms) {
    if (ms === undefined) {
        return '';
    }
    const total = Math.round(ms / 1000);
    if (total < 1) {
        return 'under a second';
    }
    const m = Math.floor(total / 60);
    const s = total % 60;
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    return m ? (s ? `${plural(m, 'minute')} ${plural(s, 'second')}` : plural(m, 'minute')) : plural(s, 'second');
}

/** Reads the branch straight from .git/HEAD (no git process); handles worktrees. */
function currentBranch(folderPath) {
    try {
        let gitDir = path.join(folderPath, '.git');
        if (fs.statSync(gitDir).isFile()) {
            const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
            if (!pointer) {
                return '';
            }
            gitDir = path.resolve(folderPath, pointer[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 7);
    } catch {
        return '';
    }
}

/** The configured sound if it exists, otherwise the platform default. */
function resolveSoundFile(preferred) {
    const custom = (typeof preferred === 'string' ? preferred : config().get('soundFile', '') || '').trim();
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

/** Text-to-speech candidates using each OS's built-in voice; text is never shell-interpolated. */
function buildSpeechPlayers(text) {
    if (process.platform === 'darwin') {
        return [['say', ['--', text]]];
    }

    if (process.platform === 'win32') {
        const volume = Math.min(100, Math.max(0, config().get('volume', 100)));
        return [[
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
                'Add-Type -AssemblyName System.Speech; ' +
                '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
                '$s.Volume = [int]$env:CST_VOLUME; $s.Speak($env:CST_TEXT)'],
            { CST_TEXT: text, CST_VOLUME: String(volume) }
        ]];
    }

    return [
        ['spd-say', ['-w', '--', text]],
        ['espeak', ['--', text]]
    ];
}

function speak(text) {
    return runFirstAvailable(buildSpeechPlayers(text)).catch(reportPlaybackError);
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
        return Promise.resolve(); // avoid stacked/overlapping playback from rapid triggers
    }
    lastPlayedAt = now;
    if (interrupt) {
        stopPlayback();
    }

    return runFirstAvailable(buildPlayers(file)).catch(reportPlaybackError);
}

function reportPlaybackError(err) {
    if (err.killed) {
        return; // intentionally interrupted by the next preview
    }
    log(`Playback failed: ${err.message}`);
    vscode.window
        .showWarningMessage('Cursor Sound Toggle: could not play sound.', 'Show Log')
        .then((choice) => choice && output.show(true));
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
    const enabled = isSoundEnabled();
    // Whoever owns the agent-done sound is what you hear: this extension in replace mode,
    // otherwise Cursor's chime, which plays its own `customChimeSoundPath`.
    const nativePath = (vscode.workspace.getConfiguration(NATIVE_CHIME_SECTION).get(NATIVE_CHIME_SOUND_KEY, '') || '').trim();
    const soundFile = replacesNativeChime() ? resolveSoundFile() : nativePath;
    const soundName = soundFile
        ? `${path.basename(soundFile, path.extname(soundFile))}${replacesNativeChime() ? '' : ', Cursor chime'}`
        : 'Cursor default chime';
    const autoMuted = !enabled && extContext.globalState.get(STATE_AUTO_MUTED, false);
    const tooltip = new vscode.MarkdownString(
        [
            `**Done sound: ${autoMuted ? quietUntilLabel() : enabled ? 'ON' : 'OFF'}** (${soundName})`,
            '',
            `[${enabled ? 'Mute' : 'Enable'}](command:cursor-sound-toggle.toggle) · ` +
                '[Snooze](command:cursor-sound-toggle.snooze) · ' +
                '[Change sound](command:cursor-sound-toggle.chooseSound) · ' +
                '[Test](command:cursor-sound-toggle.test)'
        ].join('\n')
    );
    tooltip.isTrusted = true;

    statusBarItem.text = enabled
        ? '$(unmute) Sound: ON'
        : autoMuted ? `$(bell-slash) Sound: ${quietUntilLabel()}` : '$(mute) Sound: OFF';
    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}

function deactivate() {
    stopPlayback();
}

module.exports = { activate, deactivate };
