# LLM Traces — Grafana Plugin

[![CI](https://github.com/ThecaSystems/llm-traces/actions/workflows/ci.yml/badge.svg)](https://github.com/ThecaSystems/llm-traces/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A Grafana app plugin for visualizing LLM (Large Language Model) traces stored in [Grafana Tempo](https://grafana.com/oss/tempo/). This is Theca Systems' public fork of [Agoda's llm-traces](https://github.com/agoda-com/llm-traces).

Supports multiple span conventions out of the box:

- **OpenInference** (Phoenix, Traceloop, etc.)
- **OTel GenAI** ([OpenTelemetry Semantic Conventions for GenAI](https://github.com/open-telemetry/semantic-conventions-genai/tree/e57c543b4889619eb2a05702471937db5119165d), as of commit `e57c543b`)
- **Vertex AI** (GCP Vertex AI Agent Builder)

## Features

- Browse and search LLM traces via TraceQL
- Inspect input/output messages with Markdown rendering
- View tool calls with JSON payloads
- Multi-convention detection tabs (LLM / OpenInference / OTel GenAI)
- Token usage and estimated cost per span
- Trace timeline with span hierarchy visualization
- Resizable detail panels

<img src="docs/images/llm-traces-screenshot.png" alt="LLM Traces plugin showing trace list, span timeline with duration bars, and LLM span detail with input/output messages" width="100%">

OTel GenAI spans use `gen_ai.operation.name` and `gen_ai.provider.name`. Optional
`gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions`
are read as schema-defined `role`/`parts` content (JSON strings or structured
attributes). Text, reasoning, tool calls/results, and media placeholders are
shown without rendering raw binary data. Agent, tool, workflow, embedding,
retrieval, and memory operations remain visible without counting as model
inference. Older OpenInference, Vertex, and pre-standard GenAI data still render.

## Requirements

| Component | Version |
|-----------|---------|
| Grafana | &ge; 11.1.0 |
| Node.js | &ge; 22.6 (for development) |
| A configured [Tempo](https://grafana.com/docs/tempo/latest/) datasource | |

## Installation

### From GitHub Releases (recommended)

1. Download the latest release zip from the [Releases](https://github.com/ThecaSystems/llm-traces/releases) page
2. Extract it into your Grafana plugins directory:
   ```bash
   unzip llm-traces-app-*.zip -d /var/lib/grafana/plugins/
   ```
3. Add the plugin to Grafana's allow list (required for unsigned community plugins):
   ```ini
   [plugins]
   allow_loading_unsigned_plugins = llm-traces-app
   ```
4. Restart Grafana

### Using Docker Compose

A ready-to-run stack with Grafana + Tempo is included for local development:

```bash
# Build the plugin first
npm install && npm run build:standalone

# Start the stack (run from repo root)
docker compose -f docker/docker-compose.yml up --build
```

Open **http://localhost:3000** (admin / admin). Tempo OTLP endpoints are available at `localhost:4317` (gRPC) and `localhost:4318` (HTTP).

> Requires Docker Compose v2.17+ for `dockerfile_inline` support.

### Using provisioning

To auto-enable the plugin (Grafana app plugins must be explicitly enabled):

```yaml
# /etc/grafana/provisioning/plugins/llm-traces.yaml
apiVersion: 1
apps:
  - type: llm-traces-app
    org_id: 1
    disabled: false
```

## Usage

1. Navigate to **LLM Traces** in the Grafana side menu
2. Select a Tempo datasource
3. Use the search bar or [TraceQL](https://grafana.com/docs/tempo/latest/traceql/) to find traces
4. Click a trace to see the full span hierarchy
5. Click an LLM span to inspect messages, parameters, and token usage

## Development

```bash
# Install dependencies (also sets up pre-commit hook via Husky)
npm install

# Build (standalone — no Grafana monorepo needed)
npm run build:standalone

# Run all unit tests
npm test

# Run individual test files
node --experimental-strip-types tests/llmUtils.unit.test.ts
node --import ./tests/node-loader.mjs --experimental-strip-types tests/tempoClient.unit.test.ts
node --experimental-strip-types tests/costUtils.unit.test.ts
node --experimental-strip-types tests/prism-traceql.unit.test.ts

# Lint & typecheck
npm run typecheck
npm run lint
```

> **Note:** Node.js >= 22.6 is required for the `--experimental-strip-types` flag used by the test runner and build scripts.

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed contribution guidelines.

## License

[Apache-2.0](LICENSE)

Copyright 2026 Agoda Services Co., Ltd. (original work). Theca Systems modifications are also licensed under Apache-2.0.
