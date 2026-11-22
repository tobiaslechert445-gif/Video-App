#include "brush_engine.hpp"

namespace PhotoCraft {

BrushEngine::BrushEngine() {}
BrushEngine::~BrushEngine() {}

void BrushEngine::GenerateBrushDab(
    int diameter,
    float hardness,
    uint8_t r,
    uint8_t g,
    uint8_t b,
    float opacity,
    uint8_t* outBuffer
) {
    if (diameter <= 0 || !outBuffer) return;

    const float radius = diameter * 0.5f;
    const float innerRadius = radius * std::clamp(hardness, 0.0f, 0.999f);
    const float radiusDiff = std::max(0.001f, radius - innerRadius);
    const float baseAlpha = std::clamp(opacity, 0.0f, 1.0f);

    for (int y = 0; y < diameter; ++y) {
        float dy = (y + 0.5f) - radius;
        float dy2 = dy * dy;

        int rowOffset = y * diameter * 4;

        for (int x = 0; x < diameter; ++x) {
            float dx = (x + 0.5f) - radius;
            float dist = std::sqrt(dx * dx + dy2);

            int pixelIdx = rowOffset + (x * 4);

            if (dist >= radius) {
                outBuffer[pixelIdx + 0] = 0;
                outBuffer[pixelIdx + 1] = 0;
                outBuffer[pixelIdx + 2] = 0;
                outBuffer[pixelIdx + 3] = 0;
            } else if (dist <= innerRadius) {
                outBuffer[pixelIdx + 0] = r;
                outBuffer[pixelIdx + 1] = g;
                outBuffer[pixelIdx + 2] = b;
                outBuffer[pixelIdx + 3] = static_cast<uint8_t>(255.0f * baseAlpha);
            } else {
                // Hermite smoothstep falloff between innerRadius and radius
                float t = (dist - innerRadius) / radiusDiff;
                float falloff = 1.0f - (t * t * (3.0f - 2.0f * t));
                float finalAlpha = baseAlpha * falloff;

                outBuffer[pixelIdx + 0] = r;
                outBuffer[pixelIdx + 1] = g;
                outBuffer[pixelIdx + 2] = b;
                outBuffer[pixelIdx + 3] = static_cast<uint8_t>(std::clamp(255.0f * finalAlpha, 0.0f, 255.0f));
            }
        }
    }
}

std::vector<Point2D> BrushEngine::InterpolateStroke(
    const Point2D& p0,
    const Point2D& p1,
    const Point2D& p2,
    const Point2D& p3,
    float spacingPx
) {
    std::vector<Point2D> points;
    float approxDist = std::hypot(p2.x - p1.x, p2.y - p1.y);
    if (approxDist < 0.001f) {
        points.push_back(p1);
        return points;
    }

    float step = std::max(0.5f, spacingPx);
    int numSteps = std::max(1, static_cast<int>(std::ceil(approxDist / step)));

    points.reserve(numSteps + 1);

    for (int i = 0; i <= numSteps; ++i) {
        float t = static_cast<float>(i) / static_cast<float>(numSteps);
        float t2 = t * t;
        float t3 = t2 * t;

        // Catmull-Rom spline formula
        float x = 0.5f * (
            (2.0f * p1.x) +
            (-p0.x + p2.x) * t +
            (2.0f * p0.x - 5.0f * p1.x + 4.0f * p2.x - p3.x) * t2 +
            (-p0.x + 3.0f * p1.x - 3.0f * p2.x + p3.x) * t3
        );

        float y = 0.5f * (
            (2.0f * p1.y) +
            (-p0.y + p2.y) * t +
            (2.0f * p0.y - 5.0f * p1.y + 4.0f * p2.y - p3.y) * t2 +
            (-p0.y + 3.0f * p1.y - 3.0f * p2.y + p3.y) * t3
        );

        // Linear interpolation for pressure
        float pressure = p1.pressure + (p2.pressure - p1.pressure) * t;

        points.push_back({ x, y, pressure });
    }

    return points;
}

Point2D BrushEngine::StabilizePointer(
    const Point2D& current,
    const Point2D& last,
    float smoothingFactor
) {
    float alpha = 1.0f - std::clamp(smoothingFactor, 0.0f, 0.95f);
    return {
        last.x + (current.x - last.x) * alpha,
        last.y + (current.y - last.y) * alpha,
        last.pressure + (current.pressure - last.pressure) * alpha
    };
}

} // namespace PhotoCraft
