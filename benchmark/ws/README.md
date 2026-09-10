# WebSocket measurements

Build once, then run a balanced comparison:

```sh
pnpm build:benchmark
node .benchmark-dist/benchmark/ws/runner.js \
  --fw core-swm-uws,core-uwebsockets --runs 4 --order balanced \
  --warmup 4 --duration 6 --connections 50 --workers 4 \
  --msg-size 64 --mode closed --sample-ms 250 --v8prof false
```

Warmup and measurement use the same load workers and WebSocket connections.
Benchkit drains outstanding warmup messages and resets counters before starting
measurement. Throughput and latency cover only `--duration` seconds.

Target ELU and peak memory cover both phases, including worker startup and teardown.
This conservative memory window is recorded in the JSON report. Load-generator
CPU, ELU and memory cover measurement only. Profiles cover the target's lifetime.

Running warmup as a separate `runWebSocketLoad` call destroys its workers and
connections; a second call measures cold load clients even when the server has
already warmed up. Do not split these phases into separate calls.

`pnpm bench:bindings` uses this runner and keeps the existing throughput, latency,
memory and error thresholds. Earlier reports used cold load workers and a shorter
target telemetry window; retain them, but record this methodology change when
comparing their absolute numbers.
