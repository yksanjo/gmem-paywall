/**
 * probe — smoke test the server WITHOUT a real wallet.
 *
 * Calls the free routes (/ and /v1/info), then calls a paid route with
 * NO X-Payment header and asserts a 402 response is returned with a
 * non-empty `accepts` array. Proves the paywall is wired correctly;
 * doesn't pay any actual USDC.
 *
 * Usage:
 *   npm run dev              # in another terminal
 *   npm run test:probe
 */
const BASE = process.env.PROBE_BASE ?? "http://localhost:4021";

async function main() {
  console.log(`Probing ${BASE}...`);

  const health = await fetch(`${BASE}/`);
  console.log(`  GET /         -> ${health.status}`);
  if (health.status !== 200) throw new Error("expected 200 from /");

  const info = await fetch(`${BASE}/v1/info`);
  const infoJson = await info.json() as { pricing: unknown; networks: { svm: { payTo: string } } };
  console.log(`  GET /v1/info  -> ${info.status}`);
  console.log(`     pricing:`, infoJson.pricing);
  console.log(`     svm payTo: ${infoJson.networks?.svm?.payTo}`);

  const recall = await fetch(`${BASE}/v1/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "test" }),
  });
  console.log(`  POST /v1/recall (no payment) -> ${recall.status}`);
  if (recall.status !== 402) throw new Error(`expected 402, got ${recall.status}`);
  // x402 protocol v2 carries payment requirements in the PAYMENT-REQUIRED
  // response header (base64-encoded JSON), not in the response body.
  const pr = recall.headers.get("payment-required") ?? recall.headers.get("PAYMENT-REQUIRED");
  if (!pr) throw new Error("expected PAYMENT-REQUIRED header in 402 response");
  const decoded = JSON.parse(Buffer.from(pr, "base64").toString("utf8")) as {
    x402Version: number;
    accepts: Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string }>;
  };
  console.log(`     x402Version: ${decoded.x402Version}`);
  console.log(`     accepts: ${JSON.stringify(decoded.accepts, null, 2)}`);
  if (!Array.isArray(decoded.accepts) || decoded.accepts.length === 0) {
    throw new Error("expected non-empty accepts[] in decoded PAYMENT-REQUIRED header");
  }
  if (decoded.x402Version !== 2) throw new Error(`expected x402 v2, got v${decoded.x402Version}`);
  const accept = decoded.accepts[0]!;
  if (!accept.network.startsWith("solana:")) throw new Error(`expected solana: network, got ${accept.network}`);
  if (accept.amount !== "500") throw new Error(`expected amount 500 ($0.0005), got ${accept.amount}`);

  const write = await fetch(`${BASE}/v1/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "Decision", entity: { title: "t", decision: "d", rationale: "r", date: "2026-05-18T00:00:00Z" } }),
  });
  console.log(`  POST /v1/write (no payment) -> ${write.status}`);
  if (write.status !== 402) throw new Error(`expected 402 from /v1/write, got ${write.status}`);

  const decisions = await fetch(`${BASE}/v1/decisions`);
  console.log(`  GET /v1/decisions (no payment) -> ${decisions.status}`);
  if (decisions.status !== 402) throw new Error(`expected 402 from /v1/decisions, got ${decisions.status}`);

  console.log("\n✅ probe passed: free routes 200, paid routes 402 with accepts[]");
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
