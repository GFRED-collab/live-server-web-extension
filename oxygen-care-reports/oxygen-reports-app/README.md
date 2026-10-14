# Oxygen Care Reports — Local Demo

This folder is the standalone presentation demo. It runs locally at `http://localhost:3001` using `Start Oxygen Care Reports.command` and does not connect to a database or external server.

The demo is intentionally separate from `../oxygen-care-reports-server`, which contains the database and deployment foundation for the future hosted version.

## Demo boundaries

- Data is held only for the active browser session.
- Login, MFA and password reset are demonstration flows only.
- Do not enter real staff details, passwords or sensitive reports.

## Local check

Install dependencies once with `npm install`, then either double-click the launcher or run `npm run dev -- --port 3001`.
