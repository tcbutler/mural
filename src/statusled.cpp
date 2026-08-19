#include "statusled.h"

// Scales one colour channel by a 0-255 animation level.
static inline uint8_t scaleChannel(uint8_t channel, uint8_t level) {
    return (uint8_t)(((uint16_t)channel * level) / 255);
}

StatusLed::StatusLed(uint8_t pin, uint16_t pixelCount)
    : strip(pixelCount, pin, NEO_GRB + NEO_KHZ800), count(pixelCount) {
}

void StatusLed::begin() {
    strip.begin();
    strip.setBrightness(STATUS_LED_BRIGHTNESS);
    strip.clear();
    strip.show();
}

StatusLed::Status StatusLed::parseState(const char* state) {
    if (state == nullptr)                    return Status::Unknown;
    if (strcmp(state, "boot") == 0)          return Status::Boot;
    if (strcmp(state, "wifi") == 0)          return Status::Wifi;
    if (strcmp(state, "ready") == 0)         return Status::Ready;
    if (strcmp(state, "started") == 0)       return Status::Started;
    if (strcmp(state, "running") == 0)       return Status::Running;
    if (strcmp(state, "penSwap") == 0)       return Status::PenSwap;
    if (strcmp(state, "paused") == 0)        return Status::Paused;
    if (strcmp(state, "stalled") == 0)       return Status::Stalled;
    if (strcmp(state, "finished") == 0)      return Status::Finished;
    return Status::Unknown;
}

void StatusLed::setState(const char* state, int percent) {
    this->status = parseState(state);
    if (percent >= 0) {
        this->percent = percent > 100 ? 100 : percent;
    }
}

void StatusLed::tick() {
    unsigned long now = millis();
    if (now - lastShowMillis < showIntervalMillis) {
        return;
    }
    lastShowMillis = now;
    render(now);
}

void StatusLed::render(unsigned long now) {
    uint8_t r = 0, g = 0, b = 0;
    uint16_t periodMs = 0;   // 0 means "hold steady"
    bool blink = false;      // square wave rather than a smooth breathe
    bool fill = false;       // light only the progress fraction of the strip

    switch (status) {
        // Pre-Runner states. These matter because setup()'s WiFi connect blocks
        // for 20+ seconds (see the comment in main.cpp) with no other outward
        // sign that the board is doing anything at all.
        case Status::Boot:     r = 40;  g = 40;  b = 40;                              break;
        case Status::Wifi:     r = 0;   g = 60;  b = 255; periodMs = 1500;            break;
        case Status::Ready:    r = 0;   g = 120; b = 120;                             break;

        case Status::Started:  r = 255; g = 255; b = 255; periodMs = 2000;            break;
        case Status::Running:  r = 0;   g = 255; b = 0;   periodMs = 1200; fill = true; break;
        case Status::PenSwap:  r = 0;   g = 80;  b = 255; periodMs = 400;  blink = true; break;
        case Status::Paused:   r = 255; g = 140; b = 0;                               break;
        case Status::Stalled:  r = 255; g = 0;   b = 0;   periodMs = 250;  blink = true; break;
        case Status::Finished: r = 0;   g = 255; b = 0;                               break;
        default:               r = 30;  g = 30;  b = 30;                              break;
    }

    uint8_t level = 255;
    if (periodMs > 0) {
        unsigned long phase = now % periodMs;
        if (blink) {
            level = phase < (unsigned long)(periodMs / 2) ? 255 : 0;
        } else {
            // Triangle wave: up for the first half of the period, back down for
            // the second. Cheaper than a sine and indistinguishable by eye.
            unsigned long half = periodMs / 2;
            unsigned long rising = phase < half ? phase : periodMs - phase;
            level = minPulseLevel + (uint8_t)(((uint32_t)(255 - minPulseLevel) * rising) / half);
        }
    }

    // While running, the strip doubles as a progress bar: the filled portion
    // holds steady so the percentage stays readable, and only the leading pixel
    // pulses. That keeps the heartbeat obvious without making the bar flicker.
    uint16_t lit = count;
    if (fill) {
        lit = (uint16_t)(((uint32_t)percent * count) / 100);
        if (lit == 0) {
            lit = 1;   // always keep the heartbeat pixel alive at 0%
        }
    }

    for (uint16_t i = 0; i < count; i++) {
        uint8_t pixelLevel;
        if (i >= lit) {
            pixelLevel = 0;
        } else if (fill && i < lit - 1) {
            pixelLevel = 255;
        } else {
            pixelLevel = level;
        }
        strip.setPixelColor(i, strip.Color(scaleChannel(r, pixelLevel),
                                           scaleChannel(g, pixelLevel),
                                           scaleChannel(b, pixelLevel)));
    }
    strip.show();
}
