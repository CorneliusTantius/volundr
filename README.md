# völundr

Lightweight web harness for Pi coding agent.

## Install

### npm

Latest main:

```bash
npm install -g @earendil-works/pi-coding-agent github:CorneliusTantius/volundr
pi install git:github.com/CorneliusTantius/pi-tincan
```

Specific ref/tag/branch:

```bash
npm install -g @earendil-works/pi-coding-agent github:CorneliusTantius/volundr#v1.0.0
pi install git:github.com/CorneliusTantius/pi-tincan
```

Note: direct GitHub npm install may fail on some systems because this repo needs a build step. `install.sh` is recommended. `@earendil-works/pi-coding-agent` provides the `pi` CLI used by `pi install`.

### install.sh

Installs `volundr` globally and installs Pi package `pi-tincan`.

Latest main:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | sh
```

Specific ref/tag/branch:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | sh -s -- v1.0.0
```

Or via env:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | VOLUNDR_VERSION=v1.0.0 sh
```

## Run

From directory you want Pi to operate in:

```bash
cd your-project
volundr
```

Default behavior:
- starts in background
- terminal stays usable
- prints server id, URL, PID, cwd
- track active servers with `volundr status`

## CLI commands

Help:

```bash
volundr help
```

Version:

```bash
volundr version
```

Status:

```bash
volundr status
```

Stop server:

```bash
volundr stop 1
```

Restart server:

```bash
volundr restart 1
```

Update latest main:

```bash
volundr update
```

Update specific tag/ref:

```bash
volundr update v1.0.0
```

Defaults:
- UI + API served from: `http://localhost:8787`
- if `8787` busy, server auto-increments to next free port
- working directory = current shell directory

Port control:
- fixed port: `PORT=9000 volundr`
- fixed port: `VOLUNDR_PORT=9000 volundr`
- random free port: `PORT=0 volundr`
- restart tries same port first; if busy, falls back to next free port

## Dev

```bash
npm install
npm run dev
```

Dev URLs:
- Web: `http://localhost:5173`
- API/SSE: `http://localhost:8787` default, auto-increments if busy

## Build

```bash
npm run build
```

Build output:
- web SPA -> `apps/web/dist`
- server -> `apps/server/dist`

## Features

- single-page web harness
- Pi transcript + streaming
- sessions sidebar
- background live session switching
- model selection
- thinking level selection
- collapsible tool groups/results
- markdown rendering
- tincan stats rail

## Notes

- packaged CLI serves built SPA directly from server
- built-in Pi tools come from Pi defaults + installed `pi-tincan` package
- current directory is passed as `VOLUNDR_CWD`
- install.sh clones repo, installs deps, builds locally, packs tarball, then installs globally
- install.sh installs `pi-tincan` via `pi install git:github.com/CorneliusTantius/pi-tincan`
- set `VOLUNDR_INSTALL_PI_TINCAN=0` to skip `pi-tincan` install
- set `PI_TINCAN_SOURCE=git:github.com/CorneliusTantius/pi-tincan@<ref>` to pin/update source
- install.sh currently installs from GitHub repo, not npm registry
- if a broken old global `volundr` symlink exists, install.sh removes it first
- Node `>= 22.19.0` required
