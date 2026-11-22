#pragma once

#include <cstdint>
#include <vector>
#include <algorithm>
#include <cmath>

namespace PhotoCraft {

enum class BlendMode {
    Normal = 0,
    Multiply = 1,
    Screen = 2,
    Overlay = 3,
    Darken = 4,
    Lighten = 5,
    ColorDodge = 6,
    ColorBurn = 7,
    HardLight = 8,
    SoftLight = 9,
    Difference = 10,
    Exclusion = 11,
    Add = 12
};

class PixelOps {
public:
    // Blend a source RGBA buffer over a destination RGBA buffer using Photoshop blend modes
    static void BlendBuffers(
        uint8_t* dest,
        const uint8_t* src,
        int pixelCount,
        BlendMode mode,
        float opacity
    );

    // Separable 2-pass Gaussian Blur in C++ (horizontal & vertical passes)
    static void FastGaussianBlur(
        uint8_t* pixels,
        int width,
        int height,
        int radius
    );

    // 3x3 Convolution Sharpening
    static void Sharpen(
        uint8_t* pixels,
        int width,
        int height,
        float amount
    );

    // Color adjustments: brightness (-1..1), contrast (-1..1), saturation (-1..1)
    static void AdjustColors(
        uint8_t* pixels,
        int pixelCount,
        float brightness,
        float contrast,
        float saturation
    );

    // High performance 4-way queue-based scanline flood fill
    static int FloodFill(
        uint8_t* pixels,
        int width,
        int height,
        int startX,
        int startY,
        uint8_t fillR,
        uint8_t fillG,
        uint8_t fillB,
        uint8_t fillA,
        int tolerance
    );
};

} // namespace PhotoCraft
