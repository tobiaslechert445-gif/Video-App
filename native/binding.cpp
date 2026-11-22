#include <napi.h>
#include "brush_engine.hpp"
#include "pixel_ops.hpp"
#include "adjustments.hpp"
#include "filters.hpp"

// -------------------------------------------------------------
//  BRUSH ENGINE WRAPPERS
// -------------------------------------------------------------

Napi::Value GenerateBrushDabWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) return env.Null();

    int diameter = info[0].As<Napi::Number>().Int32Value();
    float hardness = info[1].As<Napi::Number>().FloatValue();
    uint8_t r = static_cast<uint8_t>(info[2].As<Napi::Number>().Uint32Value());
    uint8_t g = static_cast<uint8_t>(info[3].As<Napi::Number>().Uint32Value());
    uint8_t b = static_cast<uint8_t>(info[4].As<Napi::Number>().Uint32Value());
    float opacity = info[5].As<Napi::Number>().FloatValue();

    if (diameter <= 0) diameter = 1;
    size_t size = static_cast<size_t>(diameter) * diameter * 4;
    Napi::Buffer<uint8_t> outBuffer = Napi::Buffer<uint8_t>::New(env, size);

    PhotoCraft::BrushEngine::GenerateBrushDab(diameter, hardness, r, g, b, opacity, outBuffer.Data());
    return outBuffer;
}

Napi::Value InterpolateStrokeWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();

    auto toPoint = [](Napi::Object obj) -> PhotoCraft::Point2D {
        float x = obj.Get("x").As<Napi::Number>().FloatValue();
        float y = obj.Get("y").As<Napi::Number>().FloatValue();
        float p = obj.Has("pressure") ? obj.Get("pressure").As<Napi::Number>().FloatValue() : 1.0f;
        return { x, y, p };
    };

    PhotoCraft::Point2D p0 = toPoint(info[0].As<Napi::Object>());
    PhotoCraft::Point2D p1 = toPoint(info[1].As<Napi::Object>());
    PhotoCraft::Point2D p2 = toPoint(info[2].As<Napi::Object>());
    PhotoCraft::Point2D p3 = toPoint(info[3].As<Napi::Object>());
    float spacing = info[4].As<Napi::Number>().FloatValue();

    std::vector<PhotoCraft::Point2D> pts = PhotoCraft::BrushEngine::InterpolateStroke(p0, p1, p2, p3, spacing);

    Napi::Array out = Napi::Array::New(env, pts.size());
    for (size_t i = 0; i < pts.size(); ++i) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", pts[i].x);
        pt.Set("y", pts[i].y);
        pt.Set("pressure", pts[i].pressure);
        out[i] = pt;
    }
    return out;
}

Napi::Value StabilizePointerWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return env.Null();

    Napi::Object c = info[0].As<Napi::Object>();
    Napi::Object l = info[1].As<Napi::Object>();
    float s = info[2].As<Napi::Number>().FloatValue();

    PhotoCraft::Point2D cur = {
        c.Get("x").As<Napi::Number>().FloatValue(),
        c.Get("y").As<Napi::Number>().FloatValue(),
        c.Has("pressure") ? c.Get("pressure").As<Napi::Number>().FloatValue() : 1.0f
    };
    PhotoCraft::Point2D last = {
        l.Get("x").As<Napi::Number>().FloatValue(),
        l.Get("y").As<Napi::Number>().FloatValue(),
        l.Has("pressure") ? l.Get("pressure").As<Napi::Number>().FloatValue() : 1.0f
    };

    PhotoCraft::Point2D res = PhotoCraft::BrushEngine::StabilizePointer(cur, last, s);
    Napi::Object out = Napi::Object::New(env);
    out.Set("x", res.x);
    out.Set("y", res.y);
    out.Set("pressure", res.pressure);
    return out;
}

Napi::Value BlendBuffersWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();

    Napi::Uint8Array dest = info[0].As<Napi::Uint8Array>();
    Napi::Uint8Array src = info[1].As<Napi::Uint8Array>();
    int mode = info[2].As<Napi::Number>().Int32Value();
    float opacity = info[3].As<Napi::Number>().FloatValue();

    int pixels = static_cast<int>(std::min(dest.ElementLength(), src.ElementLength()) / 4);
    PhotoCraft::PixelOps::BlendBuffers(dest.Data(), src.Data(), pixels, static_cast<PhotoCraft::BlendMode>(mode), opacity);
    return Napi::Boolean::New(env, true);
}

Napi::Value FloodFillWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 10) return Napi::Number::New(env, 0);

    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    int x = info[3].As<Napi::Number>().Int32Value();
    int y = info[4].As<Napi::Number>().Int32Value();
    uint8_t r = static_cast<uint8_t>(info[5].As<Napi::Number>().Uint32Value());
    uint8_t g = static_cast<uint8_t>(info[6].As<Napi::Number>().Uint32Value());
    uint8_t b = static_cast<uint8_t>(info[7].As<Napi::Number>().Uint32Value());
    uint8_t a = static_cast<uint8_t>(info[8].As<Napi::Number>().Uint32Value());
    int tol = info[9].As<Napi::Number>().Int32Value();

    int filled = PhotoCraft::PixelOps::FloodFill(buf.Data(), w, h, x, y, r, g, b, a, tol);
    return Napi::Number::New(env, filled);
}

// -------------------------------------------------------------
//  ADJUSTMENTS WRAPPERS (Image > Adjustments)
// -------------------------------------------------------------

Napi::Value AdjustLevelsWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 8) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int ch = info[1].As<Napi::Number>().Int32Value();
    float inB = info[2].As<Napi::Number>().FloatValue();
    float inW = info[3].As<Napi::Number>().FloatValue();
    float gamma = info[4].As<Napi::Number>().FloatValue();
    float outB = info[5].As<Napi::Number>().FloatValue();
    float outW = info[6].As<Napi::Number>().FloatValue();
    int n = static_cast<int>(buf.ElementLength() / 4);

    PhotoCraft::Adjust::Levels(buf.Data(), n, ch, inB, inW, gamma, outB, outW);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustCurvesWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int ch = info[1].As<Napi::Number>().Int32Value();
    Napi::Array xsArr = info[2].As<Napi::Array>();
    Napi::Array ysArr = info[3].As<Napi::Array>();

    std::vector<float> xs(xsArr.Length()), ys(ysArr.Length());
    for (uint32_t i = 0; i < xsArr.Length(); ++i) xs[i] = xsArr.Get(i).As<Napi::Number>().FloatValue();
    for (uint32_t i = 0; i < ysArr.Length(); ++i) ys[i] = ysArr.Get(i).As<Napi::Number>().FloatValue();

    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Curves(buf.Data(), n, ch, xs, ys);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustBrightnessContrastWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    float b = info[1].As<Napi::Number>().FloatValue();
    float c = info[2].As<Napi::Number>().FloatValue();
    int n = static_cast<int>(buf.ElementLength() / 4);

    PhotoCraft::Adjust::BrightnessContrast(buf.Data(), n, b, c);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustHueSaturationWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    float h = info[1].As<Napi::Number>().FloatValue();
    float s = info[2].As<Napi::Number>().FloatValue();
    float l = info[3].As<Napi::Number>().FloatValue();
    bool col = info[4].As<Napi::Boolean>().Value();
    int n = static_cast<int>(buf.ElementLength() / 4);

    PhotoCraft::Adjust::HueSaturation(buf.Data(), n, h, s, l, col);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustVibranceWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    float v = info[1].As<Napi::Number>().FloatValue();
    float s = info[2].As<Napi::Number>().FloatValue();
    int n = static_cast<int>(buf.ElementLength() / 4);

    PhotoCraft::Adjust::Vibrance(buf.Data(), n, v, s);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustBlackWhiteWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    Napi::Array wArr = info[1].As<Napi::Array>();
    bool tint = info[2].As<Napi::Boolean>().Value();
    float tHue = info[3].As<Napi::Number>().FloatValue();
    float tSat = info[4].As<Napi::Number>().FloatValue();

    float weights[6] = { 40, 60, 40, 60, 20, 80 };
    for (uint32_t i = 0; i < std::min(6u, wArr.Length()); ++i) weights[i] = wArr.Get(i).As<Napi::Number>().FloatValue();

    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::BlackWhite(buf.Data(), n, weights, tint, tHue, tSat);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustPhotoFilterWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    uint8_t r = static_cast<uint8_t>(info[1].As<Napi::Number>().Uint32Value());
    uint8_t g = static_cast<uint8_t>(info[2].As<Napi::Number>().Uint32Value());
    uint8_t b = static_cast<uint8_t>(info[3].As<Napi::Number>().Uint32Value());
    float density = info[4].As<Napi::Number>().FloatValue();
    bool preserveLum = info[5].As<Napi::Boolean>().Value();

    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::PhotoFilter(buf.Data(), n, r, g, b, density, preserveLum);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustExposureWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    float exp = info[1].As<Napi::Number>().FloatValue();
    float offset = info[2].As<Napi::Number>().FloatValue();
    float gamma = info[3].As<Napi::Number>().FloatValue();

    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Exposure(buf.Data(), n, exp, offset, gamma);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustColorBalanceWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    Napi::Array shArr = info[1].As<Napi::Array>();
    Napi::Array midArr = info[2].As<Napi::Array>();
    Napi::Array hlArr = info[3].As<Napi::Array>();
    bool presLum = info[4].As<Napi::Boolean>().Value();

    float sh[3] = { 0, 0, 0 }, mid[3] = { 0, 0, 0 }, hl[3] = { 0, 0, 0 };
    for (uint32_t i = 0; i < 3; ++i) {
        if (i < shArr.Length()) sh[i] = shArr.Get(i).As<Napi::Number>().FloatValue();
        if (i < midArr.Length()) mid[i] = midArr.Get(i).As<Napi::Number>().FloatValue();
        if (i < hlArr.Length()) hl[i] = hlArr.Get(i).As<Napi::Number>().FloatValue();
    }

    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::ColorBalance(buf.Data(), n, sh, mid, hl, presLum);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustInvertWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Invert(buf.Data(), n);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustPosterizeWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int levels = info[1].As<Napi::Number>().Int32Value();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Posterize(buf.Data(), n, levels);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustThresholdWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int level = info[1].As<Napi::Number>().Int32Value();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Threshold(buf.Data(), n, level);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustDesaturateWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Desaturate(buf.Data(), n);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustEqualizeWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::Equalize(buf.Data(), n);
    return Napi::Boolean::New(env, true);
}

Napi::Value AdjustAutoContrastWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    float clip = info[1].As<Napi::Number>().FloatValue();
    int n = static_cast<int>(buf.ElementLength() / 4);
    PhotoCraft::Adjust::AutoContrast(buf.Data(), n, clip);
    return Napi::Boolean::New(env, true);
}

Napi::Value GetHistogramWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int n = static_cast<int>(buf.ElementLength() / 4);

    Napi::Uint32Array out = Napi::Uint32Array::New(env, 1024);
    PhotoCraft::Adjust::Histogram(buf.Data(), n, out.Data());
    return out;
}

// -------------------------------------------------------------
//  FILTERS WRAPPERS (Filter Menu)
// -------------------------------------------------------------

Napi::Value FilterGaussianBlurWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float r = info[3].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::GaussianBlur(buf.Data(), w, h, r);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterMotionBlurWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float angle = info[3].As<Napi::Number>().FloatValue();
    float dist = info[4].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::MotionBlur(buf.Data(), w, h, angle, dist);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterRadialZoomBlurWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float cx = info[3].As<Napi::Number>().FloatValue();
    float cy = info[4].As<Napi::Number>().FloatValue();
    float amount = info[5].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::RadialZoomBlur(buf.Data(), w, h, cx, cy, amount);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterTwirlWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 7) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float cx = info[3].As<Napi::Number>().FloatValue();
    float cy = info[4].As<Napi::Number>().FloatValue();
    float radius = info[5].As<Napi::Number>().FloatValue();
    float angle = info[6].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::Twirl(buf.Data(), w, h, cx, cy, radius, angle);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterRippleWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float amp = info[3].As<Napi::Number>().FloatValue();
    float wave = info[4].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::Ripple(buf.Data(), w, h, amp, wave);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterPixelateWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    int cell = info[3].As<Napi::Number>().Int32Value();

    PhotoCraft::Filters::Pixelate(buf.Data(), w, h, cell);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterOilPaintWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    int radius = info[3].As<Napi::Number>().Int32Value();
    int levels = info[4].As<Napi::Number>().Int32Value();

    PhotoCraft::Filters::OilPaint(buf.Data(), w, h, radius, levels);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterHighPassWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    float r = info[3].As<Napi::Number>().FloatValue();

    PhotoCraft::Filters::HighPass(buf.Data(), w, h, r);
    return Napi::Boolean::New(env, true);
}

Napi::Value FilterFindEdgesWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return env.Null();
    Napi::Uint8Array buf = info[0].As<Napi::Uint8Array>();
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();

    PhotoCraft::Filters::FindEdges(buf.Data(), w, h);
    return Napi::Boolean::New(env, true);
}

// -------------------------------------------------------------
//  MODULE INIT
// -------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Brush
    exports.Set("generateBrushDab", Napi::Function::New(env, GenerateBrushDabWrapped));
    exports.Set("interpolateStroke", Napi::Function::New(env, InterpolateStrokeWrapped));
    exports.Set("stabilizePointer", Napi::Function::New(env, StabilizePointerWrapped));
    exports.Set("blendBuffers", Napi::Function::New(env, BlendBuffersWrapped));
    exports.Set("floodFill", Napi::Function::New(env, FloodFillWrapped));

    // Adjustments
    exports.Set("adjustLevels", Napi::Function::New(env, AdjustLevelsWrapped));
    exports.Set("adjustCurves", Napi::Function::New(env, AdjustCurvesWrapped));
    exports.Set("adjustBrightnessContrast", Napi::Function::New(env, AdjustBrightnessContrastWrapped));
    exports.Set("adjustHueSaturation", Napi::Function::New(env, AdjustHueSaturationWrapped));
    exports.Set("adjustVibrance", Napi::Function::New(env, AdjustVibranceWrapped));
    exports.Set("adjustBlackWhite", Napi::Function::New(env, AdjustBlackWhiteWrapped));
    exports.Set("adjustPhotoFilter", Napi::Function::New(env, AdjustPhotoFilterWrapped));
    exports.Set("adjustExposure", Napi::Function::New(env, AdjustExposureWrapped));
    exports.Set("adjustColorBalance", Napi::Function::New(env, AdjustColorBalanceWrapped));
    exports.Set("adjustInvert", Napi::Function::New(env, AdjustInvertWrapped));
    exports.Set("adjustPosterize", Napi::Function::New(env, AdjustPosterizeWrapped));
    exports.Set("adjustThreshold", Napi::Function::New(env, AdjustThresholdWrapped));
    exports.Set("adjustDesaturate", Napi::Function::New(env, AdjustDesaturateWrapped));
    exports.Set("adjustEqualize", Napi::Function::New(env, AdjustEqualizeWrapped));
    exports.Set("adjustAutoContrast", Napi::Function::New(env, AdjustAutoContrastWrapped));
    exports.Set("getHistogram", Napi::Function::New(env, GetHistogramWrapped));

    // Filters
    exports.Set("filterGaussianBlur", Napi::Function::New(env, FilterGaussianBlurWrapped));
    exports.Set("filterMotionBlur", Napi::Function::New(env, FilterMotionBlurWrapped));
    exports.Set("filterRadialBlur", Napi::Function::New(env, FilterRadialZoomBlurWrapped));
    exports.Set("filterTwirl", Napi::Function::New(env, FilterTwirlWrapped));
    exports.Set("filterRipple", Napi::Function::New(env, FilterRippleWrapped));
    exports.Set("filterPixelate", Napi::Function::New(env, FilterPixelateWrapped));
    exports.Set("filterOilPaint", Napi::Function::New(env, FilterOilPaintWrapped));
    exports.Set("filterHighPass", Napi::Function::New(env, FilterHighPassWrapped));
    exports.Set("filterFindEdges", Napi::Function::New(env, FilterFindEdgesWrapped));

    // Meta
    exports.Set("engineVersion", Napi::String::New(env, "PhotoCraft C++ Engine v2.0 (MSVC x64 Native + DelayLoad)"));
    exports.Set("isNative", Napi::Boolean::New(env, true));
    return exports;
}

NODE_API_MODULE(brush_engine_native, Init)
