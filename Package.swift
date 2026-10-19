// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Deck",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Deck", targets: ["Deck"])
    ],
    targets: [
        .target(
            name: "DeckCore",
            path: "Sources/DeckCore"
        ),
        .executableTarget(
            name: "Deck",
            dependencies: ["DeckCore"],
            path: "Sources/Deck",
            resources: [.copy("Resources/web")],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("AVKit")
            ]
        ),
        .testTarget(
            name: "DeckCoreTests",
            dependencies: ["DeckCore"],
            path: "Tests/DeckCoreTests"
        )
    ],
    swiftLanguageModes: [.v5]
)
