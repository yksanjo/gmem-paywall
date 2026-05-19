# gmem-paywall

**Sells AI-agent project memory as a paid API. USDC on Solana mainnet, per-call sub-cent pricing, no signups.**

This is the x402-gated paywall sibling to [gmem](https://github.com/yksanjo/gmem) (MIT,
free, local-first). gmem-paywall hosts a public-facing gmem instance behind
HTTP 402 Payment Required — every paid request settles a small USDC payment to
the operator's wallet via the [x402 protocol](https://www.x402.org/) and the
[Coinbase CDP](https://docs.cdp.coinbase.com/x402/welcome) (or any compatible)
facilitator.

## Why this exists

gmem (the local server) gives one developer typed project memory. Some workflows
want **shared memory across machines or agents** — team knowledge bases, paid
public memory tiers, or agents bootstrapping context. Self-hosting a synchronized
gmem and gating it behind x402 is the simplest path: no accounts, no API keys,
agents pay $0.0005 per recall and the work is done.

## What it ships

| Route                  | Free? | Price       | Purpose                                                            |
| ---------------------- | ----- | ----------- | ------------------------------------------------------------------ |
| `GET /`                | ✅    | —           | health check                                                       |
| `GET /v1/info`         | ✅    | —           | server metadata + pricing surface (lets agents decide before pay) |
| `POST /v1/recall`      | 💵    | $0.0005     | ranked BM25 search over the hosted memory                          |
| `GET /v1/decisions`    | 💵    | $0.0005     | newest-first list of `Decision` entries                            |
| `POST /v1/write`       | 💵    | $0.001      | append a typed entity (Program / Account / Decision / etc.)        |

Every paid response settles a USDC transfer to the operator's Solana wallet. The
facilitator pays the SOL fee — clients only need USDC.

## Run it

```bash
git clone https://github.com/yksanjo/gmem-paywall.git
cd gmem-paywall
npm install
cp .env.example .env
# Edit .env: at minimum SVM_PAY_TO must be your Solana payout address.

npm run dev          # tsx watch mode for development
# OR
npm run build && npm start
```

By default this points at the public testnet facilitator (`x402.org/facilitator`,
Base Sepolia + Solana devnet) — useful for development. Swap to
`https://api.cdp.coinbase.com/platform/v2/x402` for mainnet (Coinbase CDP, free
first 1k tx/month).

## Smoke test (no real wallet needed)

```bash
npm run dev                    # in one terminal
PROBE_BASE=http://localhost:4021 npm run test:probe
```

The probe asserts:
- Free routes return 200
- Paid routes return 402 with a `PAYMENT-REQUIRED` header carrying x402 v2
  payment requirements
- The requirements point at your configured Solana payout address
- The configured price ($0.0005 = 500 USDC micro-units) round-trips correctly

If the probe passes, the paywall is wired. Real client payments need a USDC
balance and the [x402-svm](https://www.npmjs.com/package/x402-solana) client
SDK (or any conforming x402 client).

## Architecture

```
agent (any x402 client)
  │
  ▼
gmem-paywall  ◄── @x402/express middleware
  │              ├─ issues 402 with payment requirements
  │              ├─ extracts X-Payment header on retry
  │              └─ calls facilitator to verify + settle
  │
  ├──► facilitator (Coinbase CDP or x402.org)
  │       └─ on-chain USDC settlement on Solana mainnet
  │
  └──► local gmem Store (SQLite + FTS5 BM25)
```

## Configuration

| Env var                     | Required | Default                                    | Notes                                          |
| --------------------------- | -------- | ------------------------------------------ | ---------------------------------------------- |
| `SVM_PAY_TO`                | yes      | —                                          | Solana address receiving USDC                  |
| `EVM_PAY_TO`                | no       | (disabled)                                 | EVM address for Base settlement                |
| `FACILITATOR_URL`           | yes      | `https://x402.org/facilitator`             | Testnet default; swap for mainnet (see below) |
| `CDP_API_KEY_NAME`          | conditional | —                                       | Required iff using Coinbase CDP                |
| `CDP_API_KEY_PRIVATE_KEY`   | conditional | —                                       | Same                                           |
| `PORT`                      | no       | `4021`                                     |                                                |
| `GMEM_DB`                   | no       | `~/.gmem/<hash>/memory.db`                 | Override memory db path                        |

### Going to mainnet

1. Sign up at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
2. Create an x402 API key
3. Set in `.env`:
   ```
   FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
   CDP_API_KEY_NAME=organizations/.../apiKeys/...
   CDP_API_KEY_PRIVATE_KEY=...
   ```
4. Restart. Same routes; payments now flow through Coinbase's mainnet facilitator.

## Pricing rationale

Sub-cent prices ($0.0005, $0.001) are the whole point of x402. At $0.0005 per
read, a busy agent doing 100k recalls/month costs $50 — well below the
$200+ subscription bar that locks individual developers out. At the same
volume the operator (you) makes $50/month with zero operational cost beyond
the gmem db.

Volume to break even on operational overhead (a $5/mo VPS + a Coinbase CDP
spend over the free tier): ~10k paid requests/month. Realistic at modest
agent adoption.

## Relation to gmem

`gmem-paywall` consumes [`@yksanjo/gmem`](https://www.npmjs.com/package/@yksanjo/gmem)
as an npm dependency. The gmem core stays MIT-licensed and free. This paywall
is an *operator-facing* product — the gmem spec itself is unaffected. Anyone
can run gmem-paywall themselves; nobody is locked into this hosted instance.

## License

MIT.
