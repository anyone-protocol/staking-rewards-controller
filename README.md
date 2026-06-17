# Staking Rewards Controller

A [NestJS](https://nestjs.com/) service that drives **staking reward rounds** for the
[ANYONE Protocol](https://anyone.io). On a fixed cadence it gathers the inputs needed to
score operators — relay health, on-chain stakes/locks, and operator verification — and feeds
those scores into the on-chain (AO) **staking rewards** process, which computes the reward
token amounts that hodlers can later claim. It also archives a snapshot and a summary of each
round permanently to Arweave.

This service is the *off-chain controller*: it does not pay out rewards itself. It is
responsible for **assembling and submitting the per-round inputs**; the AO staking rewards
process is the source of truth for reward accrual.

## How a round works

A round runs every `ROUND_PERIOD_SECONDS` (1h in live, 15m in stage). Each round is
orchestrated as a chain of BullMQ jobs:

1. **`start-distribution`** — gather inputs and compute scores:
   - Fetch relay details from **Onionoo** (`ONIONOO_DETAILS_URI`).
   - Read hodler **stakes and locks** from the **HODLER** EVM contract via `ethers`.
   - Read the **Operator Registry** state from its AO process (verified
     fingerprint → operator address, plus hardware-verified fingerprints).
   - For each operator, compute a *running share* (healthy, running, sufficiently-weighted
     relays ÷ expected relays) and emit a per-hodler/operator score weighted by stake.
   - Upload a `staking/snapshot` artifact to Arweave.
   - Group the scores into batches and fan out `add-scores` child jobs.
2. **`add-scores`** — send each batch to the AO staking rewards process as an `Add-Scores`
   message.
3. **`complete-round`** — once all batches are in, send `Complete-Round` to the AO process so
   it tallies the round.
4. **`persist-last-round`** — read the completed round's snapshot back from the AO process and
   upload a `staking/summary` artifact to Arweave.

Round timing/state (started/complete/persisted) is tracked in MongoDB so a restarted instance
resumes correctly rather than starting a duplicate round.

> `IS_LIVE` gates all external writes. When it is not `"true"`, the service runs the full
> computation but **skips** Arweave uploads and AO messages (logging `NOT LIVE: ...`), which
> is useful for local/dry runs.

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │          staking-rewards-controller          │
                         │                  (NestJS)                    │
   Onionoo ──details──▶  │  DistributionService ── scoring & batching   │
   HODLER (EVM) ─stake─  │  StakingRewardsService ── ethers + AO msgs   │  ──Add-Scores──▶  AO staking rewards process
   Operator Registry ──▶ │  OperatorRegistryService ── AO dryrun        │  ──Complete-Round▶ AO staking rewards process  
   (AO)                  │  BundlingService ── ArDrive Turbo            │                    
                         │  TasksService + BullMQ processors            │  ──snapshot/summary▶ Arweave
                         │  ClusterService ── Consul leader election    │
                         └───────────────┬──────────────┬───────────────┘
                                         │              │
                                    Redis (BullMQ)   MongoDB (round state)
```

### Components (`src/`)

| Module | Responsibility |
| --- | --- |
| `tasks/` | Schedules rounds and defines the BullMQ queues/flow. `tasks-queue` re-arms the timer; `distribution-queue` runs the round job chain. |
| `distribution/` | Core round logic: fetch relays, compute the running-share/stake-weighted scores, build batches, and trigger snapshot/summary uploads. |
| `staking-rewards/` | Talks to the HODLER EVM contract (stakes/locks) and to the AO staking rewards process (`Add-Scores`, `Complete-Round`, `Last-Snapshot`). |
| `operator-registry/` | Reads operator-registry state from its AO process (fingerprint verification). |
| `bundling/` | Uploads JSON artifacts to Arweave via the ArDrive Turbo SDK. |
| `cluster/` | Multi-process startup (Node `cluster`) plus Consul-based leader election so only one instance drives rounds. |
| `util/` | AO messaging helpers (`@permaweb/aoconnect`), Ethereum data-item signing, and a vendored `arbundles-lite` for signing. |

### Infrastructure

- **Redis** — backs BullMQ queues and the flow producer. Supports `standalone` and `sentinel`
  modes (`REDIS_MODE`).
- **MongoDB** — stores per-round `TaskServiceData` (timing/completion state).
- **Consul** — leader election across instances (`clusters/<service>/leader` key + session
  TTL). When `IS_LIVE` is not `true` or Consul is unconfigured, the service runs as a single
  node leader.
- **Node `cluster`** — `CPU_COUNT` controls worker forking; worker 0 is the *local leader* and
  the only one eligible to drive rounds.
- Exposes `GET /` and `GET /health` returning `OK` (used by the Nomad health check).

## Development

Prerequisites: Node.js (see the Dockerfile for the target runtime) and Docker for Redis/Mongo.

1. **TLS CA cert** (for the admin UI / authenticated endpoints):
   `export NODE_EXTRA_CA_CERTS=$(pwd)/admin-ui-ca.crt`
2. **Redis**: `docker run --name validator_dev_redis -p 6379:6379 redis:7.2`
3. **MongoDB**: `docker run --name validator_dev_mongo -p 27017:27017 mongo:5.0`
4. **Install deps**: `npm install`
5. **Configure**: create a `.env` with at least the variables marked *required for local* in
   the table below. Keep `IS_LIVE` unset/false so no external writes happen.
6. **Test**: `npm test` (or `npm run test:watch`)
7. **Run**: `npm run start:dev`

A `docker-compose.yml` is also provided that builds the service alongside Mongo and Redis.

### Scripts

| Script | Description |
| --- | --- |
| `npm run start:dev` | Run with watch mode. |
| `npm run start:prod` | Run the built output (`dist/main`). |
| `npm run build` | Compile with the Nest CLI. |
| `npm test` / `test:watch` / `test:cov` | Jest unit tests (`*.spec.ts`). |
| `npm run lint` / `npm run format` | ESLint (fix) / Prettier. |

## Configuration

All configuration is via environment variables (loaded through `@nestjs/config`). In
deployment these come from the Nomad job specs in [`operations/`](operations/) — Consul KV for
addresses, Vault for secrets.

### Core

| Variable | Description |
| --- | --- |
| `IS_LIVE` | `"true"` enables all external writes (Arweave uploads + AO messages). Anything else = dry run. |
| `PORT` | HTTP port for the health endpoint (default `3000`). |
| `VERSION` | Build/version string, logged at startup. |
| `ROUND_PERIOD_SECONDS` | Minimum seconds between rounds (e.g. `3600` live, `900` stage). |
| `DO_CLEAN` | `"true"` obliterates the queues and clears stored round state on leader bootstrap. |
| `MIN_HEALTHY_CONSENSUS_WEIGHT` | Minimum relay consensus weight to count as "running" (e.g. `50`). |

### Redis (BullMQ)

| Variable | Description |
| --- | --- |
| `REDIS_MODE` | `standalone` (default) or `sentinel`. |
| `REDIS_HOSTNAME` / `REDIS_PORT` | Host/port in standalone mode. |
| `REDIS_MASTER_NAME` | Sentinel master name (sentinel mode). |
| `REDIS_SENTINEL_{1,2,3}_HOST` / `_PORT` | Sentinel endpoints (sentinel mode). |

### Datastores & service discovery

| Variable | Description |
| --- | --- |
| `MONGO_URI` | MongoDB connection string for round state. **Required locally.** |
| `CONSUL_HOST` / `CONSUL_PORT` | Consul agent for leader election. Omit to run single-node. |
| `CONSUL_SERVICE_NAME` | Service name used to build the leader-election KV key. |
| `CONSUL_TOKEN_CONTROLLER_CLUSTER` | Consul ACL token. |
| `CPU_COUNT` | Number of worker processes to fork (Node `cluster`). |
| `IS_LOCAL_LEADER` | Marks the local-leader worker; only it drives rounds (set automatically when not parallelizing). |

### Data sources

| Variable | Description |
| --- | --- |
| `ONIONOO_DETAILS_URI` | Onionoo `/details` endpoint for relay data. **Required for scoring.** |
| `DETAILS_URI_AUTH` | Optional `Authorization` header value for the details endpoint. |
| `ANYONE_API_URL` | ANYONE API base URL. |

### EVM / HODLER contract

| Variable | Description |
| --- | --- |
| `EVM_JSON_RPC` | JSON-RPC endpoint (mainnet live / Sepolia stage). **Required.** |
| `HODLER_CONTRACT_ADDRESS` | Address of the HODLER contract (stakes/locks source). |
| `STAKING_REWARDS_CONTROLLER_KEY` | EVM/Ethereum private key used to sign AO messages to the staking rewards process. **Secret.** |

### AO processes

| Variable | Description |
| --- | --- |
| `STAKING_REWARDS_PROCESS_ID` | AO process ID for the staking rewards process (`Add-Scores`, `Complete-Round`, `Last-Snapshot`). |
| `OPERATOR_REGISTRY_PROCESS_ID` | AO process ID for the operator registry (`View-State`). |
| `CU_URL` | AO Compute Unit URL used by `@permaweb/aoconnect`. |

### Arweave bundling (ArDrive Turbo)

| Variable | Description |
| --- | --- |
| `BUNDLER_CONTROLLER_KEY` | Private key the bundler signs uploads with. **Secret.** |
| `BUNDLER_NODE` | Turbo upload service URL. |
| `BUNDLER_GATEWAY` | Arweave gateway URL. |
| `BUNDLER_NETWORK` | Bundler network identifier. |

## Deployment

The service is containerized ([`Dockerfile`](Dockerfile), published to
`ghcr.io/anyone-protocol/staking-rewards-controller`) and deployed with Nomad. Job specs live
in [`operations/`](operations/):

- `staking-rewards-controller-live.hcl` / `-stage.hcl` — the service jobs (2 instances each,
  Consul leader election, Vault secrets, `/health` check).
- `staking-rewards-controller-redis-sentinel-{live,stage}.hcl` — the Redis Sentinel clusters.

Live runs against Ethereum mainnet; stage runs against Sepolia.

## License

[AGPL-3.0-only](LICENSE)
