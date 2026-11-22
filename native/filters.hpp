#pragma once
// ============================================================================
//  PhotoCraft C++ Engine - Filter & Effekte (Filter Menu)
//  Hochperformante parallele Bildfilter (Multithreaded ueber alle CPU-Kerne)
// ============================================================================

#include <cstdint>

namespace PhotoCraft {
namespace Filters {

// 1. Blurs
void GaussianBlur(uint8_t* px, int w, int h, float radius);
void MotionBlur(uint8_t* px, int w, int h, float angleDeg, float distance);
void RadialZoomBlur(uint8_t* px, int w, int h, float centerX, float centerY, float amount);

// 2. Stylize & Distort (Photoshop / PhotoCraft)
void Twirl(uint8_t* px, int w, int h, float centerX, float centerY, float radius, float angleDeg);
void Ripple(uint8_t* px, int w, int h, float amplitude, float wavelength);
void Pixelate(uint8_t* px, int w, int h, int cellSize);
void OilPaint(uint8_t* px, int w, int h, int radius, int intensityLevels);
void HighPass(uint8_t* px, int w, int h, float radius);
void FindEdges(uint8_t* px, int w, int h);

} // namespace Filters
} // namespace PhotoCraft
