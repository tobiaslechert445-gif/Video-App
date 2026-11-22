#include "pixel_ops.hpp"
#include <queue>
#include <cstring>
#include <cmath>

namespace PhotoCraft {

static inline uint8_t BlendChannel(uint8_t d, uint8_t s, BlendMode mode) {
    switch (mode) {
        case BlendMode::Multiply:
            return static_cast<uint8_t>((static_cast<int>(s) * d) / 255);
        case BlendMode::Screen:
            return static_cast<uint8_t>(255 - (((255 - s) * (255 - d)) / 255));
        case BlendMode::Overlay:
            return (d < 128)
                ? static_cast<uint8_t>((2 * s * d) / 255)
                : static_cast<uint8_t>(255 - (2 * (255 - s) * (255 - d)) / 255);
        case BlendMode::Darken:
            return std::min(s, d);
        case BlendMode::Lighten:
            return std::max(s, d);
        case BlendMode::ColorDodge:
            if (s >= 255) return 255;
            return static_cast<uint8_t>(std::min(255, (d * 255) / (255 - s)));
        case BlendMode::ColorBurn:
            if (s == 0) return 0;
            return static_cast<uint8_t>(255 - std::min(255, ((255 - d) * 255) / s));
        case BlendMode::HardLight:
            return (s < 128)
                ? static_cast<uint8_t>((2 * s * d) / 255)
                : static_cast<uint8_t>(255 - (2 * (255 - s) * (255 - d)) / 255);
        case BlendMode::SoftLight: {
            float sf = s / 255.0f;
            float df = d / 255.0f;
            float res = (sf < 0.5f)
                ? (df - (1.0f - 2.0f * sf) * df * (1.0f - df))
                : (df + (2.0f * sf - 1.0f) * (std::sqrt(df) - df));
            return static_cast<uint8_t>(std::clamp(res * 255.0f, 0.0f, 255.0f));
        }
        case BlendMode::Difference:
            return static_cast<uint8_t>(std::abs(static_cast<int>(s) - static_cast<int>(d)));
        case BlendMode::Exclusion:
            return static_cast<uint8_t>(s + d - (2 * s * d) / 255);
        case BlendMode::Add:
            return static_cast<uint8_t>(std::min(255, static_cast<int>(s) + static_cast<int>(d)));
        case BlendMode::Normal:
        default:
            return s;
    }
}

void PixelOps::BlendBuffers(
    uint8_t* dest,
    const uint8_t* src,
    int pixelCount,
    BlendMode mode,
    float opacity
) {
    if (!dest || !src || pixelCount <= 0) return;
    const float layerAlpha = std::clamp(opacity, 0.0f, 1.0f);

    for (int i = 0; i < pixelCount; ++i) {
        int idx = i * 4;
        uint8_t sa = src[idx + 3];
        if (sa == 0) continue;

        float srcAlpha = (sa / 255.0f) * layerAlpha;
        if (srcAlpha <= 0.0001f) continue;

        uint8_t da = dest[idx + 3];
        float dstAlpha = da / 255.0f;

        uint8_t sr = src[idx + 0];
        uint8_t sg = src[idx + 1];
        uint8_t sb = src[idx + 2];

        uint8_t dr = dest[idx + 0];
        uint8_t dg = dest[idx + 1];
        uint8_t db = dest[idx + 2];

        // Compute blend mode channel value
        uint8_t br = BlendChannel(dr, sr, mode);
        uint8_t bg = BlendChannel(dg, sg, mode);
        uint8_t bb = BlendChannel(db, sb, mode);

        // Alpha compositing: out = blended * srcAlpha + dst * (1 - srcAlpha)
        float outAlpha = srcAlpha + dstAlpha * (1.0f - srcAlpha);
        if (outAlpha > 0.0f) {
            dest[idx + 0] = static_cast<uint8_t>(std::clamp((br * srcAlpha + dr * dstAlpha * (1.0f - srcAlpha)) / outAlpha, 0.0f, 255.0f));
            dest[idx + 1] = static_cast<uint8_t>(std::clamp((bg * srcAlpha + dg * dstAlpha * (1.0f - srcAlpha)) / outAlpha, 0.0f, 255.0f));
            dest[idx + 2] = static_cast<uint8_t>(std::clamp((bb * srcAlpha + db * dstAlpha * (1.0f - srcAlpha)) / outAlpha, 0.0f, 255.0f));
            dest[idx + 3] = static_cast<uint8_t>(std::clamp(outAlpha * 255.0f, 0.0f, 255.0f));
        }
    }
}

// Separable fast box-blur approximation of Gaussian Blur
void PixelOps::FastGaussianBlur(uint8_t* pixels, int width, int height, int radius) {
    if (!pixels || width <= 0 || height <= 0 || radius <= 0) return;
    radius = std::clamp(radius, 1, 64);

    std::vector<uint8_t> temp(width * height * 4);
    int totalPixels = width * height;

    // Horizontal pass
    for (int y = 0; y < height; ++y) {
        int yOffset = y * width;
        int sumR = 0, sumG = 0, sumB = 0, sumA = 0;
        int windowSize = 0;

        // Preload window
        for (int x = -radius; x <= radius; ++x) {
            int cx = std::clamp(x, 0, width - 1);
            int idx = (yOffset + cx) * 4;
            sumR += pixels[idx + 0];
            sumG += pixels[idx + 1];
            sumB += pixels[idx + 2];
            sumA += pixels[idx + 3];
            windowSize++;
        }

        for (int x = 0; x < width; ++x) {
            int outIdx = (yOffset + x) * 4;
            temp[outIdx + 0] = sumR / windowSize;
            temp[outIdx + 1] = sumG / windowSize;
            temp[outIdx + 2] = sumB / windowSize;
            temp[outIdx + 3] = sumA / windowSize;

            // Slide window: remove leftmost, add rightmost
            int leftX = std::clamp(x - radius, 0, width - 1);
            int rightX = std::clamp(x + radius + 1, 0, width - 1);
            int lIdx = (yOffset + leftX) * 4;
            int rIdx = (yOffset + rightX) * 4;

            sumR += pixels[rIdx + 0] - pixels[lIdx + 0];
            sumG += pixels[rIdx + 1] - pixels[lIdx + 1];
            sumB += pixels[rIdx + 2] - pixels[lIdx + 2];
            sumA += pixels[rIdx + 3] - pixels[lIdx + 3];
        }
    }

    // Vertical pass
    for (int x = 0; x < width; ++x) {
        int sumR = 0, sumG = 0, sumB = 0, sumA = 0;
        int windowSize = 0;

        for (int y = -radius; y <= radius; ++y) {
            int cy = std::clamp(y, 0, height - 1);
            int idx = (cy * width + x) * 4;
            sumR += temp[idx + 0];
            sumG += temp[idx + 1];
            sumB += temp[idx + 2];
            sumA += temp[idx + 3];
            windowSize++;
        }

        for (int y = 0; y < height; ++y) {
            int outIdx = (y * width + x) * 4;
            pixels[outIdx + 0] = sumR / windowSize;
            pixels[outIdx + 1] = sumG / windowSize;
            pixels[outIdx + 2] = sumB / windowSize;
            pixels[outIdx + 3] = sumA / windowSize;

            int topY = std::clamp(y - radius, 0, height - 1);
            int botY = std::clamp(y + radius + 1, 0, height - 1);
            int tIdx = (topY * width + x) * 4;
            int bIdx = (botY * width + x) * 4;

            sumR += temp[bIdx + 0] - temp[tIdx + 0];
            sumG += temp[bIdx + 1] - temp[tIdx + 1];
            sumB += temp[bIdx + 2] - temp[tIdx + 2];
            sumA += temp[bIdx + 3] - temp[tIdx + 3];
        }
    }
}

void PixelOps::Sharpen(uint8_t* pixels, int width, int height, float amount) {
    if (!pixels || width <= 1 || height <= 1) return;
    std::vector<uint8_t> copy(pixels, pixels + (width * height * 4));

    float kCenter = 1.0f + 4.0f * amount;
    float kEdge = -amount;

    for (int y = 1; y < height - 1; ++y) {
        for (int x = 1; x < width - 1; ++x) {
            int cIdx = (y * width + x) * 4;
            int tIdx = ((y - 1) * width + x) * 4;
            int bIdx = ((y + 1) * width + x) * 4;
            int lIdx = (y * width + (x - 1)) * 4;
            int rIdx = (y * width + (x + 1)) * 4;

            for (int ch = 0; ch < 3; ++ch) {
                float val = copy[cIdx + ch] * kCenter +
                    (copy[tIdx + ch] + copy[bIdx + ch] + copy[lIdx + ch] + copy[rIdx + ch]) * kEdge;
                pixels[cIdx + ch] = static_cast<uint8_t>(std::clamp(val, 0.0f, 255.0f));
            }
        }
    }
}

void PixelOps::AdjustColors(
    uint8_t* pixels,
    int pixelCount,
    float brightness,
    float contrast,
    float saturation
) {
    if (!pixels || pixelCount <= 0) return;

    // Contrast multiplier
    float factor = (259.0f * (contrast * 255.0f + 255.0f)) / (255.0f * (259.0f - contrast * 255.0f));
    float bOffset = brightness * 255.0f;
    float satMult = 1.0f + saturation;

    for (int i = 0; i < pixelCount; ++i) {
        int idx = i * 4;
        for (int ch = 0; ch < 3; ++ch) {
            float val = pixels[idx + ch];
            // Brightness & Contrast
            val = factor * (val - 128.0f) + 128.0f + bOffset;
            pixels[idx + ch] = static_cast<uint8_t>(std::clamp(val, 0.0f, 255.0f));
        }

        // Saturation
        if (std::abs(saturation) > 0.001f) {
            float r = pixels[idx + 0];
            float g = pixels[idx + 1];
            float b = pixels[idx + 2];
            float gray = 0.2989f * r + 0.5870f * g + 0.1140f * b;

            pixels[idx + 0] = static_cast<uint8_t>(std::clamp(gray + (r - gray) * satMult, 0.0f, 255.0f));
            pixels[idx + 1] = static_cast<uint8_t>(std::clamp(gray + (g - gray) * satMult, 0.0f, 255.0f));
            pixels[idx + 2] = static_cast<uint8_t>(std::clamp(gray + (b - gray) * satMult, 0.0f, 255.0f));
        }
    }
}

int PixelOps::FloodFill(
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
) {
    if (!pixels || startX < 0 || startX >= width || startY < 0 || startY >= height) return 0;

    int startIdx = (startY * width + startX) * 4;
    uint8_t targetR = pixels[startIdx + 0];
    uint8_t targetG = pixels[startIdx + 1];
    uint8_t targetB = pixels[startIdx + 2];
    uint8_t targetA = pixels[startIdx + 3];

    // If target and fill color are already identical, nothing to do
    if (std::abs(targetR - fillR) <= tolerance &&
        std::abs(targetG - fillG) <= tolerance &&
        std::abs(targetB - fillB) <= tolerance &&
        std::abs(targetA - fillA) <= tolerance) {
        return 0;
    }

    auto colorMatch = [&](int idx) -> bool {
        return (std::abs(pixels[idx + 0] - targetR) <= tolerance &&
                std::abs(pixels[idx + 1] - targetG) <= tolerance &&
                std::abs(pixels[idx + 2] - targetB) <= tolerance &&
                std::abs(pixels[idx + 3] - targetA) <= tolerance);
    };

    std::vector<bool> visited(width * height, false);
    std::queue<std::pair<int, int>> q;

    q.push({ startX, startY });
    visited[startY * width + startX] = true;
    int filledCount = 0;

    while (!q.empty()) {
        auto [cx, cy] = q.front();
        q.pop();

        int idx = (cy * width + cx) * 4;
        pixels[idx + 0] = fillR;
        pixels[idx + 1] = fillG;
        pixels[idx + 2] = fillB;
        pixels[idx + 3] = fillA;
        filledCount++;

        // 4-neighborhood
        const int dx[4] = { 0, 0, -1, 1 };
        const int dy[4] = { -1, 1, 0, 0 };

        for (int i = 0; i < 4; ++i) {
            int nx = cx + dx[i];
            int ny = cy + dy[i];

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                int nPos = ny * width + nx;
                if (!visited[nPos]) {
                    int nIdx = nPos * 4;
                    if (colorMatch(nIdx)) {
                        visited[nPos] = true;
                        q.push({ nx, ny });
                    }
                }
            }
        }
    }

    return filledCount;
}

} // namespace PhotoCraft
