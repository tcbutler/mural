#include "pen.h"
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
    if (!ledcAttach(PEN_SERVO_PIN, PEN_SERVO_FREQ_HZ, PEN_SERVO_TIMER_BITS)) {
        Serial.println("ERROR: pen servo PWM failed to attach on pin " + String(PEN_SERVO_PIN) +
                       " - the pen will not move");
        return;
    }
    setRawValue(90);
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

    doSlowMove(this, currentPosition, 90, slowSpeedDegPerSec);
    currentPosition = 90;
    return true;
}

bool Pen::slowDown() {
    if (penDistance == -1) {
        return false;
    }

    doSlowMove(this, currentPosition, penDistance, slowSpeedDegPerSec);
    currentPosition = penDistance;
    return true;
}

bool Pen::isDown() {
    return currentPosition == penDistance;
}