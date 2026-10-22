// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClaudeCodeBot",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ClaudeCodeBot", targets: ["ClaudeCodeBot"])
    ],
    targets: [
        .target(
            name: "ClaudeCodeBotCore",
            path: "Sources/ClaudeCodeBotCore"
        ),
        .executableTarget(
            name: "ClaudeCodeBot",
            dependencies: ["ClaudeCodeBotCore"],
            path: "Sources/ClaudeCodeBot",
            resources: [.copy("Resources/web"), .copy("Resources/plugins"), .copy("Resources/host"), .copy("Resources/web-extractors"), .copy("Resources/web-laas")],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("AVKit")
            ]
        ),
        .testTarget(
            name: "ClaudeCodeBotCoreTests",
            dependencies: ["ClaudeCodeBotCore"],
            path: "Tests/ClaudeCodeBotCoreTests"
        )
    ],
    swiftLanguageModes: [.v5]
)
