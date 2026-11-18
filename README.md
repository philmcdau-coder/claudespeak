# macspeak

A Claude Code mod modelled on albertshiney/claudespeak, but using the Mac's built-in voices (`/usr/bin/say`) instead of Fish Audio. No API key, no ffmpeg, no per-reply cost for the speech.

When Claude finishes a reply it reads a 1-3 sentence summary aloud (short plain replies are read as is; longer ones are summarised by one Haiku call). One voice at a time across all sessions; a new reply or a new prompt cuts the old one off. Quiet in sub-agents, `claude -p`, scheduled runs and nested sessions.

## Commands (on by default)

| Command | What it does |
| --- | --- |
| `/speak` | Status: on/off, voice, rate |
| `/speak on` / `/speak off` | Turn spoken replies on/off in every session |
| `/speak stop` | Cut off the current speech |
| `/speak voices` | List the English voices installed on this Mac |
| `/speak voice Karen` | Pick a voice (`/speak voice default` = system voice) |
| `/speak rate 200` | Words per minute, 80-400 (`/speak rate default` = system rate) |
| `/speak test` | Speak a sample line |

Better-sounding Premium/Enhanced voices download free in System Settings > Accessibility > Spoken Content > System voice > Manage Voices. Settings live in `~/.claude/macspeak/setting.json`.

## Install

Needs macOS. At the prompt of a Claude Code terminal session:

```
/plugin install macspeak --marketplace philmcdau-coder/claude-macspeak
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```
claude plugin install macspeak --marketplace philmcdau-coder/claude-macspeak
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `philmcdau-coder/claude-macspeak`, then Add plugin.

Credit: based on [claudespeak](https://github.com/albertshiney/claudespeak) by albertshiney, which uses Fish Audio.
