# Shoal

Shoal is a self-hosted team workspace for AI agents, company knowledge, and project work. Connect cloud providers or your own model servers, give agents access to the right information, and let them search, ask questions, write code, and run checks in assigned directories. Conversations, permissions, files, and task results stay in storage you control.

## Hackathon

Shoal was created for the **NVIDIA x Cornell Hackathon**, where it won **third place**.

## Requirements

- **Node.js 22.18 or newer**; Node.js 24 is recommended.
- **Git** on the Shoal host for repository tasks.
- A provider API key or an existing compatible model server for AI responses.
- **Docker** on the runner host for agents that execute code.
- **OpenSSL** for the built-in LAN HTTPS server.

Use macOS or Linux, or Docker/WSL on Windows. Shoal does not need a GPU. A model server can run on a separate workstation or NVIDIA DGX Spark; inference runs wherever that server is hosted. Shoal connects to existing servers and does not install model weights or GPU drivers.

## Install and start

Clone the repository, install its dependencies, and run setup:

```sh
git clone https://github.com/orion-hoch/relay-agent-workspace.git
cd relay-agent-workspace
npm ci
npm run setup
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Use the setup code printed by `npm run setup` to create your workspace and individual owner account. The setup code is only for first-run registration; teammates use their own accounts.

Setup creates private configuration in `.env.local` and preserves an existing file. SQLite and local file storage work without another service. Startup applies database migrations and starts the web app, document indexing worker, model runner, and command terminal together.

For normal use after development:

```sh
npm run build
npm start
```

Rebuild after changing source code. Stop the processes with Ctrl-C. To use another port, run `PORT=3001 npm run dev` or set `PORT` in `.env.local`.

## Connect a model and create an agent

1. Open **Habitats → Add models**.
2. For **Cloud AI**, choose a provider, enter its API key, discover models, choose one, and test/save it. An admin must enable cloud connections first. To make a connection available to a shared agent, select **Display name & sharing → Share with the team**.
3. For **Local models**, select your server type and **This computer** or **Another machine**. Enter its reachable API URL, choose **Check server & find models**, select a model, and test/save it.
4. Create an agent in Habitats. Set its name, instructions, access level, **Agent home**, and model. Models must belong to the selected home.
5. Open the agent's direct conversation or select it in a channel and send a message.

Common API addresses are `http://localhost:11434/v1` for Ollama, `http://localhost:1234/v1` for LM Studio, and `http://localhost:8000/v1` for vLLM. A remote server needs an address reachable from the Shoal host, such as `http://192.168.1.50:8000/v1`. In Docker, use `host.docker.internal` to reach the physical host. Start the server and load its model first.

Set **Advanced → Context window** to the window configured on your server. Shoal chooses the submitted context budget automatically within that limit. Quick conversations use up to 16,384 input tokens; Deep dive and Tasks use up to 65,536, with space reserved for responses and tools. Code execution and delegation require a model server that supports structured tool calling; model discovery alone does not establish that support.

Cloud API usage is billed by your provider. Saved connection keys are encrypted on the server. Agent model changes belong in Habitats; requests already submitted keep their selected model.

## Give agents company knowledge

Upload files in **Data** or attach them to a conversation. Shoal indexes text, Markdown, CSV/TSV, JSON, code, PDF text, and DOCX text. Wait for indexing to finish before asking questions about a new source. Scanned PDFs need OCR before upload.

Choose each source's **classification** and **human readers**. New sources allow agents whose access level and home satisfy that classification; explicit restrictions to named agents still apply. Human sharing is separate: Data uploads start private, channel uploads are shared with the workspace, and DM attachments are limited to that conversation's participants. Shared-channel answers use only workspace-shared sources. Local-only classifications cannot be sent to cloud agents.

Agents receive selected initial context and can search additional permitted documents and conversation history, read more of an authorized document, and ask you for missing information. Each retrieval rechecks permissions. To limit who can use an agent, open **Settings → Advanced workspace settings → Who can use agents**.

Keyword search works immediately. Embedding and reranking servers are optional connections under Local models. After changing the embedding model, reindex documents so their vectors use the same model.

### Database and Google Drive sources

In **Data → Databases**, connect PostgreSQL, MySQL/MariaDB, or SQLite using a read-only account. Select a table or view and columns, preview the data, set its classification and access, then import. Imports are manual snapshots capped at 5,000 rows and 10 MB; refresh them from the same connection. SQLite source files must be inside `SHOAL_SOURCES_DIR`, which defaults to `.shoal/sources`.

The Google Drive panel in Data imports selected files after sign-in. Configure an OAuth web client using `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a `GOOGLE_REDIRECT_URI` matching your workspace origin plus `/api/integrations/google/callback`. An admin must enable cloud access. Imported files follow the same source permissions as uploads.

## Let agents work on a project

Build the coding image once on the machine running Shoal's model runner, with Docker running:

```sh
docker build -f runner/Dockerfile.sandbox -t shoal-workspace:local .
```

The image includes Git, Node.js/npm, Python, shell utilities, and build tools. Quick, Deep dive, and Task runs can use it to inspect files, implement changes, run builds, and test their work. Deep dive and Tasks can delegate bounded assignments to workers and collaborate with permitted workspace agents.

Select **Task** beside **Deep dive**, or type `/task`, and state the goal. For example:

> Clone https://github.com/YOUR_TEAM/YOUR_PROJECT and implement CSV export for invoices. Follow the existing code style and run the relevant checks.

**Context, files & repository** holds optional requirements, a working directory, and repository settings. A public HTTPS repository URL in the goal is enough for an agent to request its checkout. For a private repository, add its URL and access token in the repository settings. If a running task asks for credentials, use **Connect repository** in its thread, then reply to continue.

Shoal checks out a separate `shoal/task_…` branch. When the run stops, use **Review changes**, enter a commit message, select **Commit changes**, then **Push task branch** when ready. Pushing sends the task branch; it does not merge it into the default branch. Repository tokens stay outside the agent sandbox. The current integration supports HTTPS token authentication with username `git`; SSH, automatic submodule checkout, and Git LFS downloads are not included.

### Working directories and networking

Set `SHOAL_WORKSPACE_ROOT` in `.env.local` to the parent directory for assigned projects. It defaults to `.shoal/workspaces`. A task can choose a relative directory such as `team/invoice-export`. Shoal creates a new directory when needed; attaching a nonempty directory requires an admin. Tasks cannot reserve overlapping directories. Leave the field blank to use storage scoped to the requester, agent, and conversation.

The assigned files appear at `/workspace` inside the container. That directory is writable; unrelated host directories, credentials, Docker sockets, and GPUs are not mounted. Defaults are two CPUs and 2 GB of memory; override them with `SHOAL_SANDBOX_CPUS` and `SHOAL_SANDBOX_MEMORY` if the project needs more resources.

Command networking starts disabled. To allow dependency installation and external searches, an admin enables **Agent → Execution settings → Allow network for commands** and enables workspace network access under **Settings → Advanced workspace settings → Network**. This allows general network access for that agent's commands. Public GitHub, GitLab, and Bitbucket checkout also requires cloud access; other public Git servers require the public-server setting.

If an agent needs a decision, the task shows **Needs input**. Reply in the same thread to continue with its existing files. If it reaches its tool limit, **Progress saved** marks a checkpoint that another reply can resume. Stopping a run preserves completed file changes.

## Use Shoal with your team

Run the production app over the built-in local HTTPS listener:

```sh
npm run build
npm run lan
```

Startup prints the HTTPS address, public CA certificate path, and fingerprint. HTTPS defaults to port 8443; the internal app stays on loopback port 3000. Trust the public `.shoal/tls/ca.crt` certificate on each client using that device's certificate settings. Share only the public certificate, never `ca.key` or `server.key`.

Set **Settings → Advanced workspace settings → Network → Team address** to the reachable HTTPS origin. Under **Settings → Team → Invite teammates**, choose a role and expiry and copy the invitation link. Each link enrolls one account; no email service is required.

| Role | Use |
| --- | --- |
| Owner | Full workspace administration, including assigning admins. |
| Admin | Manage agents, sources, models, members, invitations, devices, and terminal approvals. |
| Member | Message, use permitted agents and sources, upload files, and request terminal commands. |
| Viewer | Read permitted shared work without messaging or executing commands. |

For a stable host name or address, set `SHOAL_LAN_HOSTS=shoal.local,192.168.1.10` before starting. Allow the HTTPS port through the host's private-network firewall. An existing organizational HTTPS proxy can be used instead; preserve the public `Host` header and set `SHOAL_COOKIE_SECURE=1`.

One installation hosts one team. Channels are shared; DMs have participant access controls. The host operator can access underlying records and files, so this is not end-to-end encrypted storage or an unrelated-tenant hosting service.

## Deployment and storage

### Docker

After `npm run setup`:

```sh
docker compose up --build -d
docker compose logs -f shoal
```

The app is available on loopback port 3000. Workspace records and files persist in the `shoal-data` volume. For LAN HTTPS, put the physical host's address in `SHOAL_LAN_HOSTS` in `.env.local`, then run:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.lan.yaml up --build -d
docker compose cp shoal:/data/tls/ca.crt ./shoal-ca.crt
```

The web image does not provide a Docker daemon for agent coding. The host Node installation above is the simplest deployment for the full coding workflow. To use a containerized web app with code execution, run a separate trusted runner with Docker and shared workspace storage as described below.

### Configuration

See [.env.example](.env.example) for optional settings. Restart after editing `.env.local`.

| Setting | Purpose |
| --- | --- |
| `SHOAL_DATA_DIR` | Workspace database, uploaded files, TLS keys, and default agent workspaces; defaults to `.shoal`. |
| `SHOAL_SECRET_KEY` | Encrypts saved connection credentials. Preserve it with your backups. |
| `DATABASE_URL` | Optional PostgreSQL workspace database; otherwise SQLite is used. |
| `SHOAL_SOURCES_DIR` | Directory from which SQLite knowledge sources can be opened. |
| `SHOAL_WORKSPACE_ROOT` | Parent directory for assigned project folders. |
| `SHOAL_S3_BUCKET` | Enables S3-compatible uploaded-file storage. Set AWS credentials and region; optionally set `SHOAL_S3_ENDPOINT`. |
| `BUZZ_CONCURRENCY` | Maximum simultaneous primary runs on the model runner; defaults to 2. |

For PostgreSQL, set `DATABASE_URL` to an empty database using a role that can create and alter its tables, or start the supplied Compose profile:

```sh
export SHOAL_POSTGRES_PASSWORD='replace-with-a-long-random-password'
docker compose -f compose.yaml -f compose.postgres.yaml up --build -d
```

Changing the database URL or file-storage backend does not transfer existing data. Back up both records and files before changing storage.

### Backups and upgrades

Stop Shoal for a simple consistent SQLite backup. Copy `.env.local` and the entire data directory, including database journal files and TLS keys, to private backup storage. Also back up assigned directories outside the data directory. For Docker, back up the `shoal-data` volume. For PostgreSQL, use a database dump; for S3, back up the object bucket separately.

Keep the matching encryption key with the database. To upgrade, preserve configuration and data, replace the app source, run `npm ci` and `npm run build`, then restart. Startup applies versioned migrations. Do not delete the persistent volume during an upgrade.

## Additional execution options

### Separate model runner

Set `SHOAL_EXTERNAL_RUNNER=1` on the web host. On a trusted execution host, install this repository's dependencies and provide a private `.env.local` with `BUZZ_API` pointing to the workspace origin and the same `BUZZ_RUNNER_TOKEN`. Then run:

```sh
npm run runner
```

Build the sandbox image there if agents will code. Assigned directories and managed Git repositories must be mounted at the same absolute paths on the web host and runner; the runner's Docker daemon must also be able to mount them. A remote model server by itself does not require a separate runner.

### Human command terminal and paired devices

The **Terminal** page and `/run command` execute human-submitted commands on a selected device. Admins run directly; members need approval for the exact command, device, and directory. Enable or pause this under **Settings → Advanced workspace settings → Terminal**. These commands run with the device account's OS permissions; their starting directory is not a filesystem sandbox.

To pair another Mac/Linux execution device, register it under **Command devices**, create its working directory, and save the displayed credentials in a private `.env.device` on that machine. Copy the public CA certificate when using LAN HTTPS, then run `npm run device`. Only `scripts/device.mjs`, `runner/terminal.mjs`, and Node.js are needed on a terminal-only device; dependency installation is unnecessary. Keep its process running. Revoking a device disables its token and cancels outstanding jobs.

### Existing OpenClaw runtime

Native OpenClaw tools are an optional admin-only integration. Set `BUZZ_OPENCLAW_URL`, `BUZZ_OPENCLAW_TOKEN`, and `BUZZ_OPENCLAW_AGENT` on the web app and runner. In a local model connection's Advanced settings, select **OpenClaw agents and tools** and supply the runtime's `provider/model` identifier.

Run `npm run runtime:config` to generate the protected `.shoal/openclaw-models.json` provider entries, then merge them into your existing native configuration. That file contains credentials. Configure the native runtime's sandbox, tools, HTTP APIs, and session-control permissions separately. For the included context-handoff plugin, use `runner/install-context-handoff.sh` with the plugin's installed directory; the approval bridge's options are available with `python3 runner/shoal-approvals-bridge.py --help`. This integration does not install or upgrade OpenClaw.

## Useful commands and troubleshooting

Type `/` in a conversation for the command menu. `/connect` opens model setup, `/model` opens agent model settings, `/task` starts project work, `/search` searches permitted messages, and `/stop` stops the current run. `/terminal`, `/models`, and `/team` open their workspace sections.

| Problem | What to check |
| --- | --- |
| Cannot sign in after installation | Run `npm run setup`, restart, and use the printed setup code to create the first account. |
| Forgot a password | On the host, run `npm run account:reset -- username`. This generates a new password and revokes that account's sessions. |
| Model discovery or responses fail | Confirm the server is running, its API URL is reachable from Shoal, the model is loaded, and the context-window setting matches. |
| Agent cannot execute code | Start Docker and build `runner/Dockerfile.sandbox` on the runner host; confirm the model supports tools. |
| Dependency installation cannot connect | Enable both the agent's command network setting and workspace network access. |
| Assigned directory unavailable | Mount it at the same absolute path on the web host, runner, and Docker host. |
| A source is missing from answers | Check indexing status, human readers, classification, agent restrictions, and the conversation's audience. |
| An invitation does not open | Check the team address, certificate trust, network reachability, and invitation expiry. |
| A worker or runner disconnected | Inspect startup or Docker logs and completed task actions before retrying. |

For source changes, run `npm run typecheck` and `npm run build` to check the app. Production startup and task output provide the operational logs.

## License

Shoal is licensed under [Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled asset and dependency notices.
