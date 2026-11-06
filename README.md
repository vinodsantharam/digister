# Digister

Digister builds one phone-friendly HTML page every morning from the two things you follow most: your YouTube channels and an X List. A local model (Ollama) picks the videos worth watching today and summarizes the posts worth reading. Nothing is sent to a cloud AI service, and it costs nothing to run.

The page is a single self-contained file, `digest-YYYY-MM-DD.html`, with no JavaScript. It is written to a folder that syncs to your phone (iCloud Drive, Dropbox, Syncthing, and so on), and `latest.html` always points at the newest one.

More background: [plan](docs/PLAN.md), [build tasks](docs/TASKS.md).

## How it stays free

- **YouTube:** public channel RSS feeds. No API key, no login, no transcripts. A free YouTube Data API key is optional and only adds video lengths.
- **X:** no paid API. Digister opens a Chromium window with a profile you logged into once, visits your List, and reads the JSON that X's own web page loads. It uses your own account at human speed: one session per run, no parallel tabs, pauses between scrolls, capped at 4 minutes.
- **AI:** Ollama running on your own machine (default model `qwen3:8b`).

## The X risk, in plain words

Reading X this way is against X's terms of service. X can change its page without notice, which will break capture until the config is updated. X could also flag or limit the account it sees doing this. Use an account you can afford to lose, keep to one run a day, and do not raise the scroll limits. If X stops working, the digest still contains YouTube and its header says what went wrong.

## Setup

Do these in order.

1. **Install Node 22 or newer** from nodejs.org, then turn on pnpm (the project uses pnpm, not npm):
   ```
   corepack enable pnpm
   ```
2. **Install Ollama** from ollama.com, then pull the model (about 5 GB):
   ```
   ollama pull qwen3:8b
   ```
3. **Install the project:**
   ```
   git clone <this repo> digister && cd digister
   pnpm install
   pnpm exec playwright install chromium
   ```
   `pnpm-workspace.yaml` already approves the `better-sqlite3` native build, so no build prompt should appear. If you see `Could not locate the bindings file`, run `pnpm rebuild better-sqlite3`.
4. **Create a private X List** with the 30 to 80 accounts you care about, open it in a browser and copy its address (like `https://x.com/i/lists/1234567890`). The wizard asks for it next.
5. **Run the setup wizard:**
   ```
   pnpm dev setup
   ```
   It creates `~/.digister/config/` (or wherever `DIGISTER_HOME` points), copies the example configs without overwriting anything you already have, asks for the folder that syncs to your phone and for your X List address (press Enter to skip X), writes them into `digister.yaml` with its comments intact, runs the doctor checks and prints the next steps. It is safe to run again. Digister looks in `~/.digister/config/` first, then in `./config/` of the folder you run it from.

   To do it by hand instead: `mkdir -p ~/.digister/config`, copy `config/digister.example.yaml`, `config/interests.example.yaml` and `config/channels.yaml` there (dropping `.example` from the names), then set `output_dir` and `x.list_urls` in `digister.yaml`.
6. **Add your channels.** `config/channels.yaml` already lists Matt Pocock and Fireship as `must` channels. Add more one at a time, or import everything you subscribe to:
   ```
   pnpm dev youtube import --url @somechannel --tier must
   pnpm dev youtube import --takeout path/to/subscriptions.csv
   ```
   The Takeout file comes from Google Takeout (YouTube and YouTube Music, subscriptions). Imports never change channels you already have; Takeout channels are added as `normal`.
7. **Log in to X once:**
   ```
   pnpm dev x login
   ```
   A browser window opens. Log in yourself, then press Enter in the terminal. Digister never sees or stores your password.

   **If login in that window fails** (for example Google or Apple sign-in says the browser is not secure), copy your session from your normal browser instead. Open x.com there while logged in, then DevTools > Application > Cookies > `https://x.com`, and copy the values of `auth_token` and `ct0`. Then run:
   ```
   pnpm dev x import-cookies
   ```
   and paste the two values when asked. You can also pass a JSON export from a cookie extension like Cookie-Editor: `x import-cookies --file cookies.json`. These two cookies are your logged-in session: never share them, and delete the export file afterwards. Logging out of X in your normal browser ends the session, so if you do that, import fresh values.
8. **Check everything:**
   ```
   pnpm dev doctor
   ```
9. **Try it without side effects**, then do the first real run:
    ```
    pnpm dev run --dry
    pnpm dev run
    ```
    Open `digest-<today>.html` from your output folder.
10. **Install the daily schedule** (below).

`pnpm dev <command>` runs `tsx src/cli.ts <command>`, so it works straight after `pnpm install`. You can also run `node bin/digister.mjs <command>`, or `pnpm link --global` to get a `digister` command.

## Config files

All three live in `~/.digister/config/`.

**`digister.yaml`** is the main file. The keys you will touch:

| Key | Meaning |
| --- | --- |
| `output_dir` | Folder the digest is written to (required). `~` is expanded. |
| `ollama.chat_model` | Model name; must be pulled. Default `qwen3:8b`. |
| `x.enabled` | `false` skips X entirely. |
| `x.list_urls` | Your X List addresses. |
| `x.include_following` | Also read the chronological Following timeline. |
| `x.headless` | `false` shows the browser while capturing, useful for debugging. |
| `x.graphql_operations` | Names of the X requests to read. Change these if X renames them. |
| `x.lookback_hours`, `youtube.lookback_hours` | How far back to look. |
| `youtube.data_api_key` | Optional free key; adds durations. Leave empty to skip. |
| `digest.must_watch_max`, `posts_max`, `reading_minutes` | Size of the digest. |

**`channels.yaml`** lists channels as `id`, `name`, `tier`. The tier is `must`, `high` or `normal`: must-tier videos get +2 on their score, high +1, and only must and high channels appear in "Also new from your channels". Must-tier Shorts are still considered; other Shorts are skipped.

**`interests.yaml`** lists `topics` (name, weight, description) that the model scores against, and a `mute` list of phrases. Anything containing a muted phrase is dropped before the model sees it.

## Daily use

- Open `latest.html` on your phone. Sections: must watch today, X posts grouped by topic, and other new videos. Thumbnails load when you are online.
- Each item is shown once. Anything that appeared in a digest is not repeated.
- A second run on the same day writes `digest-<date>-2.html` (and updates `latest.html`) so the first one is kept; it only holds what is new since. Run it once a day.
- Only one run can happen at a time (a `run.lock` file in the Digister home). A lock left by a crashed run is replaced automatically once its process is gone.
- Logs are in `~/.digister/logs/`. Raw X payloads are kept in `~/.digister/raw/` for debugging.

## Scheduling (daily at 05:30)

Each script installs a job that runs `digister run` and appends output to `~/.digister/logs/schedule.log`. They record the absolute paths of `node` and of this repo at install time, so re-run the script if you move the repo or change your Node install. Each takes `--uninstall`.

- **macOS:** `bash scripts/install-schedule-macos.sh` installs a LaunchAgent. To wake the Mac at 05:25, run the command the script prints (`sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00`). A sleeping Mac runs the job when it wakes.
- **Linux:** `bash scripts/install-schedule-linux.sh` installs a systemd user timer with `Persistent=true`, so a missed run happens at next boot. To run while logged out, `loginctl enable-linger $USER`.
- **Windows:** in PowerShell, `.\scripts\install-schedule-windows.ps1`. The task wakes the PC to run.

The machine must be on (or wake) with Ollama installed. If Ollama is not running, Digister tries `ollama serve` once and waits 10 seconds.

## Troubleshooting

Start with `doctor`; it names the failing piece.

- **"X needs login" in the digest header:** the session expired or X asked for a check. Run `x check`, then `x login` again. If `x check` says blocked, set `x.headless: false`, run `x login`, and resolve any challenge in the window.
- **X returns no timeline data / "operation names may have changed":** X renamed its requests. The log (and the digest header) lists the operation names it saw. Put the right ones into `x.graphql_operations` in `digister.yaml`; no code change is needed.
- **Ollama down or model missing:** `run` exits with an error and writes no digest. Start Ollama (`ollama serve`, or open the app) and make sure `ollama pull qwen3:8b` finished. `doctor` shows which one it is.
- **"another digister run is in progress":** wait for it, or delete `~/.digister/run.lock` if you are sure none is running.
- **YouTube feeds failed:** a channel id may be wrong, or YouTube blocked you briefly. The run continues without those channels; `youtube check` shows which ones fail.
- **Config error:** the message names the file and the field.
- **Empty digest:** nothing new passed scoring, or everything was already shown. Run `run --dry` to see counts.

## Development

```
pnpm typecheck
pnpm test
```

Tests use recorded fixtures and mocked models; none touch the network.
