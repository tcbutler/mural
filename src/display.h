#ifndef Display_h
#define Display_h
#include <Adafruit_SSD1306.h>

class Display {
    private:
    Adafruit_SSD1306 *display;
    // Whether a panel actually answered on the I2C bus at construction. The BOM
    // has no OLED, and every drawing method is a no-op without one - see the
    // constructor for why that matters to plot quality, not just tidiness.
    bool present = false;
    public:
    Display();
    bool isPresent() const { return present; }
    void displayText(String text);
    void displayHomeScreen(String ipLine, String orLine, String mdnsLine);
};
#endif