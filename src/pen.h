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

// Defaults for the holder limits, used until the machine is calibrated. These
// reproduce the previous hardcoded behaviour exactly - "up" was 90 and the UI
// slider spanned 0-90 - so an uncalibrated machine behaves as it always did.
// PEN_DEFAULT_UNLOCKED equal to the highest locked angle means "no separate
// release position known yet", so unlocking is a no-op rather than driving the
// servo somewhere the holder may not survive.
const int PEN_DEFAULT_LOWEST_LOCKED = 0;
const int PEN_DEFAULT_HIGHEST_LOCKED = 90;
const int PEN_DEFAULT_UNLOCKED = 90;

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

    // Calibrated holder geometry - see prefskeys.h. Higher servo angle lifts the
    // pen, so lowestLocked < highestLocked <= unlockedAngle.
    int lowestLocked = PEN_DEFAULT_LOWEST_LOCKED;
    int highestLocked = PEN_DEFAULT_HIGHEST_LOCKED;
    int unlockedAngle = PEN_DEFAULT_UNLOCKED;

    // The contact point actually driven to: penDistance held inside the locked
    // range. Single definition so slowDown() and isDown() cannot disagree about
    // where "down" is, which they would if each clamped separately.
    int clampedDownAngle() const;
    public:
    Pen();
    void setRawValue(int rawValue);
    void setPenDistance(int value);
    int getPenDistance();
    bool slowUp();
    bool slowDown();
    bool isDown();

    // Reads the calibrated limits from NVS. Called from the constructor; values
    // that fail validation are ignored in favour of the defaults, so a partially
    // written or corrupt set can never drive the servo past the holder.
    void loadLimits();
    // Validates and persists a calibration. Returns false (changing nothing) if
    // the ordering or range is wrong.
    bool setLimits(int lowest, int highest, int unlocked);
    static bool limitsAreValid(int lowest, int highest, int unlocked);
    int getLowestLocked() const { return lowestLocked; }
    int getHighestLocked() const { return highestLocked; }
    int getUnlockedAngle() const { return unlockedAngle; }

    // Drives to the release position so a pen can be taken out or put in. Only
    // meaningful once calibrated; with the defaults it is the same as slowUp().
    bool slowUnlock();

    // Estimated seconds for one pen up or down move, derived from the same
    // constants doSlowMove() actually steps through. Returns 0 before the pen
    // has been calibrated, since the sweep is unknown until then.
    double estimateMoveSeconds() const;
};
#endif
