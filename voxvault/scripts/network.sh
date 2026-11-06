#!/usr/bin/env bash
# Simulate bad networks between devices and the relay (needs `docker compose up`).
# Usage: scripts/network.sh slow | flaky | down | up | reset | status
set -euo pipefail
API=${TOXIPROXY_API:-http://localhost:8474}
P=relay
toxic() { curl -sf -X POST "$API/proxies/$P/toxics" -H 'content-type: application/json' -d "$1" > /dev/null; }
case "${1:-status}" in
  slow)   toxic '{"name":"latency","type":"latency","stream":"downstream","attributes":{"latency":1500,"jitter":500}}'; echo "added 1.5s ± 0.5s latency" ;;
  flaky)  toxic '{"name":"reset","type":"reset_peer","stream":"downstream","toxicity":0.5,"attributes":{"timeout":200}}'; echo "50% of connections reset" ;;
  down)   curl -sf -X POST "$API/proxies/$P" -H 'content-type: application/json' -d '{"enabled":false}' > /dev/null; echo "relay unreachable" ;;
  up)     curl -sf -X POST "$API/proxies/$P" -H 'content-type: application/json' -d '{"enabled":true}' > /dev/null; echo "relay reachable" ;;
  reset)  curl -sf -X POST "$API/reset" > /dev/null; echo "all faults cleared" ;;
  status) curl -sf "$API/proxies/$P" ; echo ;;
  *) echo "usage: $0 slow|flaky|down|up|reset|status"; exit 1 ;;
esac
