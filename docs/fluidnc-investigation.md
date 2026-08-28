# Investigation: FluidNC vs Mural's current motor-drive system

## Context

Question asked: what would FluidNC buy us over the current firmware for driving the motors, heat being one rumoured benefit. This is an assessment, not an implementation plan. Findings below; a small "if we act on this" section at the end.

## What Mural does today (from the code)

- ESP32 (esp32dev, Arduino framework), two TMC2209 drivers in **standalone STEP/DIR mode** — current set by trimpot, microstepping by MS1/MS2 straps, no software control (`docs/tmc-uart.md`, `src/movement.cpp:10-19`).
- **Motors are energised at full trimpot current 100% of the time**, boot to power-off. `Movement::disableMotors()` exists (`src/movement.cpp:521`) but nothing calls it; this is deliberate — hold torque is the only position-integrity mechanism during pen swaps (`docs/multi-color.md:138-152`), because unpowered steppers back-drive (`README.md:53`).
- **Step pulses are software-generated, one step/motor per `loop()` pass** via AccelStepper `runSpeedToPosition()` (`src/movement.cpp:324`, `src/main.cpp:250`), sharing the loop with the async web server, SSE pushes, LittleFS reads, NVS writes and OLED updates. No hardware timer, RMT, or dedicated task.
- **No acceleration planning**: `acceleration = 999999999` (`src/movement.h:22`); every 1 mm interpolation segment (`src/tasks/interpolatingmovementtask.h:6`) is an instant stop/start. `docs/motion-smoothing.md` documents this as a known problem; the `MURAL_SMOOTH_MOTION` build merges near-collinear waypoints but adds no real look-ahead.
- **Custom kinematics that FluidNC does not have**: per-segment iterative torque-equilibrium tilt solve + belt-elongation correction (`src/kinematics.cpp`, `KinematicModel.md`), with NVS-persisted tunable physics constants.
- Bespoke HTTP/SSE control protocol, phase-wizard UI, multi-colour pen-swap flow, custom command-file format — no G-code anywhere.
- An **untested optional `MURAL_TMC_UART` build** already exists (`env:esp32dev-tmcuart`, `Movement::setupTmcDrivers()` in `src/movement.cpp:131-168`) that sets rms current, microsteps, SpreadCycle and StallGuard over UART.
- Repo-wide caveat: nothing has run on hardware yet (`README.md:7-13`), so "current behaviour" is design intent, not measurement.

## What FluidNC would genuinely buy

1. **Heat / current management (the rumoured one — real).** FluidNC drives TMC2209s over UART with separate `run_amps` / `hold_amps` plus an idle-reduction timer and StealthChop. Motors drop to a low hold current whenever stationary (pen swaps, setup, between jobs) instead of sitting at full trimpot current forever. This is the concrete heat win.
2. **Proper motion control.** Real acceleration/look-ahead planner and hardware-timed step generation (RMT/I2S) on a dedicated task — smoother lines, higher usable speeds, no step-timing jitter from the web server, and no stop-start every millimetre.
3. **Ecosystem.** G-code compatibility (any sender works), YAML machine config without recompiling, built-in WebUI/file upload, StallGuard sensorless homing, mature and maintained codebase.

## What it would cost

- **The kinematics.** FluidNC's `WallPlotter` module is a plain two-belt length solve — no tilt-equilibrium model, no belt elongation. Mural's drawing-accuracy claims rest on that model; porting it means writing a custom FluidNC kinematics module (C++ fork of FluidNC, maintained against upstream). This is the main risk.
- **The whole product layer.** Phase wizard, screwless homing flow, pen-swap protocol, colour layers, SSE progress, command-file format, resume-after-power-loss — all bespoke and all replaced or rebuilt on top of G-code + FluidNC's channels. `tsc/src/toCommands.ts` would target G-code instead.
- Loss of the tight firmware↔UI integration (e-steps calibration, physics-constant tuning endpoints, etc.).

## Honest verdict

The heat benefit specifically does **not** require FluidNC: the repo already contains the ingredients (TMC UART build). Adding `ihold`/`TPOWERDOWN` hold-current reduction to `setupTmcDrivers()` is a small change that gets most of the thermal win while keeping everything else. FluidNC's unique, hard-to-replicate benefits are the motion planner and hardware step generation — worth it only if drawing speed/smoothness on real hardware turns out to be limited by the loop()-rate stop-start stepping, which can't be known until the machine runs.

## If we act on this later (not requested now)

- Cheap path: extend the existing `MURAL_TMC_UART` build with `IHOLD` hold-current + `TPOWERDOWN` idle reduction (and optionally StealthChop while drawing). Files: `src/movement.cpp` (`setupTmcDrivers`), `src/movement.h`, `docs/tmc-uart.md`.
- Expensive path: fork FluidNC, add a `MuralPlotter` kinematics module ported from `src/kinematics.cpp` (parity-tested against `test/host/parity_test.cpp`), retarget `tsc/src/toCommands.ts` to G-code, rebuild pen-swap/progress on FluidNC macros + WebUI.

## Verification

N/A for the investigation itself. Any follow-up firmware change should pass the existing CI builds (`esp32dev`, `esp32dev-tmcuart`, `esp32dev-smooth`) and the host parity test.
