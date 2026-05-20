# Deploy gmem-paywall publicly

Two-phase plan. Phase 1 is free, ships tonight. Phase 2 unlocks real USDC settlement, ships when you have a Coinbase CDP API key (~5 min signup).

| Phase | Network | Auth | Real $$ | Effort |
| ----- | ------- | ---- | ------- | ------ |
| 1 — testnet  | Base Sepolia + Solana devnet | none (x402.org/facilitator)               | no  | ~30 min |
| 2 — mainnet  | Base + Solana mainnet         | Coinbase CDP API key (free 1k tx/month)   | yes | ~10 min |

The Pi already has Cloudflare Tunnel + Caddy. We piggyback on that.

---

## Phase 1 — Testnet deploy on the Pi (~30 min)

### Step 1.1 — SSH in and clone

```bash
ssh -p 4588 yojinbot@100.109.137.47
cd ~
git clone https://github.com/yksanjo/gmem-paywall.git
cd gmem-paywall
```

### Step 1.2 — Install + build

```bash
npm install
npm run build
```

Note: better-sqlite3 will compile natively for ARM (Raspberry Pi). First build takes 1-2 min. If it errors, you may need `sudo apt install -y build-essential python3`.

### Step 1.3 — Create the .env

```bash
cp .env.example .env
nano .env
```

Set these values:

```
SVM_PAY_TO=4oACGWGh7zeWTHqESC8yxMXpn8x2TzKodUxkQ7MarfD3
FACILITATOR_URL=https://x402.org/facilitator
PORT=4021
GMEM_DB=/home/yojinbot/.gmem/paywall-memory.db
```

Leave `EVM_PAY_TO`, `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY` blank for now.

### Step 1.4 — Run under pm2 (so it survives reboots)

```bash
# Install pm2 if you don't have it
sudo npm install -g pm2

# Start gmem-paywall
pm2 start npm --name gmem-paywall -- start

# Save the process list so it restarts on reboot
pm2 save

# Set up the pm2 startup hook (one-time)
pm2 startup
# ↑ this prints a sudo command — copy and run it
```

Verify it's listening:

```bash
curl -s http://localhost:4021/ | head -2
# Expected: {"ok":true,"service":"gmem-paywall","version":"0.1.0"}

pm2 logs gmem-paywall --lines 20
# Should show: "gmem-paywall listening at http://localhost:4021"
```

### Step 1.5 — Wire it up to Caddy + Cloudflare Tunnel

Add this to your Caddyfile (probably at `/etc/caddy/Caddyfile`):

```caddy
paywall.musicailab.com {
    reverse_proxy localhost:4021
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
# OR if it's running differently:
# caddy reload --config /etc/caddy/Caddyfile
```

Then in your Cloudflare Tunnel config (at `~/.cloudflared/config.yml` or via the Cloudflare dashboard), add the route:

```yaml
ingress:
  - hostname: paywall.musicailab.com
    service: http://localhost:4021
  # ... your existing routes ...
```

Restart cloudflared:

```bash
sudo systemctl restart cloudflared
```

Add the DNS entry in Cloudflare:

```
Type:  CNAME
Name:  paywall
Value: <your-tunnel-id>.cfargotunnel.com
Proxy: on
```

### Step 1.6 — Smoke test from outside the Pi

```bash
# From any machine (not the Pi):
curl -s https://paywall.musicailab.com/ | head -2
# Expected: {"ok":true,"service":"gmem-paywall","version":"0.1.0"}

curl -s https://paywall.musicailab.com/v1/info | python3 -m json.tool
# Expected: pricing surface, payTo wallet, network info

# Confirm the 402 paywall is live:
curl -s -i -X POST https://paywall.musicailab.com/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}' \
  | head -20
# Expected: HTTP/2 402 + PAYMENT-REQUIRED header (base64-encoded x402 v2 requirements)
```

If all three pass, **Phase 1 is done**: the paywall is publicly accessible at `https://paywall.musicailab.com`, returns valid x402 v2 responses, and any client in the world can hit it. No real USDC moves yet — testnet facilitator only.

Tweet:

```
gmem-paywall live at https://paywall.musicailab.com

x402 paywall for AI agent memory. POST /v1/recall returns 402 with payment requirements pointing at my Solana wallet.

testnet for now — Coinbase CDP mainnet swap next.

github.com/yksanjo/gmem-paywall
```

---

## Phase 2 — Mainnet (real USDC settlement, ~10 min)

### Step 2.1 — Get a Coinbase CDP API key

1. Open https://portal.cdp.coinbase.com
2. Sign up / sign in
3. Click **API Keys** in the left sidebar
4. Click **Create API Key**
5. Name it `gmem-paywall-mainnet`
6. Permissions: **x402 facilitator only** (don't grant broader scopes)
7. Coinbase shows you the key once. Copy both:
   - **CDP_API_KEY_NAME** — looks like `organizations/.../apiKeys/...`
   - **CDP_API_KEY_PRIVATE_KEY** — multi-line PEM-format private key

Free tier: 1,000 transactions/month. Then $0.0001 per tx. You'll never hit this with self-testing.

### Step 2.2 — Update .env on the Pi

```bash
ssh -p 4588 yojinbot@100.109.137.47
cd ~/gmem-paywall
nano .env
```

Change:

```
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_NAME=organizations/.../apiKeys/...
CDP_API_KEY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

The private key is multi-line; nano handles this fine.

### Step 2.3 — Restart

```bash
pm2 restart gmem-paywall
pm2 logs gmem-paywall --lines 20
```

You should see in the logs:

```
gmem-paywall listening at http://localhost:4021
  facilitator: https://api.cdp.coinbase.com/platform/v2/x402
  svm payTo:   4oACGWGh7zeWTHqESC8yxMXpn8x2TzKodUxkQ7MarfD3
```

### Step 2.4 — Smoke test the mainnet 402 response

```bash
# From any machine:
curl -s -i -X POST https://paywall.musicailab.com/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}' \
  | grep -i "payment-required"
```

Decode the base64-encoded header value (Python one-liner):

```bash
echo "<paste the base64 string>" | base64 -d | python3 -m json.tool
```

You should see:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      "amount": "500",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "4oACGWGh7zeWTHqESC8yxMXpn8x2TzKodUxkQ7MarfD3",
      ...
    }
  ]
}
```

Two things to verify:

1. **Network is mainnet** — the `5eykt...` prefix is Solana mainnet's genesis hash (NOT `EtWT...` which is devnet).
2. **Asset is real USDC** — `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` is Solana mainnet USDC mint.

If both match, **Phase 2 is done**: the paywall is now demanding real USDC on Solana mainnet.

---

## Phase 3 — Make a real payment (~30 min, when you want proof)

This is the moment you have a real x402 transaction settled on Solana mainnet.

The cleanest path uses the `x402-solana` browser SDK + Phantom wallet:

1. Set up a tiny static HTML page somewhere (CodePen, Vercel, or just at `https://musicailab.com/paywall-test`)
2. Embed the `x402-solana` client SDK
3. Connect your Phantom wallet (with a small amount of USDC — $0.10 is plenty)
4. Make a POST to `https://paywall.musicailab.com/v1/recall`
5. The x402-solana client auto-handles the 402 → sign USDC transfer → retry
6. You get the recall response back; the USDC settles to your own wallet (you're paying yourself, but it's a real transaction)
7. Screenshot the Solscan link

Total round-trip: ~5 seconds. Total cost: $0.0005 + ~$0.00005 in SOL fees.

The reason to do this once: it's the moment you can post **"first real x402 transaction settled on gmem-paywall — Solscan link"** and have proof, not vapor.

I'll write the test page when you tell me you've shipped Phase 1 + 2.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `curl localhost:4021` works on Pi but not from outside | Cloudflare DNS not pointing at tunnel | Check Cloudflare DNS for `paywall.musicailab.com` |
| Server boots then crashes with `Facilitator getSupported failed (401)` | CDP_API_KEY env vars missing or wrong | Re-paste from Coinbase portal; the private key must include `-----BEGIN/END PRIVATE KEY-----` markers |
| `npm run build` fails on Pi with native compile errors | Missing build-essential | `sudo apt install -y build-essential python3 make g++` |
| 402 response missing PAYMENT-REQUIRED header | Express version mismatch | Run `npm install` again, ensure node v20+ |
| Caddy 502 errors | gmem-paywall not running | `pm2 status` then `pm2 restart gmem-paywall` |

---

## Files referenced

- `~/gmem-paywall/.env` (on the Pi, gitignored)
- `/etc/caddy/Caddyfile` (Pi-side Caddy config)
- `~/.cloudflared/config.yml` (Cloudflare Tunnel ingress)

## Status check commands (for future you)

```bash
ssh -p 4588 yojinbot@100.109.137.47 'pm2 status gmem-paywall && curl -s http://localhost:4021/v1/info | head -20'
```
