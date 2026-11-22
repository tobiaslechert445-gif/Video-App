#pragma once
// ============================================================================
//  PhotoCraft C++ Engine - gemeinsame Hilfsfunktionen
//  Multithreading (alle CPU-Kerne), Klemmen, Farbraum-Umrechnung
// ============================================================================

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

namespace PhotoCraft {

inline uint8_t ClampByte(float v) {
    return static_cast<uint8_t>(v <= 0.0f ? 0.0f : (v >= 255.0f ? 255.0f : v + 0.5f));
}

inline uint8_t ClampByteI(int v) {
    return static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v));
}

// Teilt [0, count) in Bloecke auf und verarbeitet sie parallel.
// Kleine Bilder laufen einthreadig, um Thread-Overhead zu vermeiden.
inline void ParallelFor(int count, const std::function<void(int, int)>& fn, int minPerThread = 64) {
    if (count <= 0) return;
    unsigned hw = std::thread::hardware_concurrency();
    int threads = static_cast<int>(hw == 0 ? 4 : hw);
    threads = std::min(threads, std::max(1, count / std::max(1, minPerThread)));
    if (threads <= 1) {
        fn(0, count);
        return;
    }
    std::vector<std::thread> pool;
    pool.reserve(threads);
    int chunk = (count + threads - 1) / threads;
    for (int t = 0; t < threads; ++t) {
        int begin = t * chunk;
        int end = std::min(count, begin + chunk);
        if (begin >= end) break;
        pool.emplace_back([=, &fn]() { fn(begin, end); });
    }
    for (auto& th : pool) th.join();
}

// RGB (0..1) <-> HSL (h 0..360, s/l 0..1)
inline void RgbToHsl(float r, float g, float b, float& h, float& s, float& l) {
    float mx = std::max(r, std::max(g, b));
    float mn = std::min(r, std::min(g, b));
    l = (mx + mn) * 0.5f;
    if (mx - mn < 1e-6f) { h = 0.0f; s = 0.0f; return; }
    float d = mx - mn;
    s = l > 0.5f ? d / (2.0f - mx - mn) : d / (mx + mn);
    if (mx == r)      h = (g - b) / d + (g < b ? 6.0f : 0.0f);
    else if (mx == g) h = (b - r) / d + 2.0f;
    else              h = (r - g) / d + 4.0f;
    h *= 60.0f;
}

inline float HueToRgb(float p, float q, float t) {
    if (t < 0.0f) t += 1.0f;
    if (t > 1.0f) t -= 1.0f;
    if (t < 1.0f / 6.0f) return p + (q - p) * 6.0f * t;
    if (t < 0.5f) return q;
    if (t < 2.0f / 3.0f) return p + (q - p) * (2.0f / 3.0f - t) * 6.0f;
    return p;
}

inline void HslToRgb(float h, float s, float l, float& r, float& g, float& b) {
    if (s < 1e-6f) { r = g = b = l; return; }
    float hn = h / 360.0f;
    float q = l < 0.5f ? l * (1.0f + s) : l + s - l * s;
    float p = 2.0f * l - q;
    r = HueToRgb(p, q, hn + 1.0f / 3.0f);
    g = HueToRgb(p, q, hn);
    b = HueToRgb(p, q, hn - 1.0f / 3.0f);
}

inline float Luma(float r, float g, float b) {
    return 0.299f * r + 0.587f * g + 0.114f * b;
}

} // namespace PhotoCraft
