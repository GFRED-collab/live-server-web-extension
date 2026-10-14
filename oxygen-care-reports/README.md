# Oxygen Care applications

This repository separates the two applications previously developed together in the Codex `Review` workspace.

## Applications

- [`expense-app`](./expense-app/) — the Oxygen Care expense capture, approval, reimbursement, odometer, and reporting application.
- [`oxygen-reports-app`](./oxygen-reports-app/) — the separate Oxygen Care reports application.
- [`oxygen-reports-server`](./oxygen-reports-server/) — the server-backed Reports foundation with PostgreSQL, Docker, secure account bootstrapping, and deployment configuration.

Each application has its own `README.md`, `package.json`, environment example, and deployment instructions. Run dependency installation and development commands from inside the application you are working on.

Live application data and secrets were deliberately not imported. Use each application's `.env.example` to create a local `.env` when needed.

The Reports demo and server package remain separate for now. The next development phase is to connect the demo workflows in `oxygen-reports-app` to the database and server facilities in `oxygen-reports-server`.
