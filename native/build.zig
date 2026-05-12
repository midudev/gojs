const std = @import("std");

const PlatformOption = enum {
    auto,
    null,
    macos,
};

const TraceOption = enum {
    off,
    events,
    runtime,
    all,
};

const WebEngineOption = enum {
    system,
    chromium,
};

const default_zero_native_path = "../node_modules/zero-native";
const app_exe_name = "gojs";
const app_version = "0.1.0";

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const platform_option = b.option(PlatformOption, "platform", "Desktop backend: auto, null, macos") orelse .auto;
    const trace_option = b.option(TraceOption, "trace", "Trace output: off, events, runtime, all") orelse .events;
    const debug_overlay = b.option(bool, "debug-overlay", "Enable debug overlay output") orelse false;
    const automation_enabled = b.option(bool, "automation", "Enable zero-native automation artifacts") orelse false;
    const js_bridge_enabled = b.option(bool, "js-bridge", "Enable optional JavaScript bridge stubs") orelse false;
    const web_engine_override = b.option(WebEngineOption, "web-engine", "Override app.zon web engine: system, chromium");
    const cef_dir_override = b.option([]const u8, "cef-dir", "Override CEF root directory for Chromium builds");
    const cef_auto_install_override = b.option(bool, "cef-auto-install", "Override app.zon CEF auto-install setting");
    const zero_native_path = b.option([]const u8, "zero-native-path", "Path to the zero-native package") orelse default_zero_native_path;
    const optimize_name = @tagName(optimize);

    const selected_platform: PlatformOption = switch (platform_option) {
        .auto => if (target.result.os.tag == .macos) .macos else .null,
        else => platform_option,
    };
    if (selected_platform == .macos and target.result.os.tag != .macos) {
        @panic("-Dplatform=macos requires a macOS target");
    }

    const app_web_engine = appWebEngineConfig();
    const web_engine = web_engine_override orelse app_web_engine.web_engine;
    const cef_dir = cef_dir_override orelse app_web_engine.cef_dir;
    const cef_auto_install = cef_auto_install_override orelse app_web_engine.cef_auto_install;
    if (web_engine == .chromium and selected_platform == .null) {
        @panic("-Dweb-engine=chromium requires -Dplatform=macos");
    }

    const zero_native_mod = zeroNativeModule(b, target, optimize, zero_native_path);
    const options = b.addOptions();
    options.addOption([]const u8, "platform", switch (selected_platform) {
        .auto => unreachable,
        .null => "null",
        .macos => "macos",
    });
    options.addOption([]const u8, "trace", @tagName(trace_option));
    options.addOption([]const u8, "web_engine", @tagName(web_engine));
    options.addOption(bool, "debug_overlay", debug_overlay);
    options.addOption(bool, "automation", automation_enabled);
    options.addOption(bool, "js_bridge", js_bridge_enabled);
    const options_mod = options.createModule();

    const runner_mod = localModule(b, target, optimize, "src/runner.zig");
    runner_mod.addImport("zero-native", zero_native_mod);
    runner_mod.addImport("build_options", options_mod);

    const app_mod = localModule(b, target, optimize, "src/main.zig");
    app_mod.addImport("zero-native", zero_native_mod);
    app_mod.addImport("runner", runner_mod);

    const exe = b.addExecutable(.{
        .name = app_exe_name,
        .root_module = app_mod,
    });
    linkPlatform(b, target, app_mod, exe, selected_platform, web_engine, zero_native_path, cef_dir, cef_auto_install);
    b.installArtifact(exe);

    const frontend_install = b.addSystemCommand(&.{ "pnpm", "--dir", "..", "install", "--frozen-lockfile" });
    const frontend_install_step = b.step("frontend-install", "Install root frontend dependencies with pnpm");
    frontend_install_step.dependOn(&frontend_install.step);

    const root_frontend_build = b.addSystemCommand(&.{ "pnpm", "--dir", "..", "build" });
    root_frontend_build.step.dependOn(&frontend_install.step);
    const frontend_build = b.addSystemCommand(&.{
        "sh",                                "-c",
        "rm -rf dist && cp -R ../dist dist",
    });
    frontend_build.step.dependOn(&root_frontend_build.step);
    const frontend_step = b.step("frontend-build", "Build the Vite frontend");
    frontend_step.dependOn(&frontend_build.step);

    const cef_install = b.addSystemCommand(&.{ "pnpm", "exec", "zero-native", "cef", "install", "--dir", cef_dir });
    const cef_install_step = b.step("cef-install", "Install the pinned CEF runtime for macOS");
    cef_install_step.dependOn(&cef_install.step);

    const run = b.addRunArtifact(exe);
    run.step.dependOn(&frontend_build.step);
    addCefRuntimeRunFiles(b, target, run, exe, web_engine, cef_dir);
    const run_step = b.step("run", "Run the app against built Vite assets");
    run_step.dependOn(&run.step);

    const dev = b.addSystemCommand(&.{ "pnpm", "exec", "zero-native", "dev", "--manifest", "app.zon", "--binary" });
    dev.addFileArg(exe.getEmittedBin());
    dev.step.dependOn(&exe.step);
    dev.step.dependOn(&frontend_install.step);
    const dev_step = b.step("dev", "Run the Vite dev server and native shell");
    dev_step.dependOn(&dev.step);

    const validate = b.addSystemCommand(&.{ "pnpm", "exec", "zero-native", "validate", "app.zon" });
    const validate_step = b.step("validate-manifest", "Validate app.zon");
    validate_step.dependOn(&validate.step);

    const doctor = b.addSystemCommand(&.{ "pnpm", "exec", "zero-native", "doctor", "--manifest", "app.zon", "--strict" });
    const doctor_step = b.step("doctor", "Check zero-native environment and manifest");
    doctor_step.dependOn(&doctor.step);

    const package = b.addSystemCommand(&.{
        "pnpm",
        "exec",
        "zero-native",
        "package",
        "--target",
        "macos",
        "--manifest",
        "app.zon",
        "--assets",
        "dist",
        "--optimize",
        optimize_name,
        "--output",
        b.fmt("zig-out/package/{s}-{s}-macos-{s}.app", .{ app_exe_name, app_version, optimize_name }),
        "--binary",
    });
    package.addFileArg(exe.getEmittedBin());
    package.addArgs(&.{ "--web-engine", @tagName(web_engine), "--cef-dir", cef_dir });
    if (cef_auto_install) package.addArg("--cef-auto-install");
    package.step.dependOn(&exe.step);
    package.step.dependOn(&frontend_build.step);
    const package_step = b.step("package", "Create a local macOS .app artifact");
    package_step.dependOn(&package.step);

    const tests = b.addTest(.{ .root_module = app_mod });
    const test_step = b.step("test", "Run Zig tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}

fn localModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    path: []const u8,
) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(path),
        .target = target,
        .optimize = optimize,
    });
}

fn zeroNativePath(b: *std.Build, zero_native_path: []const u8, sub_path: []const u8) std.Build.LazyPath {
    return .{ .cwd_relative = b.pathJoin(&.{ zero_native_path, sub_path }) };
}

fn zeroNativeModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    zero_native_path: []const u8,
) *std.Build.Module {
    const geometry_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/geometry/root.zig");
    const assets_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/assets/root.zig");
    const app_dirs_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/app_dirs/root.zig");
    const trace_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/trace/root.zig");
    const app_manifest_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/app_manifest/root.zig");
    const diagnostics_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/diagnostics/root.zig");
    const platform_info_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/platform_info/root.zig");
    const json_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/json/root.zig");
    const debug_mod = externalModule(b, target, optimize, zero_native_path, "src/debug/root.zig");
    debug_mod.addImport("app_dirs", app_dirs_mod);
    debug_mod.addImport("trace", trace_mod);

    const zero_native_mod = externalModule(b, target, optimize, zero_native_path, "src/root.zig");
    zero_native_mod.addImport("geometry", geometry_mod);
    zero_native_mod.addImport("assets", assets_mod);
    zero_native_mod.addImport("app_dirs", app_dirs_mod);
    zero_native_mod.addImport("trace", trace_mod);
    zero_native_mod.addImport("app_manifest", app_manifest_mod);
    zero_native_mod.addImport("diagnostics", diagnostics_mod);
    zero_native_mod.addImport("platform_info", platform_info_mod);
    zero_native_mod.addImport("json", json_mod);
    return zero_native_mod;
}

fn externalModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    zero_native_path: []const u8,
    path: []const u8,
) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = zeroNativePath(b, zero_native_path, path),
        .target = target,
        .optimize = optimize,
    });
}

fn linkPlatform(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    app_mod: *std.Build.Module,
    exe: *std.Build.Step.Compile,
    platform: PlatformOption,
    web_engine: WebEngineOption,
    zero_native_path: []const u8,
    cef_dir: []const u8,
    cef_auto_install: bool,
) void {
    if (platform != .macos) return;

    switch (web_engine) {
        .system => {
            app_mod.addCSourceFile(.{
                .file = zeroNativePath(b, zero_native_path, "src/platform/macos/appkit_host.m"),
                .flags = &.{ "-fobjc-arc", "-ObjC" },
            });
            app_mod.linkFramework("WebKit", .{});
        },
        .chromium => {
            const cef_check = addCefCheck(b, target, cef_dir);
            if (cef_auto_install) {
                const cef_auto = b.addSystemCommand(&.{ "pnpm", "exec", "zero-native", "cef", "install", "--dir", cef_dir });
                cef_check.step.dependOn(&cef_auto.step);
            }
            exe.step.dependOn(&cef_check.step);
            const include_arg = b.fmt("-I{s}", .{cef_dir});
            const define_arg = b.fmt("-DZERO_NATIVE_CEF_DIR=\"{s}\"", .{cef_dir});
            app_mod.addCSourceFile(.{
                .file = zeroNativePath(b, zero_native_path, "src/platform/macos/cef_host.mm"),
                .flags = &.{ "-fobjc-arc", "-ObjC++", "-std=c++17", "-stdlib=libc++", include_arg, define_arg },
            });
            app_mod.addObjectFile(b.path(b.fmt("{s}/libcef_dll_wrapper/libcef_dll_wrapper.a", .{cef_dir})));
            app_mod.addFrameworkPath(b.path(b.fmt("{s}/Release", .{cef_dir})));
            app_mod.linkFramework("Chromium Embedded Framework", .{});
            app_mod.addRPath(.{ .cwd_relative = "@executable_path/Frameworks" });
        },
    }

    app_mod.linkFramework("AppKit", .{});
    app_mod.linkFramework("Foundation", .{});
    app_mod.linkFramework("UniformTypeIdentifiers", .{});
    app_mod.linkSystemLibrary("c", .{});
    if (web_engine == .chromium) app_mod.linkSystemLibrary("c++", .{});
}

fn addCefRuntimeRunFiles(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    run: *std.Build.Step.Run,
    exe: *std.Build.Step.Compile,
    web_engine: WebEngineOption,
    cef_dir: []const u8,
) void {
    if (web_engine != .chromium) return;
    if (target.result.os.tag != .macos) return;
    const copy = b.addSystemCommand(&.{
        "sh", "-c",
        b.fmt(
            \\set -e
            \\exe="$0"
            \\exe_dir="$(dirname "$exe")"
            \\rm -rf "zig-out/Frameworks/Chromium Embedded Framework.framework" "zig-out/bin/Frameworks/Chromium Embedded Framework.framework" ".zig-cache/o/Frameworks/Chromium Embedded Framework.framework" &&
            \\mkdir -p "zig-out/Frameworks" "zig-out/bin/Frameworks" ".zig-cache/o/Frameworks" "$exe_dir" &&
            \\cp -R "{s}/Release/Chromium Embedded Framework.framework" "zig-out/Frameworks/" &&
            \\cp -R "{s}/Release/Chromium Embedded Framework.framework" "zig-out/bin/Frameworks/" &&
            \\cp -R "{s}/Release/Chromium Embedded Framework.framework" ".zig-cache/o/Frameworks/" &&
            \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libEGL.dylib" "$exe_dir/" &&
            \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libGLESv2.dylib" "$exe_dir/" &&
            \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/libvk_swiftshader.dylib" "$exe_dir/" &&
            \\cp "{s}/Release/Chromium Embedded Framework.framework/Libraries/vk_swiftshader_icd.json" "$exe_dir/"
        , .{ cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir }),
    });
    copy.addFileArg(exe.getEmittedBin());
    run.step.dependOn(&copy.step);
}

fn addCefCheck(b: *std.Build, target: std.Build.ResolvedTarget, cef_dir: []const u8) *std.Build.Step.Run {
    const script = switch (target.result.os.tag) {
        .macos => b.fmt(
            \\test -f "{s}/include/cef_app.h" &&
            \\test -d "{s}/Release/Chromium Embedded Framework.framework" &&
            \\test -f "{s}/libcef_dll_wrapper/libcef_dll_wrapper.a" || {{
            \\  echo "missing CEF dependency for -Dweb-engine=chromium" >&2
            \\  echo "Expected:" >&2
            \\  echo "  {s}/include/cef_app.h" >&2
            \\  echo "  {s}/Release/Chromium Embedded Framework.framework" >&2
            \\  echo "  {s}/libcef_dll_wrapper/libcef_dll_wrapper.a" >&2
            \\  echo "Fix with: zig build cef-install" >&2
            \\  echo "Or rerun with: -Dcef-auto-install=true" >&2
            \\  echo "Pass -Dcef-dir=/path/to/cef if your bundle lives elsewhere." >&2
            \\  exit 1
            \\}}
        , .{ cef_dir, cef_dir, cef_dir, cef_dir, cef_dir, cef_dir }),
        else => "echo unsupported CEF target >&2; exit 1",
    };
    return b.addSystemCommand(&.{ "sh", "-c", script });
}

const AppWebEngineConfig = struct {
    web_engine: WebEngineOption = .system,
    cef_dir: []const u8 = "third_party/cef/macos",
    cef_auto_install: bool = false,
};

fn appWebEngineConfig() AppWebEngineConfig {
    const source = @embedFile("app.zon");
    var config: AppWebEngineConfig = .{};
    if (stringField(source, ".web_engine")) |value| {
        config.web_engine = parseWebEngine(value) orelse .system;
    }
    if (objectSection(source, ".cef")) |cef| {
        if (stringField(cef, ".dir")) |value| config.cef_dir = value;
        if (boolField(cef, ".auto_install")) |value| config.cef_auto_install = value;
    }
    return config;
}

fn parseWebEngine(value: []const u8) ?WebEngineOption {
    if (std.mem.eql(u8, value, "system")) return .system;
    if (std.mem.eql(u8, value, "chromium")) return .chromium;
    return null;
}

fn stringField(source: []const u8, field: []const u8) ?[]const u8 {
    const field_index = std.mem.indexOf(u8, source, field) orelse return null;
    const equals = std.mem.indexOfScalarPos(u8, source, field_index, '=') orelse return null;
    const start_quote = std.mem.indexOfScalarPos(u8, source, equals, '"') orelse return null;
    const end_quote = std.mem.indexOfScalarPos(u8, source, start_quote + 1, '"') orelse return null;
    return source[start_quote + 1 .. end_quote];
}

fn objectSection(source: []const u8, field: []const u8) ?[]const u8 {
    const field_index = std.mem.indexOf(u8, source, field) orelse return null;
    const open = std.mem.indexOfScalarPos(u8, source, field_index, '{') orelse return null;
    var depth: usize = 0;
    var index = open;
    while (index < source.len) : (index += 1) {
        switch (source[index]) {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if (depth == 0) return source[open + 1 .. index];
            },
            else => {},
        }
    }
    return null;
}

fn boolField(source: []const u8, field: []const u8) ?bool {
    const field_index = std.mem.indexOf(u8, source, field) orelse return null;
    const equals = std.mem.indexOfScalarPos(u8, source, field_index, '=') orelse return null;
    var index = equals + 1;
    while (index < source.len and std.ascii.isWhitespace(source[index])) : (index += 1) {}
    if (std.mem.startsWith(u8, source[index..], "true")) return true;
    if (std.mem.startsWith(u8, source[index..], "false")) return false;
    return null;
}
