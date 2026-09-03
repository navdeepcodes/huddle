# Huddle

A multiplayer agentic coding platform — shared sessions where multiple people
collaborate with AI coding agents in real time, rather than each running a
solo copilot session.

## Stack

- [Next.js](https://nextjs.org) (App Router) + React + TypeScript
- Firebase (session/runtime state)
- OpenAI + Gemini for the agent layer
- Vitest for testing

## Structure

```
app/
  session/[sessionId]/   live multiplayer session UI
  p/[sessionId]/         public/shared session view
  settings/              user settings
  api/
    sessions/            session lifecycle
    runtime-commands/    agent command execution
    credentials/         per-user API key vault (encrypted at rest)
lib/
  credentials/           credential storage + encryption
```

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

Create a `.env.local` with your own values — see `.env.example` for the full list.
None of these are provided; you'll need your own Firebase project and API keys.

```bash
npm run test    # vitest
npm run lint
npm run build
```

## Status

Early / actively developed. Expect breaking changes.
