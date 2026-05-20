#!/usr/bin/env bash
#
# deploy-pi.sh — one-shot Phase 1 deploy of gmem-paywall on a Raspberry Pi.
#
# Usage from the Pi (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/yksanjo/gmem-paywall/main/scripts/deploy-pi.sh | bash
#
# Env var overrides (all optional):
#   SVM_PAY_TO   Solana address that receives USDC. Defaults to Yoshi's wallet.
#   PORT         Localhost port the server listens on. Defaults to 4021.
#
# What this script does:
#   1. Checks prereqs (node, npm, sudo)
#   2. Installs pm2 globally if missing
#   3. Clones or pulls the gmem-paywall repo to ~/gmem-paywall
#   4. Runs npm install + build (auto-installs ARM build tools if needed)
#   5. Writes ~/gmem-paywall/.env with testnet defaults (Phase 1)
#   6. Starts or restarts gmem-paywall under pm2
#   7. Smoke-tests localhost:4021 (health + /v1/info + /v1/recall 402)
#   8. Prints the manual next steps for Caddy + Cloudflare wiring
#
# What this script does NOT do (you do these manually after, because they
# touch your existing infrastructure):
#   - Modify the Caddyfile (you have other services on it)
#   - Modify ~/.cloudflared/config.yml
#   - Create the Cloudflare DNS record
#   - Swap to mainnet facilitator (that's Phase 2)

set -euo pipefail

REPO="https://github.com/yksanjo/gmem-paywall.git"
DIR="$HOME/gmem-paywall"
PORT="${PORT:-4021}"
PAY_TO="${SVM_PAY_TO:-4oACGWGh7zeWTHqESC8yxMXpn8x2TzKodUxkQ7MarfD3}"

step() { printf "\n▸ %s\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*" >&2; exit 1; }

# ─── Prereqs ────────────────────────────────────────────────────────────
step "Checking prereqs"
command -v node >/dev/null || fail "node is required. Try: sudo apt install -y nodejs"
command -v npm  >/dev/null || fail "npm is required"
command -v git  >/dev/null || fail "git is required"
ok "node $(node --version), npm $(npm --version)"

# ─── pm2 ────────────────────────────────────────────────────────────────
step "pm2"
if ! command -v pm2 >/dev/null; then
  warn "pm2 not found — installing globally (sudo)"
  sudo npm install -g pm2
  ok "pm2 installed at $(command -v pm2)"
else
  ok "pm2 already installed at $(command -v pm2)"
fi

# ─── Clone or pull ──────────────────────────────────────────────────────
step "Repo"
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git fetch origin --quiet
  git reset --hard origin/main --quiet
  ok "pulled latest main into $DIR"
else
  git clone --quiet "$REPO" "$DIR"
  cd "$DIR"
  ok "cloned $REPO -> $DIR"
fi

# ─── Install + build ────────────────────────────────────────────────────
step "npm install + build (slow — better-sqlite3 native compile on ARM)"
LOG=/tmp/gmem-paywall-install.log
if ! npm install --no-audit --no-fund >"$LOG" 2>&1; then
  if grep -qE "node-gyp|gyp ERR|build-essential|python3" "$LOG"; then
    warn "native build failed — likely missing build tools. Installing..."
    sudo apt-get update -qq
    sudo apt-get install -y build-essential python3 make g++ >/dev/null
    npm install --no-audit --no-fund || { tail -30 "$LOG"; fail "npm install still failing (see $LOG)"; }
  else
    tail -30 "$LOG"
    fail "npm install failed (see $LOG)"
  fi
fi
npm run build >/dev/null
ok "build complete"

# ─── .env ───────────────────────────────────────────────────────────────
step "Writing .env (testnet defaults, Phase 1)"
mkdir -p "$HOME/.gmem"
cat > "$DIR/.env" <<EOF
SVM_PAY_TO=$PAY_TO
FACILITATOR_URL=https://x402.org/facilitator
PORT=$PORT
GMEM_DB=$HOME/.gmem/paywall-memory.db
EOF
chmod 600 "$DIR/.env"
ok ".env written (chmod 600)"

# ─── pm2 start/restart ──────────────────────────────────────────────────
step "Starting gmem-paywall under pm2"
if pm2 describe gmem-paywall >/dev/null 2>&1; then
  pm2 restart gmem-paywall --update-env >/dev/null
  ok "pm2 restarted gmem-paywall"
else
  pm2 start npm --name gmem-paywall -- start >/dev/null
  ok "pm2 started gmem-paywall"
fi
pm2 save >/dev/null 2>&1 || warn "pm2 save returned non-zero (probably no startup hook yet — run 'pm2 startup' once)"

# ─── Smoke tests ────────────────────────────────────────────────────────
step "Smoke tests (localhost:$PORT)"
sleep 3   # let the server fully boot

# 1. /
HEALTH=$(curl -fsS "http://localhost:$PORT/" 2>/dev/null || true)
if echo "$HEALTH" | grep -q '"service":"gmem-paywall"'; then
  ok "GET / -> $HEALTH"
else
  pm2 logs gmem-paywall --lines 30 --nostream
  fail "GET / did not respond as expected"
fi

# 2. /v1/info
INFO=$(curl -fsS "http://localhost:$PORT/v1/info" 2>/dev/null || true)
if echo "$INFO" | grep -q '"backend":"@yksanjo/gmem"'; then
  ok "GET /v1/info -> healthy, backend wired"
else
  fail "GET /v1/info did not respond as expected: $INFO"
fi

# 3. /v1/recall paywall
PAYHDR=$(curl -fsS -i -X POST "http://localhost:$PORT/v1/recall" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}' 2>/dev/null | grep -i "^payment-required:" || true)
if [ -n "$PAYHDR" ]; then
  ok "POST /v1/recall returns PAYMENT-REQUIRED header — paywall is live"
else
  fail "POST /v1/recall did not return PAYMENT-REQUIRED header. Check pm2 logs gmem-paywall"
fi

# ─── Next steps ─────────────────────────────────────────────────────────
cat <<NEXT

═══════════════════════════════════════════════════════════════════════
✅ Phase 1 server is live on localhost:$PORT.

Process: gmem-paywall under pm2 ($(pm2 jlist 2>/dev/null | grep -o '"name":"gmem-paywall"' | head -1 || echo '(check pm2 status)'))
Wallet:  $PAY_TO  (where USDC will land in Phase 2)
DB:      $HOME/.gmem/paywall-memory.db

NEXT STEPS (manual — they touch your existing services):

1) CADDY — append to your Caddyfile (likely /etc/caddy/Caddyfile):

     paywall.musicailab.com {
         reverse_proxy localhost:$PORT
     }

   Reload Caddy:
     sudo systemctl reload caddy

2) CLOUDFLARE TUNNEL — add to ~/.cloudflared/config.yml ingress list:

     - hostname: paywall.musicailab.com
       service: http://localhost:$PORT

   Restart cloudflared:
     sudo systemctl restart cloudflared

3) CLOUDFLARE DNS — add a CNAME at dash.cloudflare.com:
     Type:  CNAME
     Name:  paywall
     Value: <your-tunnel-id>.cfargotunnel.com
     Proxy: on

4) Smoke-test from outside the Pi:
     curl -s https://paywall.musicailab.com/v1/info | head

   You should see the same JSON as 'GET /v1/info' above.

When (4) passes, paywall.musicailab.com is publicly live, and Phase 1 is done.
Tell Claude you're ready for Phase 2 (Coinbase CDP -> mainnet USDC).
═══════════════════════════════════════════════════════════════════════
NEXT
