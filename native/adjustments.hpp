#pragma once
// ============================================================================
//  PhotoCraft C++ Engine - Bildkorrekturen (Image > Adjustments)
//  Alle Funktionen arbeiten in-place auf RGBA8-Puffern (straight alpha).
// ============================================================================

#include <cstdint>
#include <vector>

namespace PhotoCraft {
namespace Adjust {

// Kanal: 0 = RGB (alle), 1 = Rot, 2 = Gruen, 3 = Blau
void Levels(uint8_t* px, int n, int channel, float inBlack, float inWhite, float gamma, float outBlack, float outWhite);
void Curves(uint8_t* px, int n, int channel, const std::vector<float>& xs, const std::vector<float>& ys);
void BrightnessContrast(uint8_t* px, int n, float brightness, float contrast); // -150..150 / -100..100
void HueSaturation(uint8_t* px, int n, float hue, float saturation, float lightness, bool colorize);
void Vibrance(uint8_t* px, int n, float vibrance, float saturation);       // -100..100
void BlackWhite(uint8_t* px, int n, const float weights[6], bool tint, float tintHue, float tintSat);
void PhotoFilter(uint8_t* px, int n, uint8_t r, uint8_t g, uint8_t b, float density, bool preserveLum);
void Exposure(uint8_t* px, int n, float exposure, float offset, float gamma);
void ColorBalance(uint8_t* px, int n, const float shadows[3], const float midtones[3], const float highlights[3], bool preserveLum);
void Invert(uint8_t* px, int n);
void Posterize(uint8_t* px, int n, int levels);
void Threshold(uint8_t* px, int n, int level);
void Desaturate(uint8_t* px, int n);
void Equalize(uint8_t* px, int n);
void AutoContrast(uint8_t* px, int n, float clipPercent);

// Histogramm: out[0..255]=R, [256..511]=G, [512..767]=B, [768..1023]=Luminanz
void Histogram(const uint8_t* px, int n, uint32_t* out);

} // namespace Adjust
} // namespace PhotoCraft
