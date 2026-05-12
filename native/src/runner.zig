const std = @import("std");
const build_options = @import("build_options");
const zero_native = @import("zero-native");

pub const StdoutTraceSink = struct {
    pub fn sink(self: *StdoutTraceSink) zero_native.trace.Sink {
        return .{ .context = self, .write_fn = write };
    }

    fn write(context: *anyopaque, record: zero_native.trace.Record) zero_native.trace.WriteError!void {
        _ = context;
        if (!shouldTrace(record)) return;
        var buffer: [1024]u8 = undefined;
        var writer = std.Io.Writer.fixed(&buffer);
        zero_native.trace.formatText(record, &writer) catch return error.OutOfSpace;
        std.debug.print("{s}\n", .{writer.buffered()});
    }
};

pub const RunOptions = struct {
    app_name: []const u8,
    window_title: []const u8 = "",
    bundle_id: []const u8,
    icon_path: []const u8 = "",
    window_size: zero_native.geometry.SizeF = zero_native.geometry.SizeF.init(1280, 820),
    bridge: ?zero_native.BridgeDispatcher = null,
    builtin_bridge: zero_native.BridgePolicy = .{},
    security: zero_native.SecurityPolicy = .{},

    fn appInfo(self: RunOptions) zero_native.AppInfo {
        return .{
            .app_name = self.app_name,
            .window_title = self.window_title,
            .bundle_id = self.bundle_id,
            .icon_path = self.icon_path,
        };
    }
};

pub fn runWithOptions(app: zero_native.App, options: RunOptions, init: std.process.Init) !void {
    if (build_options.debug_overlay) {
        std.debug.print("debug-overlay=true backend={s} web-engine={s} trace={s}\n", .{
            build_options.platform,
            build_options.web_engine,
            build_options.trace,
        });
    }

    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        try runMacos(app, options, init);
    } else {
        try runNull(app, options, init);
    }
}

fn runNull(app: zero_native.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var runtime_buffers: RuntimeBuffers = .{};
    var app_info = options.appInfo();
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var null_platform = zero_native.NullPlatform.initWithOptions(.{}, webEngine(), app_info);
    var runtime = runtimeWithPlatform(null_platform.platform(), app_info, options, init, store, &runtime_buffers);

    try runtime.run(app);
}

fn runMacos(app: zero_native.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var runtime_buffers: RuntimeBuffers = .{};
    var app_info = options.appInfo();
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var mac_platform = try zero_native.platform.macos.MacPlatform.initWithOptions(options.window_size, webEngine(), app_info);
    defer mac_platform.deinit();
    var runtime = runtimeWithPlatform(mac_platform.platform(), app_info, options, init, store, &runtime_buffers);

    try runtime.run(app);
}

fn runtimeWithPlatform(
    platform: zero_native.Platform,
    app_info: zero_native.AppInfo,
    options: RunOptions,
    init: std.process.Init,
    store: ?zero_native.window_state.Store,
    buffers: *RuntimeBuffers,
) zero_native.Runtime {
    const log_setup = zero_native.debug.setupLogging(init.io, init.environ_map, app_info.bundle_id, &buffers.log_paths) catch null;
    if (log_setup) |setup| zero_native.debug.installPanicCapture(init.io, setup.paths);

    var runtime_trace_sink = buffers.stdout_trace.sink();

    if (log_setup) |setup| {
        buffers.file_trace = zero_native.debug.FileTraceSink.init(init.io, setup.paths.log_dir, setup.paths.log_file, setup.format);
        buffers.fanout_sinks = .{ buffers.stdout_trace.sink(), buffers.file_trace.sink() };
        buffers.fanout = .{ .sinks = &buffers.fanout_sinks };
        runtime_trace_sink = buffers.fanout.sink();
    }

    return zero_native.Runtime.init(.{
        .platform = platform,
        .trace_sink = runtime_trace_sink,
        .log_path = if (log_setup) |setup| setup.paths.log_file else null,
        .bridge = options.bridge,
        .builtin_bridge = options.builtin_bridge,
        .security = options.security,
        .automation = if (build_options.automation) zero_native.automation.Server.init(init.io, ".zig-cache/zero-native-automation", app_info.resolvedWindowTitle()) else null,
        .window_state_store = store,
    });
}

fn shouldTrace(record: zero_native.trace.Record) bool {
    if (comptime std.mem.eql(u8, build_options.trace, "off")) return false;
    if (comptime std.mem.eql(u8, build_options.trace, "all")) return true;
    if (comptime std.mem.eql(u8, build_options.trace, "events")) return true;
    return std.mem.indexOf(u8, record.name, build_options.trace) != null;
}

fn webEngine() zero_native.WebEngine {
    if (comptime std.mem.eql(u8, build_options.web_engine, "chromium")) return .chromium;
    return .system;
}

const StateBuffers = struct {
    state_dir: [1024]u8 = undefined,
    file_path: [1200]u8 = undefined,
    read: [8192]u8 = undefined,
    restored_windows: [zero_native.platform.max_windows]zero_native.WindowOptions = undefined,
};

const RuntimeBuffers = struct {
    stdout_trace: StdoutTraceSink = .{},
    log_paths: zero_native.debug.LogPathBuffers = .{},
    file_trace: zero_native.debug.FileTraceSink = undefined,
    fanout_sinks: [2]zero_native.trace.Sink = undefined,
    fanout: zero_native.debug.FanoutTraceSink = undefined,
};

fn prepareStateStore(
    io: std.Io,
    env_map: *std.process.Environ.Map,
    app_info: *zero_native.AppInfo,
    buffers: *StateBuffers,
) ?zero_native.window_state.Store {
    const paths = zero_native.window_state.defaultPaths(
        &buffers.state_dir,
        &buffers.file_path,
        app_info.bundle_id,
        zero_native.debug.envFromMap(env_map),
    ) catch return null;
    const store = zero_native.window_state.Store.init(io, paths.state_dir, paths.file_path);
    if (app_info.main_window.restore_state) {
        if (store.loadWindow(app_info.main_window.label, &buffers.read) catch null) |saved| {
            app_info.main_window.default_frame = saved.frame;
        }
    }
    return store;
}
