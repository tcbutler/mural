#ifndef StatusLed_h
#define StatusLed_h

#include <Adafruit_NeoPixel.h>

// Front-panel status indicator. Not part of the original BOM.md build - see
// that file's note. A single WS2812 data line drives the whole strip, which is
// why this needs one GPIO where a discrete 10-segment bar graph would have
// needed ten (or an I2C expander).
//
// GPIO32 is deliberate. It is broken out on the 30-pin NodeMCU ESP32 that
// BOM.md specifies (the 30-pin variant does not expose GPIO0, and 34/35/36/39
// are input-only), it is not a boot strapping pin, and it stays clear of both
// the stepper/servo assignments (movement.h, pen.cpp) and the 16/17/4/18 group
// that MURAL_TMC_UART claims (docs/tmc-uart.md) - so enabling stall detection
// later needs no rewiring.
constexpr uint8_t STATUS_LED_PIN = 32;
constexpr uint16_t STATUS_LED_COUNT = 8;

// Deliberately dim. The strip taps the same LM2596 5V rail as the MG90s servo
// (BOM.md), and that servo pulls several hundred mA on a stall. Eight WS2812s
// at full white would add ~480mA on their own; at this brightness the worst
// case is nearer 120mA, which leaves the buck converter real headroom. Raise
// it only if you have measured the rail under load.
constexpr uint8_t STATUS_LED_BRIGHTNESS = 64;

class StatusLed {
    public:
        StatusLed(uint8_t pin = STATUS_LED_PIN, uint16_t count = STATUS_LED_COUNT);
        void begin();

        // `state` takes the strings Runner::getStateName() already returns
        // ("started"/"running"/"paused"/"penSwap"/"stalled"/"finished"), plus
        // the boot-time literals "boot"/"wifi"/"ready" which happen before a
        // Runner exists. An unrecognised string falls back to dim white, so a
        // missed mapping shows up on the machine instead of failing silently.
        //
        // Cheap by design: this only stores values. All LED I/O happens in
        // tick(), so calling it from the runner costs nothing in the motion path.
        // percent < 0 leaves the progress fill untouched.
        void setState(const char* state, int percent = -1);

        // Drives the animation, and must be called from loop(). The pulse is
        // the liveness signal: it is generated here, so it stops if the main
        // loop ever wedges. That is the one thing a static display cannot tell
        // you - a frozen "47%" and a working "47%" look identical.
        void tick();

    private:
        enum class Status { Boot, Wifi, Ready, Started, Running, PenSwap, Paused, Stalled, Finished, Unknown };

        Adafruit_NeoPixel strip;
        uint16_t count;
        Status status = Status::Boot;
        int percent = 0;
        unsigned long lastShowMillis = 0;

        // 50ms between refreshes. Adafruit_NeoPixel drives WS2812s from the
        // ESP32 RMT peripheral, but show() still occupies roughly 30us per
        // pixel; throttling keeps that under 1% of the loop so AccelStepper's
        // step timing (movement.cpp) stays undisturbed.
        static const unsigned long showIntervalMillis = 50;

        // Floor for the breathing animation, so a "running" machine never
        // looks fully off mid-pulse.
        static const uint8_t minPulseLevel = 40;

        static Status parseState(const char* state);
        void render(unsigned long now);
};
#endif
