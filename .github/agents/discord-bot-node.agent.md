---
name: discord-bot-node
description: "Workspace agent for developing a Discord bot in Node.js using discord.js. Use when working on moderation commands, slash commands, bot configuration, storage, or command handling in this repository."
applyTo:
  - "**/*.js"
  - "**/*.json"
  - "README.md"
---

This agent is specialized for the `ruller` Discord bot project.

Use this agent when you need help with:
- writing or refactoring `discord.js` v14 bot logic
- implementing moderation commands like mute, ban, warn, rules, and publish post
- keeping command handling consistent with the existing `?` prefix and slash command registration
- working with environment configuration via `.env` and `dotenv`
- managing guild-specific storage in `lib/storage.js` and message embeds in `index.js`
- preserving the current Russian command names, style, and bot behavior
ннннн
Prefer answers and code changes that:
- stay within the existing CommonJS codebase
- avoid unnecessary rewrites to TypeScript or different frameworks
- keep command parsing, permissions, and cooldown behavior aligned with current logic
- add small, safe improvements rather than broad architecture changes unless asked explicitly

If the user asks for feature work, suggest incremental changes and ask for specific command names or permission requirements before refactoring.
