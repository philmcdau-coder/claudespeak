import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// macspeak: claudespeak, but with the Mac's built-in voices (/usr/bin/say).
// Each finished reply is cut to 1-3 spoken sentences by a small model and read aloud.
// No API key, no ffmpeg, no network for the speech itself.
// One machine-wide switch (/speak on|off) and one voice at a time across all sessions.

type $ = EngineInterface

const SAY = '/usr/bin/say'
const PKILL = '/usr/bin/pkill'
const MAX_SPOKEN = 300
const SUMMARY_TIMEOUT_MS = 6000

// Outside the plugin folder, so an update never wipes the setting.
const DATA_DIR = '.claude/macspeak'
const SETTING_FILE = 'setting.json'
const CURRENT_FILE = 'current-speech'
const TAG_PREFIX = 'macspeak-'
/** Any session's say process, and nothing else: its argv starts with /usr/bin/say. */
export const ANY_SPEECH = `^${SAY} .*${TAG_PREFIX}[0-9]+`

// Claim the current-speech file, kill every other speaker, then give way if a newer
// speaker claimed it meanwhile; otherwise become `say` reading the tagged text file.
// $1 tag, $2 current file, $3 pkill, $4 pattern, $5 say, $6 text file, $7... say options
const SPEAK_SCRIPT =
  'T="$1"; C="$2"; K="$3"; P="$4"; S="$5"; F="$6"; shift 6; ' +
  'printf %s "$T" > "$C"; "$K" -KILL -f "$P"; [ "$(cat "$C")" = "$T" ] || exit 0; ' +
  'exec "$S" "$@" -f "$F"'

type Setting = { isOn: boolean; voice?: string; rate?: number }

type Config = { voice: string; rate: string; summaryModel: string }

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

// ---------- the mod ----------

const st: { speechGen: number; streamTag: string | undefined; isInteractive: boolean } = {
  speechGen: 0,
  streamTag: undefined,
  isInteractive: false,
}

let cfg: Config = { voice: '', rate: '', summaryModel: 'haiku' }

async function homeData($: $): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/${DATA_DIR}`
}

async function dataPath($: $, file: string): Promise<string> {
  return `${await homeData($)}/${file}`
}

async function writeData($: $, file: string, text: string): Promise<void> {
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
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

function stopSpeech($: $): void {
  st.speechGen += 1
  if (st.streamTag !== undefined) void $.process.run([PKILL, '-KILL', '-f', st.streamTag]).catch(() => undefined)
  st.streamTag = undefined
}

/** Cuts speech in every session, and tells a reply still being summarised to stay quiet. */
async function stopEverySpeech($: $): Promise<void> {
  stopSpeech($)
  await $.process.run([PKILL, '-KILL', '-f', ANY_SPEECH]).catch(() => undefined)
  await writeData($, CURRENT_FILE, `stopped ${await $.clock.now()}`)
}

async function tmpDir($: $): Promise<string> {
  const dir = (await $.env.get('TMPDIR')) ?? '/tmp'
  return dir.replace(/\/+$/, '') || '/tmp'
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

/** Speaks one line through say. Resolves when it ends or something cuts it. */
async function sayLine($: $, text: string, voice: string, rate: string): Promise<void> {
  const tag = `${TAG_PREFIX}${await $.clock.now()}`
  const textPath = `${await tmpDir($)}/${tag}.txt`
  await $.fs.write(textPath, text)
  await $.process.run(['/bin/mkdir', '-p', '-m', '700', await homeData($)])
  const opts: string[] = []
  if (voice !== '') opts.push('-v', voice)
  if (/^\d+$/.test(rate)) opts.push('-r', rate)
  st.streamTag = tag
  try {
    const ran = await $.process.run(
      ['/bin/sh', '-c', SPEAK_SCRIPT, 'macspeak', tag, await dataPath($, CURRENT_FILE), PKILL, ANY_SPEECH, SAY, textPath, ...opts],
      { timeoutMs: 180_000 },
    )
    // 137 is another reply taking over. Anything else is say failing (a bad voice name, say).
    if (ran.exitCode !== 0 && ran.exitCode !== 137) {
      $.ui.toast(`macspeak: say failed: ${ran.stderr.trim().split('\n').pop()?.slice(0, 80) ?? ''}`, { timeoutMs: 8000 })
    }
  } finally {
    if (st.streamTag === tag) st.streamTag = undefined
    await $.process.run(['/bin/rm', '-f', textPath]).catch(() => undefined)
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

async function englishVoices($: $): Promise<string> {
  const ran = await $.process.run([SAY, '-v', '?']).catch(() => undefined)
  const names = (ran?.stdout ?? '')
    .split('\n')
    .map(line => /^(.+?)\s{2,}(en_[A-Z]{2})\s/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => `${m[1]} (${m[2]})`)
  return names.length > 0 ? names.join(', ') : 'none found'
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    st.isInteractive = e.isInteractive
    await $.command.register({
      name: 'speak',
      description: 'Read replies aloud with the Mac voice: /speak on, off, stop, voice <name>, rate <wpm>, voices, test',
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
      return { text: `English voices on this Mac: ${await englishVoices($)}. Set one with /speak voice <name>. More (including Premium/Enhanced ones) download in System Settings > Accessibility > Spoken Content > System voice > Manage Voices.` }
    }
    if (arg === 'voice') {
      if (value === '' || value.toLowerCase() === 'default') {
        await saveSetting($, { voice: undefined })
        return { text: 'Using the system voice.' }
      }
      // say -o /dev/null fails for every voice (-241), so check the installed list instead.
      const list = await $.process.run([SAY, '-v', '?']).catch(() => undefined)
      const installed = (list?.stdout ?? '').split('\n').some(line => line.toLowerCase().startsWith(`${value.toLowerCase()} `))
      if (!installed) return { text: `No voice called "${value}". Run /speak voices for the list.` }
      await saveSetting($, { voice: value })
      stopSpeech($)
      void sayLine($, `Hi, I'm ${value.replace(/\s*\(.*$/, '')}. I'll read your replies from now on.`, value, effective(await readSetting($)).rate)
      return { text: `Voice set to ${value} in every session.` }
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
    return {
      text: `Spoken replies are ${s.isOn ? 'on' : 'off'} in every session. Voice: ${voice || 'system default'}. Rate: ${rate ? `${rate} wpm` : 'system default'}.${quiet}`,
    }
  }).catch(() => ({ text: 'macspeak: /speak failed.' }))

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
      $.ui.toast(`macspeak: ${err instanceof Error ? err.message.slice(0, 100) : 'speech failed'}`)
    })
    return result
  })

  on('session.end', ($, e, next) => {
    stopSpeech($)
    return next(e)
  })
}
