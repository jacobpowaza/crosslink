// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Crosslink",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "Crosslink", targets: ["Crosslink"])],
    targets: [
        .target(name: "Crosslink"),
        .testTarget(name: "CrosslinkTests", dependencies: ["Crosslink"])
    ]
)
