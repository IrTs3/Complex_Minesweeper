# Complex Minesweeper (复数扫雷)

**Complex Minesweeper** is a minesweeper variant where mines are complex numbers. Instead of the classic hint "N mines around this cell", every cell shows the **magnitude of the signed complex sum of its neighboring mines**:

```
hint = |Σz| = √(realSum² + imagSum²)
```

Mines come in four types — `+1`, `−1`, `+i`, `−i` — and they **cancel each other out**: a `+1` next to a `−1` sums to zero. This changes the game fundamentally: a *yellow 0* means "mines are here, but they cancel" — it is **not** a safe cell. Deduce the exact complex value of every mine and flag them correctly to win.

- **Platforms**: macOS (Apple Silicon) native, Windows x64 (cross-compiled on macOS), Linux, and the Web (TypeScript/Canvas)
- **Zero networking in the game itself**: no network stack, no telemetry, no runtime downloads (the optional *benchmark client* in `tools/` is a separate, explicitly opt-in networked tool — see below)
- **Cross-seed reproducibility**: the same seed string produces the bit-identical mine layout on every platform (custom RNG, verified by cross-platform parity tests)

🌐 **Web version**: the online deployment is **private by design** — it sits behind a password gate. If you'd like to play it, **contact the author (open a GitHub issue or reach me directly) for the gate URL and the key**. Desktop builds are published on GitHub Releases with a `SHA256SUMS` checksum file, and building from source is fully open.

> 📖 The authoritative, in-depth documentation (game rules, judging criteria, seed format, architecture) is the Chinese [`README.md`](README.md) and [`docs/项目结构说明.md`](docs/项目结构说明.md).

---

## The rules in 60 seconds

| Displayed | Meaning |
| --- | --- |
| *blank* | No mines at all in the neighborhood (only these cells chain-open) |
| **yellow 0** | Mines exist but cancel to zero — **not safe, will not chain** |
| `+2` / `−3` (blue) | Pure real sum (signed) |
| `+i` / `−3i` (green) | Pure imaginary sum (signed) |
| `√5`, `2√2`, `5` (purple) | Mixed sum, shown as a magnitude (phase hidden) |

Win conditions: open every safe cell (classic path), **or** flag every mine with correct complex types before finishing (the "deduction" path, with a lenient "magnitude mode" you can toggle). First click is always safe.

Difficulties: **9×9×12**, **16×16×40**, **24×16×72**, plus fully custom boards (3–24 × 3–24 × 1–99).

---

## Getting the game

### Option A — prebuilt installers

Grab the macOS `.dmg` / `.app.zip` or Windows `.zip` from **GitHub Releases**. Every release ships a `SHA256SUMS` file — verify before running.

### Option B — build from source

Requirements: C++20 compiler, CMake ≥ 3.15, SFML 3 (vendored in `third_party/`, checksum-verified tarballs).

```bash
# macOS
bash scripts/game/build.sh          # cmake configure + build -> ./build/

# Windows x64 (cross-compiled from macOS)
bash scripts/game/build_windows.sh  # MinGW-w64 toolchain, fully scripted
```

### Web version

```bash
cd web && ../node_modules/.bin/tsc   # plain TypeScript -> web/dist/, no runtime deps
```

---

## The distributed benchmark client (cmsdist)

The solver behind the game (`src/solver/SolverEngine.h`, a header-only exact-probability engine with a layered BucketDP) is **not** part of the game binary. To measure its true win rate on large samples we run a small volunteer computing grid, and you can join it.

### What it does

The client pulls a task (e.g. "play 500 games of Complex Hard, seed X"), runs the solver locally with a live terminal panel (per-game results, win rate, RAM, ETA), and uploads the aggregated result. Then it grabs the next task and keeps going. No registration, no configuration, no account.

### Run it

| Platform | Package | How to start |
| --- | --- | --- |
| macOS | `cmsdist-client-macOS.dmg` | Drag `dist-client` anywhere, right-click → Open (first time only), then run it from a terminal |
| Windows | `cmsdist-client-win64.zip` | **Extract fully**, then double-click `开始跑分.bat` (never run it inside the zip preview) |
| Linux | `cmsdist-client-linux64.tar.gz` | `tar xzf …`, then `./启动跑分.sh` |

Useful flags: `--detach` (background mode, log at `~/cmsdist-client.log`), `--status`, `--stop` (finish current task, upload, exit), `--server URL` (point at your own server).

### Trust model

- The game core has **no network code at all**; the client is a separate program you choose to install.
- Updates are **Ed25519-signed**: the manifest is signed as a whole, every file is checksummed against it, and verification failure means the update is discarded (fail-closed). The public key is embedded in your client — nobody but the packager can push updates.
- What leaves your machine: aggregate per-task results (win/loss per game, guess counts, timing, peak RAM), a self-chosen display name, and your IP (as seen by the server). No personal data, no files.
- `Ctrl+C` is graceful: finish the current task and upload before exiting; a second `Ctrl+C` returns the unfinished task to the queue immediately. Offline results are queued in `~/dist-pending/` and re-uploaded automatically.

### Self-hosting a server

```bash
python3 tools/dist_server.py serve [HOST] [PORT]   # default 0.0.0.0:7120
```

- Admin operations (queue management, kick, drop, cooldown) are **local CLI only** — there are no admin endpoints over HTTP.
- Hardened systemd unit in `server/cmsdist.service` (non-root, `ProtectSystem=strict`, `MemoryDenyWriteExecute`).
- Deploy guide: `scripts/dist/deploy-dist.sh` (opens the port in the firewall and installs the unit).

---

## Solver CLI (for research & statistics)

```bash
# build with optimizations (a Debug build is ~5x slower!)
cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
cmake --build build-release --target solver

# classic vs complex comparison, same boards & first clicks
./build-release/solver --diffs h --games 100 --seed 20261024 --model both --pergame

# custom board sizes (e.g. the classic 30×16×99 expert board)
./build-release/solver --board C30xR16xM99 --games 1000 --model classic
```

Notable measured results (budget ×1, honest solver — it never reads the mine array; forced-boom counter is pinned at 0 by self-test):

| Mode | Easy | Medium | Hard |
| --- | --- | --- | --- |
| Complex hints | 94.6% | 87.8% | **67.3%** |
| Classic counter (control) | 92.8% | 87.0% | 66.4% |

---

## Repository layout

```
src/core/       pure game logic (board, RNG, seeds) — zero platform APIs
src/desktop/    SFML 3 desktop front-end
src/solver/     exact-probability engine (header-only, not used in-game)
web/ts/         independent TypeScript web implementation
tools/          solver CLI, benchmark server/client, admin UIs, parity tests
scripts/        build / package / deploy scripts (game, dist, web)
server/         auth gateway & systemd units for the production site
docs/           design docs & benchmark reports (mostly Chinese)
third_party/    vendored SFML 3 + FreeType (checksummed tarballs)
```

The desktop and web front-ends are **two independent implementations** sharing the same spec: identical seeds produce identical boards everywhere, enforced by cross-platform parity tests (`tools/rngparity.cpp`, `web/test/rng-parity.mjs`, seed-parse parity suite).

---

## Security & privacy summary

- Game core: offline by construction; hand-written strict JSON parser for seeds (fail-closed, no NaN paths); all numeric seed fields saturate-clamped.
- Desktop app: picture imports pass header/size validation and decompression-bomb guards; settings files are symlink-checked before writes.
- Website: the deployment is deliberately **invite-only** — every request passes an auth gateway (nginx `auth_request` in front of a hardened `authd`: scrypt password table, constant-time compares, rate limiting, server-side revocation). Access = gate URL + key, given out personally by the author.
- Benchmark: signed updates, no admin surface over HTTP, per-IP task caps, lease-based task recovery.
- Nothing secret lives in this repository; release artifacts ship with SHA256 checksums.

## License

Dual-licensed:

- **MIT** — the repository as a whole (game, gate, admin tools, learning site, deployment scripts). See [LICENSE](LICENSE).
- **AGPL-3.0** — the minesweeper solver and its toolchain (`src/solver/`, `tools/solver.cpp`, `tools/nn/`, `assets/nn/`, `web/src/solver_api.cpp`, `web/ts/solverworker.ts`). Full text in [`src/solver/LICENSE`](src/solver/LICENSE). AGPL adds a network-interaction clause on top of GPL: hosting the solver as a service (e.g. a paid API) also requires offering its source to your users.

Third-party dependencies under `third_party/` and the bundled font keep their own licenses (zlib / FreeType License / libpng / SIL OFL 1.1). The background artwork and the app icon are **not** part of this repository; they are used under a separate non-commercial permission from their artist.
