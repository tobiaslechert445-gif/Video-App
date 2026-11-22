#pragma once

#include <vector>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace PhotoCraft {

struct Point2D {
    float x;
    float y;
    float pressure;
};

class BrushEngine {
public:
    BrushEngine();
    ~BrushEngine();

    // Hermite cubic smoothstep interpolation
    static inline float Smoothstep(float edge0, float edge1, float x) {
        float t = std::clamp((x - edge0) / (edge1 - edge0), 0.0f, 1.0f);
        return t * t * (3.0f - 2.0f * t);
    }

    // Generates a high-precision subpixel brush dab (RGBA 32-bit buffer)
    static void GenerateBrushDab(
        int diameter,
        float hardness,
        uint8_t r,
        uint8_t g,
        uint8_t b,
        float opacity,
        uint8_t* outBuffer
    );

    // Calculates Catmull-Rom spline points for continuous anti-aliased strokes
    static std::vector<Point2D> InterpolateStroke(
        const Point2D& p0,
        const Point2D& p1,
        const Point2D& p2,
        const Point2D& p3,
        float spacingPx
    );

    // Streamline (EMA) pointer stabilizer to eliminate hand jitter
    static Point2D StabilizePointer(
        const Point2D& current,
        const Point2D& last,
        float smoothingFactor
    );
};

} // namespace PhotoCraft
