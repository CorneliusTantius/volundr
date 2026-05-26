# völundr

Lightweight web harness for Pi coding agent.

## Install

### npm

Latest main:

```bash
npm install -g github:CorneliusTantius/volundr
```

Specific ref/tag/branch:

```bash
npm install -g github:CorneliusTantius/volundr#v0.1.0
```

### install.sh

Latest main:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | sh
```

Specific ref/tag/branch:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | sh -s -- v0.1.0
```

Or via env:

```bash
curl -fsSL https://raw.githubusercontent.com/CorneliusTantius/volundr/main/install.sh | VOLUNDR_VERSION=v0.1.0 sh
```

## Run

From directory you want Pi to operate in:

```bash
cd your-project
volundr
```

## CLI commands

Help:

```bash
volundr help
```

Version:

```bash
volundr version
```

Update latest main:

```bash
volundr update
```

Update specific tag/ref:

```bash
volundr update v0.1.0
```

Defaults:
- UI + API served from: `http://localhost:8787`
- working directory = current shell directory

## Dev

```bash
npm install
npm run dev
```

Dev URLs:
- Web: `http://localhost:5173`
- API/SSE: `http://localhost:8787`

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
- built-in Pi tools come from Pi defaults
- current directory is passed as `VOLUNDR_CWD`
- install.sh currently installs from GitHub repo, not npm registry
- Node `>= 22.19.0` required
