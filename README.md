# claudespeak

A Claude Code mod modelled on albertshiney/claudespeak, but using the computer's own built-in voices instead of Fish Audio: `say` on macOS, the SAPI voices (the ones Narrator uses) through PowerShell on Windows. No API key, no ffmpeg, no per-reply cost for the speech.

When Claude finishes a reply it reads a 1-3 sentence summary aloud (short plain replies are read as is; longer ones are summarised by one Haiku call). One voice at a time across all sessions; a new reply or a new prompt cuts the old one off. Quiet in sub-agents, `claude -p`, scheduled runs and nested sessions.

## Commands (on by default)

| Command | What it does |
| --- | --- |
| `/speak` | Status: on/off, voice, rate |
| `/speak on` / `/speak off` | Turn spoken replies on/off in every session |
| `/speak stop` | Cut off the current speech |
| `/speak voices` | List the English voices installed on this computer |
| `/speak voice Karen` | Pick a voice (`/speak voice default` = system voice) |
| `/speak rate 200` | Words per minute, 80-400 (`/speak rate default` = system rate) |
| `/speak test` | Speak a sample line |

**Mac:** better-sounding Premium/Enhanced voices download free in System Settings > Accessibility > Read & Speak > System voice > Manage Voices (open a voice with its arrow to see them).

**Windows:** extra voices download in Settings > Time & language > Speech > Add voices. Windows 11's "Natural" voices are not available to SAPI, so they won't appear in `/speak voices`. Windows support uses Windows PowerShell 5.1, which every Windows 10/11 machine has.

Settings live in `~/.claude/claudespeak/setting.json` (`%USERPROFILE%\.claude\claudespeak\setting.json` on Windows).

Renamed from macspeak in 0.3.0. Coming from macspeak? Uninstall it, install claudespeak, and copy `~/.claude/macspeak/setting.json` into `~/.claude/claudespeak/` to keep your voice and rate.

## Install

Works on macOS and Windows. At the prompt of a Claude Code terminal session:

```
/plugin install claudespeak --marketplace philmcdau-coder/claudespeak
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```
claude plugin install claudespeak --marketplace philmcdau-coder/claudespeak
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `philmcdau-coder/claudespeak`, then Add plugin.

Credit: based on [claudespeak](https://github.com/albertshiney/claudespeak) by albertshiney, which uses Fish Audio.
