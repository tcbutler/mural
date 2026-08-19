# Pen servo PWM

The pen (an MG90s, signal on GPIO 2 — see [BOM.md](../BOM.md)) is driven by writing
LEDC duty counts directly from [`src/pen.cpp`](../src/pen.cpp), rather than through
the ESP32Servo library. This document explains why, and records the measurements
that back the change, so nobody has to re-derive it.

## The symptom

Every boot used to log two lines that look like a fatal pen-servo failure:

```
[E][esp32-hal-ledc.c:206] ledcAttachChannel(): Pin 2 is already attached to LEDC (channel 0, resolution 10)
[E][ESP32PWM.cpp:508] attachPin(): [ESP32PWM] ERROR PWM channel failed to configure on pin 2!
```

They were harmless: the LEDC channel was configured correctly and GPIO 2 was
driving a valid servo waveform throughout (measured below). But "ERROR PWM channel
failed to configure" is exactly what a genuinely broken pen servo would print, so
the lines cost real debugging time more than once.

## Root cause

An ESP32Servo bug, not a Mural one. `Pen::Pen()` called `servo->attach(2)` exactly
once, but that one call attaches the pin to LEDC twice:

1. `Servo::attach(pin)` → `Servo::attach(pin, min, max)`, which calls
   `pwm.attachPin(pin, REFRESH_CPS, timer_width)` — the 3-argument overload
   (`ESP32PWM.cpp:525`).
2. That overload calls `setup(freq, resolution_bits)` (`ESP32PWM.cpp:529`).
   On a fresh boot `attached()` is false, so `setup()` takes its
   first-time-configuration path and attaches the pin via `ledcAttachChannel()`.
3. The overload then calls the 1-argument `attachPin(pin)`
   (`ESP32PWM.cpp:531`), which calls `ledcAttachChannel()` a **second** time on
   the now-already-attached pin (`ESP32PWM.cpp:499`).
4. Arduino-ESP32 3.x rejects the duplicate and returns false, so `success` is
   false and the error at `ESP32PWM.cpp:508` is logged.

The first attach succeeded. The "already attached to LEDC (channel 0, resolution
10)" message is in fact reporting the correct, working configuration — 50 Hz on
channel 0 at 10-bit resolution — which is precisely what the servo needs.

There is no upstream version to upgrade to. `platformio.ini` requested
`ESP32Servo@^3.0.9`, which resolved forward to **3.2.1, the newest release**, and
3.2.1 still contains the double attach (`ESP32PWM.cpp:525-535` is unchanged).

Note the interaction is with the Arduino-ESP32 3.x core, pinned through the
pioarduino `55.03.39` platform URL in `platformio.ini`. On Arduino-ESP32 2.x the
redundant call went to `ledcAttachPin()`, which returned void and never complained,
which is why the library got away with this for years.

## Empirical confirmation that the PWM signal was fine

**Scope of this evidence:** no servo was physically connected to the board when
these measurements were taken, so this section establishes that GPIO 2 carries a
correct servo signal — *not* that the pen arm mechanically moves. Mechanical
confirmation is still outstanding; see "Still to confirm on hardware" below.

Before changing anything, the pen was driven through the real
`POST /setServo?angle=…` calibration endpoint and the LEDC peripheral was read back
on-device with `ledcReadFreq()` / `ledcRead()`:

| Commanded angle | `ledcReadFreq(2)` | `ledcRead(2)` | Implied pulse width |
| --- | --- | --- | --- |
| 40° | 50 Hz | 48 | 0.94 ms |
| 140° | 50 Hz | 101 | 1.97 ms |
| 90° | 50 Hz | 75 | 1.46 ms |

Textbook MG90s pulse widths at the correct 50 Hz refresh rate. The pin was live
and tracking the commanded angle the whole time; only the redundant second attach
ever failed. Whatever the two error lines suggested, the LEDC channel was
configured correctly and driving the pin.

### Still to confirm on hardware

Plug a servo into GPIO 2 and run the pen calibration phase in the web UI (or
`curl -X POST "http://<device>/setServo?angle=40"`, then `140`, then `90`). The arm
should swing between roughly the 1 ms and 2 ms positions. If it does not move, the
fault is downstream of the signal — power rail, wiring, or the servo itself — and
is not related to the attach errors described here, which are gone either way.

## The fix

`Pen::Pen()` now calls `ledcAttach(PEN_SERVO_PIN, 50, 10)` once, and
`Pen::setRawValue()` calls `ledcWrite()`. One attach, no duplicate, no bogus error.
This removes the misleading log at source instead of suppressing it — a genuine
attach failure is still reported, and the global log level is untouched, so real
errors elsewhere are unaffected.

`penValueToDuty()` in [`src/pen.h`](../src/pen.h) reproduces ESP32Servo's
`Servo::write()` → `map()` → `usToTicks()` → `ESP32PWM::write()` chain bit for bit,
including the integer truncation at each step and the quirk that values ≥ 500 are
interpreted as microseconds rather than degrees. The constants it uses are
ESP32Servo's own defaults (`DEFAULT_uS_LOW` 544, `DEFAULT_uS_HIGH` 2400,
`DEFAULT_TIMER_WIDTH` 10, `REFRESH_USEC` 20000, `REFRESH_CPS` 50), so the pen keeps
the exact pulse widths it was calibrated against.

`ESP32Servo` has been removed from `lib_deps`; nothing else in the firmware used it.
Firmware shrank by about 22 KB.

## Parity measurements

The mapping was verified on real hardware (the ESP32 itself, servo not attached),
not just on paper. A 0–180° sweep in 5° steps was run twice — once with the old ESP32Servo path, once with the new direct
LEDC path — reading back `ledcReadFreq()` and `ledcRead()` at every point. **All 37
points are identical**, at 50 Hz throughout:

| Angle | Duty | Angle | Duty | Angle | Duty |
| --- | --- | --- | --- | --- | --- |
| 0 | 27 | 65 | 62 | 130 | 96 |
| 5 | 30 | 70 | 64 | 135 | 99 |
| 10 | 33 | 75 | 67 | 140 | 101 |
| 15 | 35 | 80 | 70 | 145 | 104 |
| 20 | 38 | 85 | 72 | 150 | 107 |
| 25 | 41 | 90 | 75 | 155 | 109 |
| 30 | 43 | 95 | 77 | 160 | 112 |
| 35 | 46 | 100 | 80 | 165 | 114 |
| 40 | 48 | 105 | 83 | 170 | 117 |
| 45 | 51 | 110 | 85 | 175 | 120 |
| 50 | 54 | 115 | 88 | 180 | 122 |
| 55 | 56 | 120 | 91 | | |
| 60 | 59 | 125 | 93 | | |

Seven of these points are pinned as `static_assert`s in `src/pen.cpp`, so any future
edit to `penValueToDuty()` that would move the pen off its calibrated pulse widths
fails the build rather than silently changing where the pen touches the wall.

## Reproducing the measurements

`Serial` runs at **9600 baud** (`src/main.cpp`), not the 115200 that `platformio.ini`'s
`monitor_filters` might lead you to expect. To re-measure, temporarily add to
`Pen::Pen()`:

```cpp
for (int a = 0; a <= 180; a += 5) {
    setRawValue(a);
    delay(30);
    Serial.printf("%d %u %u\n", a, ledcReadFreq(PEN_SERVO_PIN), ledcRead(PEN_SERVO_PIN));
}
```

`ledcReadFreq()` returns 0 until the first `ledcWrite()` lands, so always read back
after a write, never straight after the attach.
