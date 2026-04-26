cmake_minimum_required(VERSION 3.22.1)

project("dtxmania_quest_audio" CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Single shared library exposing AAudio + sample-bank entry points
# through JNI. Shipped only for arm64-v8a (Quest 3); see
# `app/build.gradle.kts` `ndk.abiFilters`.
add_library(dtxmania_quest_audio SHARED
    aaudio_engine.cpp
    jni_bindings.cpp
)

target_include_directories(dtxmania_quest_audio
    PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Standard NDK libraries we link against.
find_library(log-lib log)
find_library(aaudio-lib aaudio)
find_library(android-lib android)

target_link_libraries(dtxmania_quest_audio
    ${log-lib}
    ${aaudio-lib}
    ${android-lib}
)

# Strip release builds to keep the APK lean. Debug builds stay symbol-
# rich for ndk-stack to symbolicate native crash traces from logcat.
target_compile_options(dtxmania_quest_audio
    PRIVATE
    $<$<CONFIG:Release>:-O2 -fvisibility=hidden>
    $<$<CONFIG:Debug>:-O0 -g>
)
