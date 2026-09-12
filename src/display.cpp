#include "display.h"
#include <Adafruit_SSD1306.h>
#include <stdexcept>

#define SCREEN_WIDTH 128 // OLED display width, in pixels
#define SCREEN_HEIGHT 64 // OLED display height, in pixels
#define SCREEN_ADDRESS 0x3C // 0x3D for some 128x64 panels

Display::Display() {
    // Probe for the panel before talking to it. Adafruit_SSD1306::begin() looks
    // like it would tell us - it returns a bool - but its only failure path is a
    // failed framebuffer malloc: there is no I2C acknowledge check, so it returns
    // true whether or not anything is on the bus.
    //
    // That matters beyond tidiness. The stock BOM has no OLED, and displayText()
    // is called from Runner::run() every time the percentage changes - mid-plot,
    // between two movement tasks, with the pen resting on the paper. Each call
    // pushes a 1KB framebuffer as a series of I2C transactions, and on an empty
    // bus (no panel, so no pull-ups) every one of them has to wait out the
    // driver's timeout before failing. loop() is blocked for all of it, which
    // stops step generation with the pen stationary and down: a blot.
    Wire.begin();
    Wire.beginTransmission(SCREEN_ADDRESS);
    present = (Wire.endTransmission() == 0);
    if (!present) {
        Serial.println(F("No OLED found on I2C - display output disabled"));
        display = nullptr;
        return;
    }

    display = new Adafruit_SSD1306(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
    if (!display->begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS))
    {
        Serial.println(F("SSD1306 allocation failed"));
        throw std::invalid_argument("not ready");
    }
    delay(2000);
    display->setRotation(2);
    display->clearDisplay();
    display->setTextColor(WHITE);
    display->setTextSize(1);
    display->display();
}

void Display::displayText(String text)
{
    if (!present) {
        return;
    }

    int16_t x1;
    int16_t y1;
    uint16_t width;
    uint16_t height;

    display->getTextBounds(text, 0, 0, &x1, &y1, &width, &height);

    // display on horizontal and vertical center
    display->clearDisplay(); // clear display
    display->setCursor((SCREEN_WIDTH - width) / 2, (SCREEN_HEIGHT - height) / 2);
    display->println(text); // text to display
    display->display();
    Serial.println("Displayed " + text);
}

void Display::displayHomeScreen(String ipLine, String orLine, String mdnsLine) {
    if (!present) {
        return;
    }

    display->clearDisplay();

    int16_t x1;
    int16_t y1;
    uint16_t width;
    uint16_t height;

    display->getTextBounds(ipLine, 0, 0, &x1, &y1, &width, &height);
    display->setCursor((SCREEN_WIDTH - width) / 2, 10);
    display->println(ipLine);

    display->getTextBounds(orLine, 0, 0, &x1, &y1, &width, &height);
    display->setCursor((SCREEN_WIDTH - width) / 2, 10 + SCREEN_HEIGHT / 3);
    display->println(orLine);

    display->getTextBounds(mdnsLine, 0, 0, &x1, &y1, &width, &height);
    display->setCursor((SCREEN_WIDTH - width) / 2, 10 + SCREEN_HEIGHT / 3 * 2);
    display->println(mdnsLine);

    display->display();
}