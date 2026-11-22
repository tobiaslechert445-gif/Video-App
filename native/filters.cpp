// ============================================================================
//  PhotoCraft C++ Engine - Filter & Effekte
//  Parallele Implementierung mit CPU-Multithreading & Subpixel-Abtastung
// ============================================================================

#include "filters.hpp"
#include "common.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstring>

namespace PhotoCraft {
namespace Filters {

namespace {

// Bilineares Samplen fuer verzerrte Filter (Twirl, Ripple etc.)
inline void SampleBilinear(const uint8_t* src, int w, int h, float x, float y, uint8_t* out) {
    if (x < 0.0f) x = 0.0f; else if (x > w - 1.0f) x = w - 1.0f;
    if (y < 0.0f) y = 0.0f; else if (y > h - 1.0f) y = h - 1.0f;

    int x0 = static_cast<int>(x);
    int y0 = static_cast<int>(y);
    int x1 = std::min(x0 + 1, w - 1);
    int y1 = std::min(y0 + 1, h - 1);

    float fx = x - x0;
    float fy = y - y0;
    float w00 = (1.0f - fx) * (1.0f - fy);
    float w10 = fx * (1.0f - fy);
    float w01 = (1.0f - fx) * fy;
    float w11 = fx * fy;

    const uint8_t* p00 = src + (y0 * w + x0) * 4;
    const uint8_t* p10 = src + (y0 * w + x1) * 4;
    const uint8_t* p01 = src + (y1 * w + x0) * 4;
    const uint8_t* p11 = src + (y1 * w + x1) * 4;

    for (int c = 0; c < 4; ++c) {
        float val = p00[c] * w00 + p10[c] * w10 + p01[c] * w01 + p11[c] * w11;
        out[c] = ClampByte(val);
    }
}

// 1-Pass horizontaler Box-Blur mit gleitender Summe (O(1) pro Pixel)
void BoxBlurH(const uint8_t* src, uint8_t* dst, int w, int h, int r) {
    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            int yOffset = y * w * 4;
            float sum[4] = { 0, 0, 0, 0 };
            int count = 0;

            for (int x = -r; x <= r; ++x) {
                int cx = std::clamp(x, 0, w - 1);
                const uint8_t* p = src + yOffset + cx * 4;
                for (int c = 0; c < 4; ++c) sum[c] += p[c];
                count++;
            }

            for (int x = 0; x < w; ++x) {
                uint8_t* out = dst + yOffset + x * 4;
                for (int c = 0; c < 4; ++c) out[c] = ClampByte(sum[c] / count);

                int leftX = std::clamp(x - r, 0, w - 1);
                int rightX = std::clamp(x + r + 1, 0, w - 1);
                const uint8_t* pLeft = src + yOffset + leftX * 4;
                const uint8_t* pRight = src + yOffset + rightX * 4;

                for (int c = 0; c < 4; ++c) sum[c] += (pRight[c] - pLeft[c]);
            }
        }
    }, 16);
}

// 1-Pass vertikaler Box-Blur mit gleitender Summe (O(1) pro Pixel)
void BoxBlurV(const uint8_t* src, uint8_t* dst, int w, int h, int r) {
    ParallelFor(w, [&](int xBegin, int xEnd) {
        for (int x = xBegin; x < xEnd; ++x) {
            float sum[4] = { 0, 0, 0, 0 };
            int count = 0;

            for (int y = -r; y <= r; ++y) {
                int cy = std::clamp(y, 0, h - 1);
                const uint8_t* p = src + (cy * w + x) * 4;
                for (int c = 0; c < 4; ++c) sum[c] += p[c];
                count++;
            }

            for (int y = 0; y < h; ++y) {
                uint8_t* out = dst + (y * w + x) * 4;
                for (int c = 0; c < 4; ++c) out[c] = ClampByte(sum[c] / count);

                int topY = std::clamp(y - r, 0, h - 1);
                int botY = std::clamp(y + r + 1, 0, h - 1);
                const uint8_t* pTop = src + (topY * w + x) * 4;
                const uint8_t* pBot = src + (botY * w + x) * 4;

                for (int c = 0; c < 4; ++c) sum[c] += (pBot[c] - pTop[c]);
            }
        }
    }, 16);
}

} // namespace

void GaussianBlur(uint8_t* px, int w, int h, float radius) {
    if (w <= 0 || h <= 0 || radius <= 0.1f) return;
    int r = std::clamp(static_cast<int>(std::round(radius)), 1, 150);

    std::vector<uint8_t> tmp(w * h * 4);
    // 3 Durchlaeufe separabler Box-Blur = nahezu identisch mit echtem Gauss-Filter nach Z-Transform
    for (int pass = 0; pass < 3; ++pass) {
        BoxBlurH(px, tmp.data(), w, h, r);
        BoxBlurV(tmp.data(), px, w, h, r);
    }
}

void MotionBlur(uint8_t* px, int w, int h, float angleDeg, float distance) {
    if (w <= 0 || h <= 0 || distance <= 0.5f) return;
    int steps = std::clamp(static_cast<int>(std::round(distance)), 1, 100);

    const float pi = 3.14159265f;
    float rad = angleDeg * (pi / 180.0f);
    float dx = std::cos(rad) * (distance / steps);
    float dy = std::sin(rad) * (distance / steps);

    std::vector<uint8_t> src(px, px + (w * h * 4));

    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            for (int x = 0; x < w; ++x) {
                float sum[4] = { 0, 0, 0, 0 };
                uint8_t sample[4];

                for (int s = -steps; s <= steps; ++s) {
                    float sx = x + s * dx;
                    float sy = y + s * dy;
                    SampleBilinear(src.data(), w, h, sx, sy, sample);
                    for (int c = 0; c < 4; ++c) sum[c] += sample[c];
                }

                int totalSamples = 2 * steps + 1;
                uint8_t* dst = px + (y * w + x) * 4;
                for (int c = 0; c < 4; ++c) dst[c] = ClampByte(sum[c] / totalSamples);
            }
        }
    }, 8);
}

void RadialZoomBlur(uint8_t* px, int w, int h, float centerX, float centerY, float amount) {
    if (w <= 0 || h <= 0 || amount <= 0.001f) return;
    float zoomFactor = std::clamp(amount, 0.01f, 1.0f);
    const int steps = 16;

    std::vector<uint8_t> src(px, px + (w * h * 4));

    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            for (int x = 0; x < w; ++x) {
                float vx = x - centerX;
                float vy = y - centerY;
                float sum[4] = { 0, 0, 0, 0 };
                uint8_t sample[4];

                for (int s = 0; s < steps; ++s) {
                    float t = static_cast<float>(s) / (steps - 1);
                    float scale = 1.0f - (t * zoomFactor * 0.5f);
                    float sx = centerX + vx * scale;
                    float sy = centerY + vy * scale;
                    SampleBilinear(src.data(), w, h, sx, sy, sample);
                    for (int c = 0; c < 4; ++c) sum[c] += sample[c];
                }

                uint8_t* dst = px + (y * w + x) * 4;
                for (int c = 0; c < 4; ++c) dst[c] = ClampByte(sum[c] / steps);
            }
        }
    }, 8);
}

void Twirl(uint8_t* px, int w, int h, float centerX, float centerY, float radius, float angleDeg) {
    if (w <= 0 || h <= 0 || radius <= 1.0f) return;
    const float pi = 3.14159265f;
    float maxAngleRad = angleDeg * (pi / 180.0f);

    std::vector<uint8_t> src(px, px + (w * h * 4));

    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            for (int x = 0; x < w; ++x) {
                float dx = x - centerX;
                float dy = y - centerY;
                float dist = std::hypot(dx, dy);

                uint8_t* dst = px + (y * w + x) * 4;

                if (dist >= radius) {
                    // Außerhalb des Radius bleibt der Pixel unveraendert
                    continue;
                }

                // Drehung nimmt quadratisch mit der Entfernung zum Zentrum ab
                float factor = (radius - dist) / radius;
                float rotAngle = maxAngleRad * factor * factor;

                float currAngle = std::atan2(dy, dx);
                float newAngle = currAngle + rotAngle;

                float sx = centerX + dist * std::cos(newAngle);
                float sy = centerY + dist * std::sin(newAngle);

                SampleBilinear(src.data(), w, h, sx, sy, dst);
            }
        }
    }, 16);
}

void Ripple(uint8_t* px, int w, int h, float amplitude, float wavelength) {
    if (w <= 0 || h <= 0 || amplitude <= 0.1f || wavelength <= 1.0f) return;
    const float pi2 = 6.2831853f;

    std::vector<uint8_t> src(px, px + (w * h * 4));

    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            for (int x = 0; x < w; ++x) {
                float sx = x + amplitude * std::sin((y / wavelength) * pi2);
                float sy = y + amplitude * std::cos((x / wavelength) * pi2);

                uint8_t* dst = px + (y * w + x) * 4;
                SampleBilinear(src.data(), w, h, sx, sy, dst);
            }
        }
    }, 16);
}

void Pixelate(uint8_t* px, int w, int h, int cellSize) {
    if (w <= 0 || h <= 0 || cellSize <= 1) return;
    cellSize = std::clamp(cellSize, 2, 128);

    int cellsY = (h + cellSize - 1) / cellSize;
    int cellsX = (w + cellSize - 1) / cellSize;

    ParallelFor(cellsY, [&](int cyBegin, int cyEnd) {
        for (int cy = cyBegin; cy < cyEnd; ++cy) {
            int y0 = cy * cellSize;
            int y1 = std::min(y0 + cellSize, h);

            for (int cx = 0; cx < cellsX; ++cx) {
                int x0 = cx * cellSize;
                int x1 = std::min(x0 + cellSize, w);

                uint32_t sumR = 0, sumG = 0, sumB = 0, sumA = 0;
                int count = 0;

                for (int y = y0; y < y1; ++y) {
                    for (int x = x0; x < x1; ++x) {
                        const uint8_t* p = px + (y * w + x) * 4;
                        sumR += p[0]; sumG += p[1]; sumB += p[2]; sumA += p[3];
                        count++;
                    }
                }

                if (count == 0) continue;
                uint8_t avgR = sumR / count;
                uint8_t avgG = sumG / count;
                uint8_t avgB = sumB / count;
                uint8_t avgA = sumA / count;

                for (int y = y0; y < y1; ++y) {
                    for (int x = x0; x < x1; ++x) {
                        uint8_t* p = px + (y * w + x) * 4;
                        p[0] = avgR; p[1] = avgG; p[2] = avgB; p[3] = avgA;
                    }
                }
            }
        }
    }, 4);
}

void OilPaint(uint8_t* px, int w, int h, int radius, int intensityLevels) {
    if (w <= 0 || h <= 0) return;
    radius = std::clamp(radius, 1, 16);
    intensityLevels = std::clamp(intensityLevels, 4, 64);

    std::vector<uint8_t> src(px, px + (w * h * 4));

    ParallelFor(h, [&](int yBegin, int yEnd) {
        std::vector<int> count(intensityLevels, 0);
        std::vector<int> sumR(intensityLevels, 0);
        std::vector<int> sumG(intensityLevels, 0);
        std::vector<int> sumB(intensityLevels, 0);

        for (int y = yBegin; y < yEnd; ++y) {
            for (int x = 0; x < w; ++x) {
                std::fill(count.begin(), count.end(), 0);
                std::fill(sumR.begin(), sumR.end(), 0);
                std::fill(sumG.begin(), sumG.end(), 0);
                std::fill(sumB.begin(), sumB.end(), 0);

                int top = std::max(0, y - radius);
                int bot = std::min(h - 1, y + radius);
                int left = std::max(0, x - radius);
                int right = std::min(w - 1, x + radius);

                for (int ny = top; ny <= bot; ++ny) {
                    for (int nx = left; nx <= right; ++nx) {
                        const uint8_t* p = src.data() + (ny * w + nx) * 4;
                        int intensity = static_cast<int>(Luma(p[0], p[1], p[2]) * intensityLevels / 256.0f);
                        intensity = std::clamp(intensity, 0, intensityLevels - 1);

                        count[intensity]++;
                        sumR[intensity] += p[0];
                        sumG[intensity] += p[1];
                        sumB[intensity] += p[2];
                    }
                }

                int maxLevel = 0;
                int maxCount = 0;
                for (int i = 0; i < intensityLevels; ++i) {
                    if (count[i] > maxCount) {
                        maxCount = count[i];
                        maxLevel = i;
                    }
                }

                uint8_t* dst = px + (y * w + x) * 4;
                if (maxCount > 0) {
                    dst[0] = ClampByte(sumR[maxLevel] / static_cast<float>(maxCount));
                    dst[1] = ClampByte(sumG[maxLevel] / static_cast<float>(maxCount));
                    dst[2] = ClampByte(sumB[maxLevel] / static_cast<float>(maxCount));
                }
            }
        }
    }, 4);
}

void HighPass(uint8_t* px, int w, int h, float radius) {
    if (w <= 0 || h <= 0 || radius <= 0.1f) return;
    std::vector<uint8_t> blurred(px, px + (w * h * 4));
    GaussianBlur(blurred.data(), w, h, radius);

    // Photoshop High Pass: Out = (Orig - Blurred) + 128
    ParallelFor(w * h, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* orig = px + i * 4;
            const uint8_t* bl = blurred.data() + i * 4;
            for (int c = 0; c < 3; ++c) {
                int diff = static_cast<int>(orig[c]) - static_cast<int>(bl[c]) + 128;
                orig[c] = ClampByteI(diff);
            }
        }
    }, 2048);
}

void FindEdges(uint8_t* px, int w, int h) {
    if (w <= 1 || h <= 1) return;
    std::vector<uint8_t> src(px, px + (w * h * 4));

    // 3x3 Sobel Operator
    ParallelFor(h, [&](int yBegin, int yEnd) {
        for (int y = yBegin; y < yEnd; ++y) {
            int yPrev = std::max(0, y - 1);
            int yNext = std::min(h - 1, y + 1);

            for (int x = 0; x < w; ++x) {
                int xPrev = std::max(0, x - 1);
                int xNext = std::min(w - 1, x + 1);

                for (int c = 0; c < 3; ++c) {
                    int p00 = src[(yPrev * w + xPrev) * 4 + c];
                    int p01 = src[(yPrev * w + x) * 4 + c];
                    int p02 = src[(yPrev * w + xNext) * 4 + c];
                    int p10 = src[(y * w + xPrev) * 4 + c];
                    int p12 = src[(y * w + xNext) * 4 + c];
                    int p20 = src[(yNext * w + xPrev) * 4 + c];
                    int p21 = src[(yNext * w + x) * 4 + c];
                    int p22 = src[(yNext * w + xNext) * 4 + c];

                    int gx = (-1 * p00) + (1 * p02) + (-2 * p10) + (2 * p12) + (-1 * p20) + (1 * p22);
                    int gy = (-1 * p00) + (-2 * p01) + (-1 * p02) + (1 * p20) + (2 * p21) + (1 * p22);

                    int mag = static_cast<int>(std::hypot(gx, gy));
                    // Photoshop Find Edges invertiert die Kanten (Weißer Hintergrund, dunkle Kanten)
                    px[(y * w + x) * 4 + c] = ClampByteI(255 - mag);
                }
            }
        }
    }, 8);
}

} // namespace Filters
} // namespace PhotoCraft
