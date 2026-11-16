// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Breadcrumb",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "BreadcrumbCore", targets: ["BreadcrumbCore"]),
        .executable(name: "Breadcrumb", targets: ["Breadcrumb"])
    ],
    targets: [
        .target(name: "BreadcrumbCore"),
        .executableTarget(name: "Breadcrumb", dependencies: ["BreadcrumbCore"]),
        .testTarget(name: "BreadcrumbCoreTests", dependencies: ["BreadcrumbCore"])
    ],
    swiftLanguageModes: [.v5]
)
