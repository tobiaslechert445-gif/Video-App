// ============================================================================
//  PhotoCraft C++ Engine - Bildkorrekturen
//  Algorithmen nach Photoshop-/PhotoCraft-Verhalten, als LUT (Lookup-Tabelle)
//  wo moeglich, damit auch grosse Ebenen in Millisekunden berechnet werden.
// ============================================================================

#include "adjustments.hpp"
#include "common.hpp"

#include <array>
#include <cmath>
#include <cstring>

namespace PhotoCraft {
namespace Adjust {

namespace {

using Lut = std::array<uint8_t, 256>;

// Wendet je eine LUT auf R, G, B an (Alpha bleibt unveraendert)
void ApplyLuts(uint8_t* px, int n, const Lut& lr, const Lut& lg, const Lut& lb) {
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            p[0] = lr[p[0]];
            p[1] = lg[p[1]];
            p[2] = lb[p[2]];
        }
    }, 4096);
}

Lut IdentityLut() {
    Lut l;
    for (int i = 0; i < 256; ++i) l[i] = static_cast<uint8_t>(i);
    return l;
}

void ApplyChannelLut(uint8_t* px, int n, int channel, const Lut& lut) {
    Lut id = IdentityLut();
    switch (channel) {
        case 1: ApplyLuts(px, n, lut, id, id); break;
        case 2: ApplyLuts(px, n, id, lut, id); break;
        case 3: ApplyLuts(px, n, id, id, lut); break;
        default: ApplyLuts(px, n, lut, lut, lut); break;
    }
}

// Monotone kubische Interpolation (Fritsch-Carlson) - keine Ueberschwinger,
// genau wie der Kurven-Editor von Photoshop/PhotoCraft sich anfuehlt.
Lut BuildCurveLut(std::vector<float> xs, std::vector<float> ys) {
    Lut lut = IdentityLut();
    size_t n = std::min(xs.size(), ys.size());
    if (n < 2) return lut;

    std::vector<std::pair<float, float>> pts(n);
    for (size_t i = 0; i < n; ++i) pts[i] = { std::clamp(xs[i], 0.0f, 255.0f), std::clamp(ys[i], 0.0f, 255.0f) };
    std::sort(pts.begin(), pts.end());
    // doppelte X-Werte entfernen
    std::vector<std::pair<float, float>> p;
    for (auto& q : pts) {
        if (p.empty() || q.first - p.back().first > 0.5f) p.push_back(q);
        else p.back().second = q.second;
    }
    n = p.size();
    if (n < 2) {
        for (int i = 0; i < 256; ++i) lut[i] = ClampByte(p.empty() ? static_cast<float>(i) : p[0].second);
        return lut;
    }

    std::vector<float> d(n - 1), m(n);
    for (size_t i = 0; i + 1 < n; ++i) d[i] = (p[i + 1].second - p[i].second) / (p[i + 1].first - p[i].first);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (size_t i = 1; i + 1 < n; ++i) m[i] = (d[i - 1] * d[i] <= 0.0f) ? 0.0f : (d[i - 1] + d[i]) * 0.5f;
    for (size_t i = 0; i + 1 < n; ++i) {
        if (std::fabs(d[i]) < 1e-6f) { m[i] = 0.0f; m[i + 1] = 0.0f; continue; }
        float a = m[i] / d[i], b = m[i + 1] / d[i];
        float s = a * a + b * b;
        if (s > 9.0f) {
            float t = 3.0f / std::sqrt(s);
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }

    for (int x = 0; x < 256; ++x) {
        float fx = static_cast<float>(x);
        float y;
        if (fx <= p[0].first) y = p[0].second;
        else if (fx >= p[n - 1].first) y = p[n - 1].second;
        else {
            size_t k = 0;
            while (k + 1 < n && fx > p[k + 1].first) ++k;
            float h = p[k + 1].first - p[k].first;
            float t = (fx - p[k].first) / h;
            float t2 = t * t, t3 = t2 * t;
            y = (2 * t3 - 3 * t2 + 1) * p[k].second + (t3 - 2 * t2 + t) * h * m[k] +
                (-2 * t3 + 3 * t2) * p[k + 1].second + (t3 - t2) * h * m[k + 1];
        }
        lut[x] = ClampByte(y);
    }
    return lut;
}

inline float SrgbToLinear(float c) {
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
inline float LinearToSrgb(float c) {
    c = std::clamp(c, 0.0f, 1.0f);
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}

} // namespace

void Levels(uint8_t* px, int n, int channel, float inBlack, float inWhite, float gamma, float outBlack, float outWhite) {
    inBlack = std::clamp(inBlack, 0.0f, 254.0f);
    inWhite = std::clamp(inWhite, inBlack + 1.0f, 255.0f);
    gamma = std::clamp(gamma, 0.01f, 9.99f);
    Lut lut;
    for (int i = 0; i < 256; ++i) {
        float t = std::clamp((i - inBlack) / (inWhite - inBlack), 0.0f, 1.0f);
        t = std::pow(t, 1.0f / gamma);
        lut[i] = ClampByte(outBlack + t * (outWhite - outBlack));
    }
    ApplyChannelLut(px, n, channel, lut);
}

void Curves(uint8_t* px, int n, int channel, const std::vector<float>& xs, const std::vector<float>& ys) {
    ApplyChannelLut(px, n, channel, BuildCurveLut(xs, ys));
}

void BrightnessContrast(uint8_t* px, int n, float brightness, float contrast) {
    brightness = std::clamp(brightness, -150.0f, 150.0f);
    contrast = std::clamp(contrast, -100.0f, 100.0f);
    const float pi = 3.14159265f;
    float cf = std::tan((contrast / 100.0f + 1.0f) * pi / 4.0f);
    Lut lut;
    for (int i = 0; i < 256; ++i) {
        float v = i + brightness * (brightness > 0 ? (255.0f - i) / 255.0f : i / 255.0f);
        v = (v - 127.5f) * cf + 127.5f;
        lut[i] = ClampByte(v);
    }
    ApplyLuts(px, n, lut, lut, lut);
}

void HueSaturation(uint8_t* px, int n, float hue, float saturation, float lightness, bool colorize) {
    float satK = std::clamp(saturation, -100.0f, 100.0f) / 100.0f;
    float litK = std::clamp(lightness, -100.0f, 100.0f) / 100.0f;
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            float r = p[0] / 255.0f, g = p[1] / 255.0f, bl = p[2] / 255.0f;
            float h, s, l;
            if (colorize) {
                h = std::fmod(hue + 360.0f, 360.0f);
                s = std::clamp((saturation + 100.0f) / 200.0f, 0.0f, 1.0f);
                l = Luma(r, g, bl);
            } else {
                RgbToHsl(r, g, bl, h, s, l);
                h = std::fmod(h + hue + 720.0f, 360.0f);
                s = satK >= 0 ? s + (1.0f - s) * satK * s : s * (1.0f + satK);
                s = std::clamp(s, 0.0f, 1.0f);
            }
            l = litK >= 0 ? l * (1.0f - litK) + litK : l * (1.0f + litK);
            HslToRgb(h, s, std::clamp(l, 0.0f, 1.0f), r, g, bl);
            p[0] = ClampByte(r * 255.0f);
            p[1] = ClampByte(g * 255.0f);
            p[2] = ClampByte(bl * 255.0f);
        }
    }, 2048);
}

void Vibrance(uint8_t* px, int n, float vibrance, float saturation) {
    float vk = std::clamp(vibrance, -100.0f, 100.0f) / 100.0f;
    float sk = 1.0f + std::clamp(saturation, -100.0f, 100.0f) / 100.0f;
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            float r = p[0], g = p[1], bl = p[2];
            float mx = std::max(r, std::max(g, bl)), mn = std::min(r, std::min(g, bl));
            float sat = mx > 0 ? (mx - mn) / mx : 0.0f;
            // Vibrance: wenig gesaettigte Farben staerker, Hauttoene (r>g>b) geschont
            float skin = (r > g && g > bl) ? 0.5f : 1.0f;
            float scale = (1.0f + vk * (1.0f - sat) * skin) * sk;
            float y = Luma(r, g, bl);
            p[0] = ClampByte(y + (r - y) * scale);
            p[1] = ClampByte(y + (g - y) * scale);
            p[2] = ClampByte(y + (bl - y) * scale);
        }
    }, 4096);
}

void BlackWhite(uint8_t* px, int n, const float weights[6], bool tint, float tintHue, float tintSat) {
    // weights: Rot, Gelb, Gruen, Cyan, Blau, Magenta (in %, Photoshop-Standard 40/60/40/60/20/80)
    float w[6];
    for (int k = 0; k < 6; ++k) w[k] = weights[k] / 100.0f;
    float tr = 1, tg = 1, tb = 1;
    if (tint) HslToRgb(std::fmod(tintHue + 360.0f, 360.0f), std::clamp(tintSat / 100.0f, 0.0f, 1.0f), 0.5f, tr, tg, tb);

    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            float c[3] = { static_cast<float>(p[0]), static_cast<float>(p[1]), static_cast<float>(p[2]) };
            int iMax = 0, iMin = 0;
            for (int k = 1; k < 3; ++k) { if (c[k] > c[iMax]) iMax = k; if (c[k] < c[iMin]) iMin = k; }
            if (iMax == iMin) { iMin = (iMax + 1) % 3; }
            int iMid = 3 - iMax - iMin;
            float mx = c[iMax], md = c[iMid], mn = c[iMin];
            // Primaerfarbe: R=0, G=2, B=4 ; Sekundaer: Gelb(R+G)=1, Cyan(G+B)=3, Magenta(R+B)=5
            static const int primary[3] = { 0, 2, 4 };
            int sec;
            int lo = std::min(iMax, iMid), hi = std::max(iMax, iMid);
            if (lo == 0 && hi == 1) sec = 1;
            else if (lo == 1 && hi == 2) sec = 3;
            else sec = 5;
            float gray = mn + (md - mn) * w[sec] + (mx - md) * w[primary[iMax]];
            gray = std::clamp(gray, 0.0f, 255.0f);
            if (tint) {
                // Tonung ueber Overlay-artige Mischung, Helligkeit bleibt erhalten
                float l = gray / 255.0f;
                float rr, gg, bb;
                if (l < 0.5f) { rr = 2 * l * tr; gg = 2 * l * tg; bb = 2 * l * tb; }
                else { rr = 1 - 2 * (1 - l) * (1 - tr); gg = 1 - 2 * (1 - l) * (1 - tg); bb = 1 - 2 * (1 - l) * (1 - tb); }
                p[0] = ClampByte(rr * 255.0f); p[1] = ClampByte(gg * 255.0f); p[2] = ClampByte(bb * 255.0f);
            } else {
                uint8_t v = ClampByte(gray);
                p[0] = p[1] = p[2] = v;
            }
        }
    }, 4096);
}

void PhotoFilter(uint8_t* px, int n, uint8_t fr, uint8_t fg, uint8_t fb, float density, bool preserveLum) {
    float d = std::clamp(density, 0.0f, 100.0f) / 100.0f;
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            float r = p[0], g = p[1], bl = p[2];
            float y0 = Luma(r, g, bl);
            // Multiplikative Filterfarbe (wie ein Glasfilter vor der Linse)
            float nr = r + (r * fr / 255.0f - r) * d;
            float ng = g + (g * fg / 255.0f - g) * d;
            float nb = bl + (bl * fb / 255.0f - bl) * d;
            if (preserveLum) {
                float y1 = Luma(nr, ng, nb);
                if (y1 > 0.01f) { float k = y0 / y1; nr *= k; ng *= k; nb *= k; }
            }
            p[0] = ClampByte(nr); p[1] = ClampByte(ng); p[2] = ClampByte(nb);
        }
    }, 4096);
}

void Exposure(uint8_t* px, int n, float exposure, float offset, float gamma) {
    float mul = std::pow(2.0f, std::clamp(exposure, -20.0f, 20.0f));
    float invG = 1.0f / std::clamp(gamma, 0.01f, 9.99f);
    Lut lut;
    for (int i = 0; i < 256; ++i) {
        float lin = SrgbToLinear(i / 255.0f);
        lin = lin * mul + offset;
        lin = std::pow(std::max(0.0f, lin), invG);
        lut[i] = ClampByte(LinearToSrgb(lin) * 255.0f);
    }
    ApplyLuts(px, n, lut, lut, lut);
}

void ColorBalance(uint8_t* px, int n, const float sh[3], const float mid[3], const float hl[3], bool preserveLum) {
    // Gewichtungskurven fuer Tiefen / Mitteltoene / Lichter (wie GIMP/Photoshop)
    const float a = 0.25f, bb = 0.333f, scale = 0.7f;
    Lut luts[3];
    for (int c = 0; c < 3; ++c) {
        for (int i = 0; i < 256; ++i) {
            float v = i / 255.0f;
            float ws = std::clamp((v - bb) / -a + 0.5f, 0.0f, 1.0f) * scale;
            float wm = std::clamp((v - bb) / a + 0.5f, 0.0f, 1.0f) * std::clamp((v + bb - 1.0f) / -a + 0.5f, 0.0f, 1.0f) * scale;
            float wh = std::clamp((v + bb - 1.0f) / a + 0.5f, 0.0f, 1.0f) * scale;
            float out = v + (sh[c] / 100.0f) * ws + (mid[c] / 100.0f) * wm + (hl[c] / 100.0f) * wh;
            luts[c][i] = ClampByte(out * 255.0f);
        }
    }
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            float r0 = p[0] / 255.0f, g0 = p[1] / 255.0f, b0 = p[2] / 255.0f;
            float r = luts[0][p[0]] / 255.0f, g = luts[1][p[1]] / 255.0f, bl = luts[2][p[2]] / 255.0f;
            if (preserveLum) {
                float h, s, l, h0, s0, l0;
                RgbToHsl(r, g, bl, h, s, l);
                RgbToHsl(r0, g0, b0, h0, s0, l0);
                HslToRgb(h, s, l0, r, g, bl);
            }
            p[0] = ClampByte(r * 255.0f); p[1] = ClampByte(g * 255.0f); p[2] = ClampByte(bl * 255.0f);
        }
    }, 2048);
}

void Invert(uint8_t* px, int n) {
    Lut lut;
    for (int i = 0; i < 256; ++i) lut[i] = static_cast<uint8_t>(255 - i);
    ApplyLuts(px, n, lut, lut, lut);
}

void Posterize(uint8_t* px, int n, int levels) {
    levels = std::clamp(levels, 2, 255);
    Lut lut;
    for (int i = 0; i < 256; ++i) {
        int step = static_cast<int>(std::floor(i * levels / 256.0f));
        lut[i] = ClampByte(step * 255.0f / (levels - 1));
    }
    ApplyLuts(px, n, lut, lut, lut);
}

void Threshold(uint8_t* px, int n, int level) {
    level = std::clamp(level, 1, 255);
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            uint8_t v = Luma(p[0], p[1], p[2]) >= level ? 255 : 0;
            p[0] = p[1] = p[2] = v;
        }
    }, 4096);
}

void Desaturate(uint8_t* px, int n) {
    ParallelFor(n, [&](int b, int e) {
        for (int i = b; i < e; ++i) {
            uint8_t* p = px + static_cast<size_t>(i) * 4;
            if (p[3] == 0) continue;
            uint8_t v = ClampByte(Luma(p[0], p[1], p[2]));
            p[0] = p[1] = p[2] = v;
        }
    }, 4096);
}

void Histogram(const uint8_t* px, int n, uint32_t* out) {
    std::memset(out, 0, sizeof(uint32_t) * 1024);
    for (int i = 0; i < n; ++i) {
        const uint8_t* p = px + static_cast<size_t>(i) * 4;
        if (p[3] == 0) continue;
        out[p[0]]++;
        out[256 + p[1]]++;
        out[512 + p[2]]++;
        out[768 + ClampByte(Luma(p[0], p[1], p[2]))]++;
    }
}

void Equalize(uint8_t* px, int n) {
    std::vector<uint32_t> hist(1024);
    Histogram(px, n, hist.data());
    uint64_t total = 0;
    for (int i = 0; i < 256; ++i) total += hist[768 + i];
    if (total == 0) return;
    Lut lut;
    uint64_t cdf = 0, cdfMin = 0;
    for (int i = 0; i < 256; ++i) { if (hist[768 + i]) { cdfMin = hist[768 + i]; break; } }
    for (int i = 0; i < 256; ++i) {
        cdf += hist[768 + i];
        float v = total > cdfMin ? (static_cast<float>(cdf - cdfMin) / static_cast<float>(total - cdfMin)) * 255.0f : static_cast<float>(i);
        lut[i] = ClampByte(v);
    }
    ApplyLuts(px, n, lut, lut, lut);
}

void AutoContrast(uint8_t* px, int n, float clipPercent) {
    std::vector<uint32_t> hist(1024);
    Histogram(px, n, hist.data());
    uint64_t total = 0;
    for (int i = 0; i < 256; ++i) total += hist[768 + i];
    if (total == 0) return;
    uint64_t clip = static_cast<uint64_t>(total * std::clamp(clipPercent, 0.0f, 10.0f) / 100.0f);
    int lo = 0, hi = 255;
    uint64_t acc = 0;
    for (lo = 0; lo < 255; ++lo) { acc += hist[768 + lo]; if (acc > clip) break; }
    acc = 0;
    for (hi = 255; hi > 0; --hi) { acc += hist[768 + hi]; if (acc > clip) break; }
    if (hi <= lo) return;
    Levels(px, n, 0, static_cast<float>(lo), static_cast<float>(hi), 1.0f, 0.0f, 255.0f);
}

} // namespace Adjust
} // namespace PhotoCraft
