// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Breadcrumb",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "BreadcrumbCore", targets: ["BreadcrumbCore"]),
        .library(name: "BreadcrumbCaptureSupport", targets: ["BreadcrumbCaptureSupport"]),
        .executable(name: "BreadcrumbCapture", targets: ["BreadcrumbCapture"]),
        .executable(name: "Breadcrumb", targets: ["Breadcrumb"])
    ],
    targets: [
        .target(name: "BreadcrumbCore"),
        .target(name: "BreadcrumbCaptureSupport", dependencies: ["BreadcrumbCore"]),
        .executableTarget(name: "BreadcrumbCapture", dependencies: ["BreadcrumbCore", "BreadcrumbCaptureSupport"]),
        .executableTarget(name: "Breadcrumb", dependencies: ["BreadcrumbCore", "BreadcrumbCaptureSupport"]),
        .testTarget(name: "BreadcrumbCoreTests", dependencies: ["BreadcrumbCore"])
    ],
    swiftLanguageModes: [.v5]
)
