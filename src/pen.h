#ifndef Pen_h
#define Pen_h
#include <Arduino.h>
const int RETRACT_DISTANCE = 20;

// GPIO the pen servo's signal wire is on (see BOM.md / docs/pen-servo.md).
const int PEN_SERVO_PIN = 2;

// LEDC/servo timing constants. These are not free parameters - they reproduce
// the values ESP32Servo used to configure for us, so the pen keeps the exact
// pulse widths it was calibrated against. See docs/pen-servo.md.
const int PEN_SERVO_FREQ_HZ = 50;          // ESP32Servo REFRESH_CPS
const int PEN_SERVO_TIMER_BITS = 10;       // ESP32Servo DEFAULT_TIMER_WIDTH
const int PEN_SERVO_TIMER_TICKS = 1 << PEN_SERVO_TIMER_BITS;
const int PEN_SERVO_REFRESH_USEC = 20000;  // ESP32Servo REFRESH_USEC
const int PEN_SERVO_MIN_USEC = 544;        // ESP32Servo DEFAULT_uS_LOW
const int PEN_SERVO_MAX_USEC = 2400;       // ESP32Servo DEFAULT_uS_HIGH
const int PEN_SERVO_ANGLE_CUTOFF = 500;    // ESP32Servo MIN_PULSE_WIDTH

// Converts a raw pen value into an LEDC duty count, reproducing ESP32Servo's
// Servo::write() -> map() -> usToTicks() -> ESP32PWM::write() chain bit for bit,
// including the integer truncation at each step and the "values >= 500 are
// microseconds, not degrees" quirk. Kept constexpr so the static_asserts in
// pen.cpp pin the mapping at compile time.
constexpr int penValueToDuty(int value) {
    int usec;
    if (value < PEN_SERVO_ANGLE_CUTOFF) {
        // Treated as an angle in degrees.
        if (value < 0) {
            value = 0;
        } else if (value > 180) {
            value = 180;
        }
        // Arduino map(value, 0, 180, MIN_USEC, MAX_USEC) - multiply before divide.
        usec = value * (PEN_SERVO_MAX_USEC - PEN_SERVO_MIN_USEC) / 180 + PEN_SERVO_MIN_USEC;
    } else {
        // Treated as a raw pulse width in microseconds.
        usec = value;
    }

    int ticks = usec * PEN_SERVO_TIMER_TICKS / PEN_SERVO_REFRESH_USEC;

    // Servo::writeTicks() clamped to the tick equivalents of min/max, not to the
    // microsecond values, so clamp in the same place to keep the edges identical.
    const int minTicks = PEN_SERVO_MIN_USEC * PEN_SERVO_TIMER_TICKS / PEN_SERVO_REFRESH_USEC;
    const int maxTicks = PEN_SERVO_MAX_USEC * PEN_SERVO_TIMER_TICKS / PEN_SERVO_REFRESH_USEC;
    if (ticks < minTicks) {
        ticks = minTicks;
    } else if (ticks > maxTicks) {
        ticks = maxTicks;
    }
    return ticks;
}

class Pen {
    private:
    int penDistance = -1;
    int slowSpeedDegPerSec = 90;
    int currentPosition = 90;
    public:
    Pen();
    void setRawValue(int rawValue);
    void setPenDistance(int value);
    int getPenDistance();
    bool slowUp();
    bool slowDown();
    bool isDown();
};
#endif
