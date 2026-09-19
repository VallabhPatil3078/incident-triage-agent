# Incident Triage Agent

This is an autonomous, AI-driven Incident Triage Agent built on Cloudflare Workers using the Agents SDK.

It triages ongoing incidents by analyzing incoming alerts, executing runbooks, extracting signals, and proposing resolutions—all while maintaining an audit log via SQLite (D1) and running in Durable Objects for state persistence.

## Current Progress

- **Phase 0:** Project Scaffolding, GitHub Repo Init, and Cloudflare deployment.
- **Phase 1:** Data Model & Seed (SQLite tables created and seeded for incidents and runbooks).
- **Phase 2:** Signal Extraction (Pending)
- **Phase 3:** Matching & System Prompt (Pending)
- **Phase 4:** Approval Gate (Pending)

## Local Development

Run the local development server:

```bash
npm run dev
```

Then visit `http://localhost:5173`.

## Deployment

Deploy to Cloudflare Workers:

```bash
npx wrangler deploy
```
