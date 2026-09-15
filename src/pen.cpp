#include "pen.h"
#include "prefskeys.h"
#include <Preferences.h>
#include <stdexcept>

bool shouldStop(int currentDegree, int targetDegree, bool positive) {
    if (positive) {
        return currentDegree > targetDegree;
    } else {
        return currentDegree < targetDegree;
    }
}

void doSlowMove(Pen* pen, int startDegree, int targetDegree, int speedDegPerSec) {
    if (startDegree == targetDegree) {
        return;
    }

    auto startTime = millis();

    bool positive;
    if (targetDegree > startDegree) {
        positive = true;
    } else {
        positive = false;
    }

    auto currentDegree = startDegree;

    while (!(shouldStop(currentDegree, targetDegree, positive))) {
        pen->setRawValue(currentDegree);
        delay(10);

        auto currentTime = millis();
        auto deltaTime = currentTime - startTime;
        auto progressDegrees = int(double(deltaTime) / 1000 * speedDegPerSec);

        if (!positive) {
            progressDegrees = progressDegrees * -1;
        }

        currentDegree = startDegree + progressDegrees;
    }
    pen->setRawValue(targetDegree);
    delay(200);
}


// Duty counts measured on real hardware (ledcRead() readback) while the pen was
// still driven through ESP32Servo, so any future change to penValueToDuty() that
// would move the pen off its calibrated pulse widths fails the build. Full sweep
// table in docs/pen-servo.md.
static_assert(penValueToDuty(0) == 27, "pen angle 0 must stay at duty 27");
static_assert(penValueToDuty(40) == 48, "pen angle 40 must stay at duty 48");
static_assert(penValueToDuty(90) == 75, "pen angle 90 must stay at duty 75");
static_assert(penValueToDuty(140) == 101, "pen angle 140 must stay at duty 101");
static_assert(penValueToDuty(180) == 122, "pen angle 180 must stay at duty 122");
// Out-of-range inputs clamp exactly the way Servo::write() did.
static_assert(penValueToDuty(-10) == 27, "negative pen angles clamp to duty 27");
static_assert(penValueToDuty(300) == 122, "angles above 180 clamp to duty 122");

// The pen used to be driven through ESP32Servo's Servo class. It worked, but
// Servo::attach() attaches the pin to LEDC twice: ESP32PWM::attachPin(pin, freq,
// bits) calls setup(), which already does ledcAttachChannel(), and then calls the
// 1-arg attachPin(), which does ledcAttachChannel() again on the now-attached pin.
// Arduino-ESP32 3.x rejects the duplicate, so every single boot logged
//
//   [E][esp32-hal-ledc.c:206] ledcAttachChannel(): Pin 2 is already attached to LEDC (channel 0, resolution 10)
//   [E][ESP32PWM.cpp:508] attachPin(): [ESP32PWM] ERROR PWM channel failed to configure on pin 2!
//
// which reads like a dead pen servo but is purely cosmetic - the FIRST attach
// succeeded, and only the redundant second one failed. The bug is still present in
// ESP32Servo 3.2.1 (the newest release), so there was no version to upgrade to.
//
// Driving LEDC directly attaches once, which removes the misleading errors at
// source rather than hiding them - a real attach failure below is still reported.
// See docs/pen-servo.md for the analysis and the hardware parity measurements.
Pen::Pen()
{
    loadLimits();

    if (!ledcAttach(PEN_SERVO_PIN, PEN_SERVO_FREQ_HZ, PEN_SERVO_TIMER_BITS)) {
        Serial.println("ERROR: pen servo PWM failed to attach on pin " + String(PEN_SERVO_PIN) +
                       " - the pen will not move");
        return;
    }
    // Park at the calibrated "up" angle rather than a hardcoded 90: on an
    // uncalibrated machine these are the same, and on a calibrated one this is
    // the position that actually lifts the nib clear while still holding the pen.
    setRawValue(highestLocked);
}

bool Pen::limitsAreValid(int lowest, int highest, int unlocked) {
    // Higher angle lifts the pen. The release position is at or above the
    // highest locked angle - equal meaning "not separately calibrated".
    return lowest >= 0 && lowest < highest && highest <= unlocked && unlocked <= 180;
}

void Pen::loadLimits() {
    Preferences prefs;
    prefs.begin(PREFS_NAMESPACE, true);
    const int lowest = prefs.getInt(PREFS_PEN_LOWEST_KEY, PEN_DEFAULT_LOWEST_LOCKED);
    const int highest = prefs.getInt(PREFS_PEN_HIGHEST_KEY, PEN_DEFAULT_HIGHEST_LOCKED);
    const int unlocked = prefs.getInt(PREFS_PEN_UNLOCKED_KEY, PEN_DEFAULT_UNLOCKED);
    prefs.end();

    if (!limitsAreValid(lowest, highest, unlocked)) {
        Serial.println("Stored pen limits are invalid (" + String(lowest) + "/" + String(highest) +
                       "/" + String(unlocked) + ") - falling back to defaults");
        return;
    }

    lowestLocked = lowest;
    highestLocked = highest;
    unlockedAngle = unlocked;
    Serial.println("Pen limits: lowest " + String(lowestLocked) + ", highest " + String(highestLocked) +
                   ", unlocked " + String(unlockedAngle));
}

bool Pen::setLimits(int lowest, int highest, int unlocked) {
    if (!limitsAreValid(lowest, highest, unlocked)) {
        return false;
    }

    lowestLocked = lowest;
    highestLocked = highest;
    unlockedAngle = unlocked;

    // An existing contact point calibrated against the old limits may now sit
    // outside them, which would drive the pen past the holder on the next
    // stroke. Pull it back into range rather than leaving it stale.
    if (penDistance != -1) {
        if (penDistance < lowestLocked) {
            penDistance = lowestLocked;
        } else if (penDistance > highestLocked) {
            penDistance = highestLocked;
        }
    }

    Preferences prefs;
    prefs.begin(PREFS_NAMESPACE, false);
    prefs.putInt(PREFS_PEN_LOWEST_KEY, lowestLocked);
    prefs.putInt(PREFS_PEN_HIGHEST_KEY, highestLocked);
    prefs.putInt(PREFS_PEN_UNLOCKED_KEY, unlockedAngle);
    prefs.end();

    Serial.println("Pen limits set: lowest " + String(lowestLocked) + ", highest " +
                   String(highestLocked) + ", unlocked " + String(unlockedAngle));
    return true;
}

void Pen::setRawValue(int rawValue) {
    ledcWrite(PEN_SERVO_PIN, penValueToDuty(rawValue));
    currentPosition = rawValue;
}

void Pen::setPenDistance(int value) {
    Serial.println("Pen distance angle set to " + String(value));
    this->penDistance = value;
}

int Pen::getPenDistance() {
    return penDistance;
}

bool Pen::slowUp() {
    if (penDistance == -1) {
        return false;
    }

    doSlowMove(this, currentPosition, highestLocked, slowSpeedDegPerSec);
    currentPosition = highestLocked;
    return true;
}

bool Pen::slowUnlock() {
    doSlowMove(this, currentPosition, unlockedAngle, slowSpeedDegPerSec);
    currentPosition = unlockedAngle;
    return true;
}

bool Pen::slowLock() {
    doSlowMove(this, currentPosition, highestLocked, slowSpeedDegPerSec);
    currentPosition = highestLocked;
    return true;
}

bool Pen::slowDown() {
    if (penDistance == -1) {
        return false;
    }

    const int target = clampedDownAngle();
    doSlowMove(this, currentPosition, target, slowSpeedDegPerSec);
    currentPosition = target;
    return true;
}

int Pen::clampedDownAngle() const {
    // The contact point is calibrated per pen; the holder geometry decides how
    // far the servo may actually travel.
    if (penDistance < lowestLocked) {
        return lowestLocked;
    }
    if (penDistance > highestLocked) {
        return highestLocked;
    }
    return penDistance;
}

bool Pen::isDown() {
    // Compares against the angle slowDown() actually drives to. Comparing with
    // the raw penDistance would report "not down" whenever the calibrated
    // contact point had to be clamped, which in turn would make movement tasks
    // pick the fast travel speed for a stroke that is drawing on the wall.
    return penDistance != -1 && currentPosition == clampedDownAngle();
}

double Pen::estimateMoveSeconds() const {
    if (penDistance < 0 || slowSpeedDegPerSec <= 0) {
        return 0;
    }
    // doSlowMove() ramps from one angle to the other at slowSpeedDegPerSec and
    // then settles for a fixed 200ms.
    const int sweepDegrees = abs(highestLocked - penDistance);
    return (double)sweepDegrees / (double)slowSpeedDegPerSec + 0.2;
}
