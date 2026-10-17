# Amber Terminal project notes

- This is a standalone Node.js application. Use Node.js 18 or newer; dependencies are built in, so do not run `npm install`.
- Run the app commands from this project directory: `node scripts/check.js`, `node scripts/launch.js`, and `node scripts/stop.js`.
- Saved layout and app state live under `data/`. Keep that directory out of Git; `.gitignore` already excludes it.
- Keep `.env` files and credentials out of Git.
- Preserve `LICENSE`, `NOTICE`, and the TradingView chart-library attribution when changing or distributing the app.
- The server is intended for local use. Read `DEPLOYMENT.md` before exposing it to another machine or the internet.
