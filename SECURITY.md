# Security policy

Digister is a personal tool that runs on your own machine. It stores an X browser profile (with your session cookies), a SQLite database and your config under `~/.digister/`. None of that belongs in this repository.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" button on the repository's Security tab, not in a public issue. You should get a reply within a week.

## What to keep out of the repository

- The `~/.digister/` folder, especially `x-profile/`, which holds your logged-in X session.
- Any API key (for example `youtube.data_api_key`). Keep it in `~/.digister/config/digister.yaml`, never in `config/`.
- `.env` files, databases and generated digests (already in `.gitignore`).

If a secret is ever committed, revoke it first (log out of X on all sessions, or delete the API key), then remove it from history.
