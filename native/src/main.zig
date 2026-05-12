const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "gojs",
            .source = zero_native.frontend.productionSource(.{
                .dist = "dist",
                .entry = "index.html",
            }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return zero_native.frontend.sourceFromEnv(self.env_map, .{
            .dist = "dist",
            .entry = "index.html",
        });
    }
};

const allowed_origins = [_][]const u8{
    "zero://app",
    "http://127.0.0.1:5555",
};

const external_urls = [_][]const u8{
    "https://github.com/midudev/gojs-issues/*",
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "GoJS.app",
        .window_title = "GoJS.app",
        .bundle_id = "app.gojs.desktop",
        .security = .{
            .navigation = .{
                .allowed_origins = &allowed_origins,
                .external_links = .{
                    .action = .open_system_browser,
                    .allowed_urls = &external_urls,
                },
            },
        },
    }, init);
}

test "production source points at the Vite build output" {
    const source = zero_native.frontend.productionSource(.{
        .dist = "dist",
        .entry = "index.html",
    });
    try std.testing.expectEqual(zero_native.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings("dist", source.asset_options.?.root_path);
    try std.testing.expectEqualStrings("index.html", source.asset_options.?.entry);
}
