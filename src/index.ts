/**
 * gmem-paywall — x402 paywall server for hosted gmem.
 *
 * Wraps a gmem MCP server's tool surface behind HTTP 402 Payment Required.
 * Every paid request settles in USDC on Solana mainnet (or Base, if EVM
 * payout is configured), routed through the Coinbase CDP facilitator.
 *
 * Routes:
 *   GET  /                         free          health check
 *   GET  /v1/info                  free          server metadata
 *   POST /v1/recall                $0.0005 USDC  ranked recall query
 *   GET  /v1/decisions             $0.0005 USDC  list all Decision entries
 *   POST /v1/write                 $0.001  USDC  append a typed entity
 *
 * The underlying gmem instance is *separate* from the agent's local memory.
 * This server hosts a public, paid memory tier — useful for shared team
 * knowledge bases or for letting agents bootstrap context for a token spend.
 */
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

config();

const svmPayTo = process.env.SVM_PAY_TO?.trim();
const evmPayTo = process.env.EVM_PAY_TO?.trim();
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();
const port = Number(process.env.PORT ?? 4021);

if (!svmPayTo) {
  console.error("ERROR: SVM_PAY_TO is required. Set it in .env to a Solana address that will receive USDC.");
  process.exit(1);
}
if (!facilitatorUrl) {
  console.error("ERROR: FACILITATOR_URL is required. Use https://api.cdp.coinbase.com/platform/v2/x402 (Coinbase CDP) for mainnet, or https://x402.org/facilitator for testnet.");
  process.exit(1);
}

/* ─── Networks ─────────────────────────────────────────────────────────
 * CAIP-2 network identifiers per x402 protocol v2 spec.
 * The literal suffix after `solana:` / `eip155:` is the genesis-hash
 * prefix Coinbase's facilitator uses to distinguish mainnet from devnet.
 */
const SOLANA_MAINNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const BASE_MAINNET = "eip155:8453" as const;

/* ─── Pricing ──────────────────────────────────────────────────────────
 * Sub-cent prices are the whole point of x402 — pricing reads at $0.0005
 * makes them feel free at the per-call level but compounds at agent volume.
 */
const PRICE_RECALL = "$0.0005";
const PRICE_DECISIONS = "$0.0005";
const PRICE_WRITE = "$0.001";

type Caip2 = `${string}:${string}`;
interface PaymentAccepts {
  scheme: "exact";
  price: string;
  network: Caip2;
  payTo: string;
}

function buildAccepts(price: string): PaymentAccepts[] {
  const out: PaymentAccepts[] = [
    { scheme: "exact", price, network: SOLANA_MAINNET, payTo: svmPayTo! },
  ];
  if (evmPayTo) {
    out.push({ scheme: "exact", price, network: BASE_MAINNET, payTo: evmPayTo });
  }
  return out;
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(SOLANA_MAINNET, new ExactSvmScheme());
if (evmPayTo) resourceServer.register(BASE_MAINNET, new ExactEvmScheme());

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ─── Paywall middleware ─────────────────────────────────────────────── */
app.use(
  paymentMiddleware(
    {
      "POST /v1/recall": {
        accepts: buildAccepts(PRICE_RECALL),
        description: "gmem recall — ranked BM25 search over typed memory entities",
        mimeType: "application/json",
      },
      "GET /v1/decisions": {
        accepts: buildAccepts(PRICE_DECISIONS),
        description: "gmem list_decisions — newest-first project decision log",
        mimeType: "application/json",
      },
      "POST /v1/write": {
        accepts: buildAccepts(PRICE_WRITE),
        description: "gmem write — persist a typed memory entry (Program/Account/Instruction/Decision/Finding/Integration/Contract)",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

/* ─── Free routes ──────────────────────────────────────────────────────
 * GET /        — health check, used by uptime monitors
 * GET /v1/info — metadata + pricing surface, so an agent can decide
 *                whether to pay before issuing a 402 dance.
 */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "gmem-paywall", version: "0.1.0" });
});

app.get("/v1/info", (_req, res) => {
  res.json({
    service: "gmem-paywall",
    version: "0.1.0",
    backend: "@yksanjo/gmem",
    transport: "http-x402",
    pricing: {
      "POST /v1/recall": PRICE_RECALL,
      "GET /v1/decisions": PRICE_DECISIONS,
      "POST /v1/write": PRICE_WRITE,
    },
    networks: {
      svm: { caip2: SOLANA_MAINNET, payTo: svmPayTo },
      evm: evmPayTo ? { caip2: BASE_MAINNET, payTo: evmPayTo } : null,
    },
    docs: "https://github.com/yksanjo/gmem-paywall",
  });
});

/* ─── Paid routes ───────────────────────────────────────────────────── */

// Lazy-loaded gmem Store so the import cost only hits the first paid request.
let storeP: Promise<import("./gmem-store.js").GmemHost> | null = null;
function getStore() {
  if (!storeP) storeP = import("./gmem-store.js").then((m) => m.openHost());
  return storeP;
}

app.post("/v1/recall", async (req, res) => {
  try {
    const host = await getStore();
    const body = req.body as { query?: string; kinds?: string[]; limit?: number };
    if (typeof body.query !== "string" || body.query.length === 0) {
      return res.status(400).json({ ok: false, error: "body.query must be a non-empty string" });
    }
    const results = host.recall(body.query, body.kinds as any[] | undefined, Number(body.limit ?? 10));
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.get("/v1/decisions", async (req, res) => {
  try {
    const host = await getStore();
    const limit = Number((req.query.limit as string) ?? 50);
    res.json({ ok: true, decisions: host.listDecisions(limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.post("/v1/write", async (req, res) => {
  try {
    const host = await getStore();
    const body = req.body as { kind?: string; entity?: Record<string, unknown> };
    if (!body.kind || !body.entity) {
      return res.status(400).json({ ok: false, error: "body.kind and body.entity are required" });
    }
    const result = host.write(body.kind as any, body.entity);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.listen(port, () => {
  console.log(`gmem-paywall listening at http://localhost:${port}`);
  console.log(`  facilitator: ${facilitatorUrl}`);
  console.log(`  svm payTo:   ${svmPayTo}`);
  if (evmPayTo) console.log(`  evm payTo:   ${evmPayTo}`);
  console.log(`  free routes: /, /v1/info`);
  console.log(`  paid routes: POST /v1/recall (${PRICE_RECALL}), GET /v1/decisions (${PRICE_DECISIONS}), POST /v1/write (${PRICE_WRITE})`);
});
