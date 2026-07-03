# Baleen Filter Skid — Supervisor Dashboard (F12159)

Polls the three Endress+Hauser FXA42 gateways over Modbus TCP, stores readings to a
local SQLite file, and serves a live web dashboard with per-tag trending and alarms.
Pure JavaScript — no compiler, no database server, no cloud.

- **Data in:** Modbus TCP from FXA42-1/2/3 on `192.168.1.2/.3/.4`
- **Store:** `node:sqlite` → `data/baleen.db` (one file; back it up by copying it)
- **Out:** web dashboard on `http://<host>:8080`, live over websocket
- **Remote access:** an outbound tunnel (Tailscale / Cloudflare) — see §5. No router
  admin, no SIM change, no port-forwarding required.

Requires **Node.js ≥ 22.6** (for built-in `node:sqlite`). Install Node 22 LTS.

---

## 1. Install

```bash
git clone <your-repo> baleen-dashboard   # or copy the folder onto the machine
cd baleen-dashboard
npm install                              # express, ws, modbus-serial only
```

## 2. Prove it works with no hardware (do this tonight)

Three mock gateways + the real app, so you can see the dashboard live before site:

```bash
# terminal 1
node mock-slave.js 5021 analog
# terminal 2
node mock-slave.js 5022 digital
# terminal 3
node mock-slave.js 5023 analog
# terminal 4
BALEEN_CONFIG=./config.test.js node index.js
```

Open http://localhost:8080 — you should see values moving and a couple of tanks in alarm.

## 3. On site: find the register map

The FXA42 does not have a fixed Modbus map — you assign it. On each gateway's web UI
(192.168.1.2 / .3 / .4), enable the **Modbus TCP server** and map each analog/digital
value to a register. Then confirm the addresses and word order with the scan tool:

```bash
node scan.js 192.168.1.2 0 20      # host, start register, count
```

**Auto-discovery (brute-force):** if you don't know the register map yet, run:

```bash
node discover.js                     # scan all three gateways from config.js
node discover.js 192.168.1.2         # one gateway
node discover.js 192.168.1.3 --digital
node discover.js --max-reg 300 --units 1-10   # wider search
node discover.js --watch 15          # re-scan every 15s until mappings appear
```

This loops through unit IDs, holding/input registers, coils, addresses, and word
orders; scores values against expected tag ranges; prints ranked candidates and a
suggested `config.js` snippet. Compare output to the FXA42 Grid View before saving.

It prints each register's raw value plus the FLOAT32 interpretation in all four word
orders (ABCD / DCBA / CDAB / BADC). Compare against the live values on the gateway's
**Grid View** — the column that shows a plausible engineering number tells you both the
register and the correct `wordOrder`. Write these into `config.js`.

Two scaling choices per tag (see comments in `config.js`):
- **Scale on the gateway** (recommended): set the FXA42 analog input Scaling to *Range*
  with the instrument min/max, serve FLOAT32 → leave `rescale` off here.
- **Scale here:** serve raw 4–20 mA and set `rescale: { inMin, inMax, outMin, outMax }`.

Confirm digital polarity by inducing a known fault and watching the tag — if it reads
backwards, set `invert: true` on that tag. If the gateway maps digitals as coils rather
than registers, add `fn: 'coil'` to the tag.

## 4. Run against the real gateways

```bash
node index.js            # uses config.js
```

Open `http://<machine-ip>:8080` from anything on the LAN. Values persist to
`data/baleen.db`; click any analog card for its 6-hour trend.

To auto-start and survive reboots/power loss (do this on the permanent NUC), install the
systemd unit:

```bash
sudo cp baleen-dashboard.service /etc/systemd/system/
# edit User= and WorkingDirectory= inside the file first
sudo systemctl daemon-reload
sudo systemctl enable --now baleen-dashboard
```

## 5. Remote access (no router changes, no SIM swap)

The Pi/PC reaches *out*; nothing reaches *in*. This works through the RUT955's existing
cellular connection and its CGNAT, needs no router admin, and never exposes a port.

**Option A — Tailscale** (simplest, just you and trusted staff):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The machine joins your tailnet; reach the dashboard at `http://<machine>:8080` from any
of your own Tailscale devices, anywhere.

**Option B — Cloudflare Tunnel** (public HTTPS URL with SSO, for wider supervisor access
without installing anything on their end):

```bash
# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create baleen
cloudflared tunnel route dns baleen baleen.yourdomain.com
cloudflared tunnel run --url http://localhost:8080 baleen
```

Put Cloudflare Access in front of the hostname for email/SSO auth.

**Do not** enable port-forwarding on the RUT955 to expose this — the tunnel is the
hardened path. Keep the SQLite DB on the machine and view on demand to keep cellular
data light.

## Files

| File | Purpose |
|------|---------|
| `config.js` | The only file you edit for the site: gateways, tags, registers, scaling, alarms |
| `scan.js` | On-site register discovery tool |
| `discover.js` | Brute-force mapping discovery (unit ID, register type, address, word order) |
| `modbus.js` | Per-gateway Modbus client, reconnect, register decoding |
| `db.js` | SQLite storage (readings + alarm events) |
| `alarms.js` | Reading → status (ok / warn / alarm / stale) |
| `index.js` | Poll loop + REST API + websocket + static server |
| `public/dashboard.html` | The dashboard (single file, vanilla JS) |
| `mock-slave.js`, `config.test.js` | Hardware-free demo/test harness |
| `baleen-dashboard.service` | systemd unit for auto-start on the NUC |

## Notes carried over from the 16 May 2026 investigation

- **FXA42-3** was unpowered (loose 24 V terminal) — its four tags read stale until fixed.
- **ORP** had a loop fault (22.47 mA, out of 4–20 range) — expect it faulty until the
  electrician clears it; that's a wiring/sensor issue, not a dashboard one.
- **unitId** in `config.js` defaults to 1 — confirm each gateway's Modbus unit ID.
