import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// claudespeak: Claude Code replies read aloud with the computer's own built-in voices.
// macOS: /usr/bin/say. Windows: the SAPI voices through PowerShell (scripts/speak-windows.ps1).
// Each finished reply is cut to 1-3 spoken sentences by a small model and read aloud.
// No API key, no ffmpeg, no network for the speech itself.
// One machine-wide switch (/speak on|off) and one voice at a time across all sessions.

type $ = EngineInterface

const SAY = '/usr/bin/say'
const PKILL = '/usr/bin/pkill'
const MAX_SPOKEN = 300
const SUMMARY_TIMEOUT_MS = 6000

// Outside the plugin folder, so an update never wipes the setting.
const DATA_DIR = '.claude/claudespeak'
const SETTING_FILE = 'setting.json'
const CURRENT_FILE = 'current-speech'
const TAG_PREFIX = 'claudespeak-'
/** Any session's say process, and nothing else: its argv starts with /usr/bin/say. */
export const ANY_SPEECH = `^${SAY} .*${TAG_PREFIX}[0-9]+`

// macOS: claim the current-speech file, kill every other speaker, then give way if a newer
// speaker claimed it meanwhile; otherwise become `say` reading the tagged text file.
// $1 tag, $2 current file, $3 pkill, $4 pattern, $5 say, $6 text file, $7... say options
const SPEAK_SCRIPT =
  'T="$1"; C="$2"; K="$3"; P="$4"; S="$5"; F="$6"; shift 6; ' +
  'printf %s "$T" > "$C"; "$K" -KILL -f "$P"; [ "$(cat "$C")" = "$T" ] || exit 0; ' +
  'exec "$S" "$@" -f "$F"'

type Setting = { isOn: boolean; voice?: string; rate?: number }

type Config = { voice: string; rate: string; summaryModel: string }

type Os = 'mac' | 'windows' | 'other'

const SUMMARY_SYSTEM = [
  "You turn a coding assistant's reply into what a voice assistant says out loud.",
  'Write one to three short sentences, under 280 characters in total, in plain conversational English, speaking to the user as "you".',
  'Say what was done or found, and anything the user has to decide or do next.',
  'Never include code, commands, file paths, URLs, markdown, lists, emoji, brackets or long numbers.',
  'Output only the words to speak.',
].join('\n')

const readConfig = (options: PluginOptions): Config => {
  const text = (key: keyof Config, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return { voice: text('voice', ''), rate: text('rate', ''), summaryModel: text('summaryModel', 'haiku') }
}

// ---------- pure helpers ----------

/** True when a reply is already short plain prose that can be spoken as is. */
export const isSpeakable = (answer: string): boolean => {
  const text = answer.trim()
  if (text === '' || text.length > MAX_SPOKEN) return false
  if (text.split('\n').filter(line => line.trim() !== '').length > 2) return false
  if (/[`*#|<>_{}\\]|^\s*[-+]\s|^\s*\d+\.\s/m.test(text)) return false
  if (/https?:\/\/|www\./i.test(text)) return false
  if (/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/.test(text)) return false
  return true
}

/** Makes model or reply text safe to speak: no markdown, paths, URLs, bracket tags; ≤ 300 chars. */
export const cleanSpoken = (raw: string): string => {
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)[~.]?\/?[\w.-]+\/[\w./-]+/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/[*_#>|`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= MAX_SPOKEN) return text
  const cut = text.slice(0, MAX_SPOKEN)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ')).trim()}.`
}

/** Fallback when the summary model gives nothing: the reply's first sentences. */
export const firstSentences = (answer: string): string => {
  const prose = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\s*(?:#|\||[-*+]\s|\d+\.\s)/.test(line))
    .join(' ')
  const sentences = prose.match(/[^.!?]+[.!?]+/g) ?? [prose]
  return cleanSpoken(sentences.slice(0, 2).join(' '))
}

/** A missing or unreadable setting means on, with the configured voice and rate. */
export const parseSetting = (text: string | undefined): Setting => {
  try {
    const raw = JSON.parse(text ?? '{}') as { isOn?: unknown; voice?: unknown; rate?: unknown }
    return {
      isOn: raw.isOn !== false,
      voice: typeof raw.voice === 'string' && raw.voice.trim() !== '' ? raw.voice.trim() : undefined,
      rate: typeof raw.rate === 'number' && raw.rate > 0 ? raw.rate : undefined,
    }
  } catch {
    return { isOn: true }
  }
}

/** Words per minute to SAPI's -10..10 scale (0 is about 180 wpm). */
export const sapiRate = (wpm: string): string => {
  const n = Number(wpm)
  if (wpm === '' || !Number.isFinite(n)) return ''
  return String(Math.max(-10, Math.min(10, Math.round((n - 180) / 18))))
}

/** Voice names out of `say -v '?'` (mac) or the script's "name<TAB>culture" lines (Windows). */
export const parseVoices = (os: Os, stdout: string): { name: string; lang: string }[] =>
  stdout
    .split(/\r?\n/)
    .map(line => (os === 'windows' ? /^(.+?)\t(\S+)/.exec(line) : /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line)))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ name: (m[1] ?? '').trim(), lang: m[2] ?? '' }))

// ---------- the platform layer ----------

const st: { speechGen: number; streamTag: string | undefined; isInteractive: boolean; os: Os | undefined } = {
  speechGen: 0,
  streamTag: undefined,
  isInteractive: false,
  os: undefined,
}

let cfg: Config = { voice: '', rate: '', summaryModel: 'haiku' }

async function osOf($: $): Promise<Os> {
  if (st.os !== undefined) return st.os
  if ((await $.env.get('OS')) === 'Windows_NT') st.os = 'windows'
  else st.os = (await $.fs.exists(SAY).catch(() => false)) ? 'mac' : 'other'
  return st.os
}

const sep = (os: Os): string => (os === 'windows' ? '\\' : '/')

async function powershell($: $): Promise<string> {
  const root = ((await $.env.get('SystemRoot')) ?? 'C:\\Windows').replace(/\\+$/, '')
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** Runs scripts/speak-windows.ps1 with a mode and its arguments. */
async function ps($: $, args: string[], timeoutMs = 30_000) {
  const script = `${$.plugin.root.replace(/[\\/]+$/, '')}\\scripts\\speak-windows.ps1`
  return $.process.run(
    [await powershell($), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { timeoutMs },
  )
}

async function homeData($: $): Promise<string> {
  const os = await osOf($)
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home.replace(/[\\/]+$/, '')}${sep(os)}${DATA_DIR.replace('/', sep(os))}`
}

async function dataPath($: $, file: string): Promise<string> {
  return `${await homeData($)}${sep(await osOf($))}${file}`
}

async function makeDataDir($: $): Promise<void> {
  if ((await osOf($)) === 'windows') await ps($, ['mkdir', await homeData($)])
  else await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
}

async function removeFile($: $, path: string): Promise<void> {
  if ((await osOf($)) === 'windows') await ps($, ['rm', path]).catch(() => undefined)
  else await $.process.run(['/bin/rm', '-f', path]).catch(() => undefined)
}

async function tmpDir($: $): Promise<string> {
  const dir = (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? '/tmp'
  return dir.replace(/[\\/]+$/, '') || '/tmp'
}

async function writeData($: $, file: string, text: string): Promise<void> {
  await makeDataDir($)
  await $.fs.write(await dataPath($, file), text)
}

async function readSetting($: $): Promise<Setting> {
  return parseSetting(await $.fs.read(await dataPath($, SETTING_FILE)).catch(() => undefined))
}

async function saveSetting($: $, change: Partial<Setting>): Promise<Setting> {
  const next = { ...(await readSetting($)), ...change }
  await writeData($, SETTING_FILE, JSON.stringify(next))
  return next
}

/** The voice and rate in effect: /speak's choice first, then the plugin options. */
const effective = (s: Setting): { voice: string; rate: string } => ({
  voice: s.voice ?? cfg.voice,
  rate: s.rate !== undefined ? String(s.rate) : cfg.rate,
})

async function installedVoices($: $): Promise<{ name: string; lang: string }[]> {
  const os = await osOf($)
  const ran =
    os === 'windows' ? await ps($, ['voices']).catch(() => undefined) : await $.process.run([SAY, '-v', '?']).catch(() => undefined)
  return parseVoices(os, ran?.stdout ?? '')
}

function stopSpeech($: $): void {
  st.speechGen += 1
  // On macOS, this session's own say. On Windows the next speaker (or /speak stop) ends it.
  if (st.streamTag !== undefined && st.os === 'mac') {
    void $.process.run([PKILL, '-KILL', '-f', st.streamTag]).catch(() => undefined)
  }
  st.streamTag = undefined
}

/** Cuts speech in every session, and tells a reply still being summarised to stay quiet. */
async function stopEverySpeech($: $): Promise<void> {
  stopSpeech($)
  if ((await osOf($)) === 'windows') await ps($, ['stop', await dataPath($, CURRENT_FILE)]).catch(() => undefined)
  else await $.process.run([PKILL, '-KILL', '-f', ANY_SPEECH]).catch(() => undefined)
  await writeData($, CURRENT_FILE, `stopped ${await $.clock.now()}`)
}

async function summarize($: $, answer: string): Promise<string> {
  if (isSpeakable(answer)) return cleanSpoken(answer)
  const reply = await $.model
    .complete({
      model: cfg.summaryModel,
      system: SUMMARY_SYSTEM,
      prompt: `The reply to turn into speech:\n<reply>\n${answer.slice(0, 6000)}\n</reply>`,
      maxTokens: 120,
      effort: 'low',
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
    .catch(() => undefined)
  const spoken = reply?.isAnswered ? cleanSpoken(reply.text) : ''
  return spoken !== '' ? spoken : firstSentences(answer)
}

/** Speaks one line. Resolves when it ends or something cuts it. */
async function sayLine($: $, text: string, voice: string, rate: string): Promise<void> {
  const os = await osOf($)
  if (os === 'other') {
    $.ui.toast('claudespeak works on macOS and Windows only', { timeoutMs: 8000 })
    return
  }
  const tag = `${TAG_PREFIX}${await $.clock.now()}`
  const textPath = `${await tmpDir($)}${sep(os)}${tag}.txt`
  await $.fs.write(textPath, text)
  await makeDataDir($)
  const current = await dataPath($, CURRENT_FILE)
  st.streamTag = tag
  try {
    let ran
    if (os === 'windows') {
      ran = await ps($, ['speak', tag, current, textPath, voice, sapiRate(rate)], 180_000)
    } else {
      const opts: string[] = []
      if (voice !== '') opts.push('-v', voice)
      if (/^\d+$/.test(rate)) opts.push('-r', rate)
      ran = await $.process.run(
        ['/bin/sh', '-c', SPEAK_SCRIPT, 'claudespeak', tag, current, PKILL, ANY_SPEECH, SAY, textPath, ...opts],
        { timeoutMs: 180_000 },
      )
    }
    // A speaker cut off by a newer reply dies silently; only a real failure writes to stderr.
    const err = ran.stderr.trim()
    if (ran.exitCode !== 0 && err !== '') {
      $.ui.toast(`claudespeak: speech failed: ${err.split(/\r?\n/).pop()?.slice(0, 100) ?? ''}`, { timeoutMs: 8000 })
    }
  } finally {
    if (st.streamTag === tag) st.streamTag = undefined
    await removeFile($, textPath)
  }
}

async function speak($: $, answer: string, setting: Setting): Promise<void> {
  stopSpeech($)
  const gen = st.speechGen
  const startedAt = await $.clock.now()
  const line = await summarize($, answer)
  if (line === '' || gen !== st.speechGen) return
  const current = await $.fs.read(await dataPath($, CURRENT_FILE)).catch(() => '')
  if (current.startsWith('stopped ') && Number(current.slice(8)) > startedAt) return
  const { voice, rate } = effective(setting)
  await sayLine($, line, voice, rate)
}

/** A person's session only: never a scheduled run, a nested claude, Cowork, -p or an SDK host. */
async function mayTalkHere($: $): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_CHILD_SESSION')) return false
  if (await $.env.get('CLAUDE_CODE_HOST_SCHEDULED_RUN')) return false
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'local-agent') return false
  if (st.isInteractive) return true
  return ((await $.session.surfaces().catch(() => [])) ?? []).length > 0
}

const MORE_VOICES: Record<Os, string> = {
  mac: 'More (including Premium/Enhanced ones) download in System Settings > Accessibility > Read & Speak > System voice > Manage Voices.',
  windows: 'More download in Settings > Time & language > Speech > Add voices.',
  other: '',
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    st.isInteractive = e.isInteractive
    await $.command.register({
      name: 'speak',
      description: 'Read replies aloud with the built-in voice: /speak on, off, stop, voice <name>, rate <wpm>, voices, test',
      argumentHint: '[on|off|stop|voice <name>|rate <wpm>|voices|test]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const raw = e.args.trim()
    const [word = '', ...rest] = raw.split(/\s+/)
    const arg = word.toLowerCase()
    const value = raw.slice(word.length).trim()
    const os = await osOf($)

    if (arg === 'stop') {
      await stopEverySpeech($)
      return { text: 'Stopped speaking.' }
    }
    if (arg === 'on' || arg === 'off') {
      await saveSetting($, { isOn: arg === 'on' })
      if (arg === 'off') await stopEverySpeech($)
      return { text: `Spoken replies are ${arg} in every session.` }
    }
    if (arg === 'voices') {
      const english = (await installedVoices($)).filter(v => /^en[_-]/i.test(v.lang))
      const list = english.length > 0 ? english.map(v => `${v.name} (${v.lang})`).join(', ') : 'none found'
      return { text: `English voices on this computer: ${list}. Set one with /speak voice <name>. ${MORE_VOICES[os]}` }
    }
    if (arg === 'voice') {
      if (value === '' || value.toLowerCase() === 'default') {
        await saveSetting($, { voice: undefined })
        return { text: 'Using the system voice.' }
      }
      const match = (await installedVoices($)).find(v => v.name.toLowerCase() === value.toLowerCase())
      if (match === undefined) return { text: `No voice called "${value}". Run /speak voices for the list.` }
      await saveSetting($, { voice: match.name })
      stopSpeech($)
      const short = match.name.replace(/^Microsoft\s+/i, '').replace(/\s*(\(.*|Desktop.*)$/i, '')
      void sayLine($, `Hi, I'm ${short}. I'll read your replies from now on.`, match.name, effective(await readSetting($)).rate)
      return { text: `Voice set to ${match.name} in every session.` }
    }
    if (arg === 'rate') {
      const n = Number(rest[0])
      if (value === '' || value.toLowerCase() === 'default') {
        await saveSetting($, { rate: undefined })
        return { text: 'Using the system speaking rate.' }
      }
      if (!Number.isInteger(n) || n < 80 || n > 400) return { text: 'Give a rate in words per minute, 80 to 400 (about 175-220 sounds natural).' }
      await saveSetting($, { rate: n })
      return { text: `Speaking rate set to ${n} words per minute.` }
    }
    if (arg === 'test') {
      const { voice, rate } = effective(await readSetting($))
      stopSpeech($)
      void sayLine($, 'This is how your replies will sound.', voice, rate)
      return { text: 'Speaking a test line.' }
    }
    const s = await readSetting($)
    const { voice, rate } = effective(s)
    const quiet = s.isOn && !(await mayTalkHere($)) ? ' This session stays quiet: no person is attached to it.' : ''
    const unsupported = os === 'other' ? ' This computer has no supported voice: claudespeak works on macOS and Windows.' : ''
    return {
      text: `Spoken replies are ${s.isOn ? 'on' : 'off'} in every session. Voice: ${voice || 'system default'}. Rate: ${rate ? `${rate} wpm` : 'system default'}.${quiet}${unsupported}`,
    }
  }).catch(() => ({ text: 'claudespeak: /speak failed.' }))

  // A new prompt means the person has moved on: cut the old reply's speech.
  on('prompt.submit', ($, e, next) => {
    stopSpeech($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
    if (!isMainAnswer || !(await mayTalkHere($))) return result
    const setting = await readSetting($)
    if (!setting.isOn) return result
    void speak($, e.answer, setting).catch(err => {
      $.ui.toast(`claudespeak: ${err instanceof Error ? err.message.slice(0, 100) : 'speech failed'}`)
    })
    return result
  })

  on('session.end', ($, e, next) => {
    stopSpeech($)
    return next(e)
  })
}
