{
  "targets": [
    {
      "target_name": "brush_engine_native",
      "sources": [
        "native/binding.cpp",
        "native/brush_engine.cpp",
        "native/pixel_ops.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "/std:c++17", "/O2", "/Oi", "/fp:fast" ]
        }
      },
      "defines": [ "NAPI_CPP_EXCEPTIONS" ]
    }
  ]
}
